#!/usr/bin/env python3
"""
실시간 STT WebSocket 서버 — StreamingAsrProvider/FunAsrProvider의 온프레미스 백엔드.

프로토콜 (src/providers/StreamingAsrProvider.ts 와 합의):
  클라이언트 → 서버
    - 텍스트 프레임: {"type":"start","sampleRate":16000,"language":"ko-KR"}  (핸드셰이크)
                     {"type":"stop"}                                          (종료 신호 → 최종 결과 요청)
    - 바이너리 프레임: 16kHz mono Int16 LE PCM 청크
  서버 → 클라이언트
    - {"text":"...","isFinal":false}  부분(진행 중) 결과
    - {"text":"...","isFinal":true}   발화 확정 결과 (무음 경계/stop 시)

엔진:
  faster-whisper : 발화 버퍼를 주기 재전사해 partial, RMS 무음 경계에서 final. (ko/en/ja/zh …)
  funasr         : paraformer-zh-streaming 증분 디코딩(진짜 스트리밍). (zh 전용)
  sensevoice     : SenseVoiceSmall 재전사 방식 — 호출당 고정비용 ≈1s(CPU)라 partial 주기 1.2s. (ko/ja/en/zh/yue)

사용:
  python3 realtime_asr_server.py --engine faster-whisper --model base --port 8765
  python3 realtime_asr_server.py --engine funasr --port 8766
  python3 realtime_asr_server.py --engine sensevoice --port 8767

모델은 최초 1회 server/models/ 아래로 내려받아 자체 관리한다(이후 오프라인 동작).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

log = logging.getLogger("asr")

# 추론은 단일 워커에서 직렬 실행한다. partial 재전사와 finalize가 동시에 돌면
# 같은 torch 스레드 풀을 서로 빼앗아 호출당 지연이 3배 이상 늘어난다(실측).
INFER_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="asr-infer")

SAMPLE_RATE = 16000
MODELS_DIR = Path(__file__).parent / "models"
# FunASR(modelscope) 모델도 server/models/ 아래로 받아 자체 관리한다
os.environ.setdefault("MODELSCOPE_CACHE", str(MODELS_DIR / "funasr"))

# RMS 기반 무음 판정 — captureStream/마이크 무레벨 구간 감지용
SILENCE_RMS = 0.008
SILENCE_FINALIZE_SEC = 0.9  # 이만큼 무음이 이어지면 발화 확정
PARTIAL_INTERVAL_SEC = 0.6  # partial 재전사 기본 주기 — 엔진이 PARTIAL_INTERVAL_SEC로 재정의 가능
MAX_UTTERANCE_SEC = 25.0    # 무음이 없어도 이 길이에서 강제 확정


def rms(pcm: np.ndarray) -> float:
    return float(np.sqrt(np.mean(pcm * pcm))) if len(pcm) else 0.0


# ── 엔진 어댑터 ─────────────────────────────────────────────────────────
class FasterWhisperEngine:
    """발화 버퍼 재전사 방식 — partial은 현재 발화 전체를 다시 전사한 스냅샷."""

    def __init__(self, model_size: str):
        from faster_whisper import WhisperModel

        log.info("faster-whisper 모델 로드: %s", model_size)
        self.model = WhisperModel(
            model_size,
            device="cpu",
            compute_type="int8",
            download_root=str(MODELS_DIR / "faster-whisper"),
        )
        log.info("모델 준비 완료")

    def transcribe(self, pcm: np.ndarray, lang: str | None) -> str:
        segments, _info = self.model.transcribe(
            pcm,
            language=lang,
            beam_size=1,
            condition_on_previous_text=False,
            without_timestamps=True,
        )
        return "".join(s.text for s in segments).strip()


class SenseVoiceEngine:
    """
    SenseVoiceSmall — 다국어(ko/ja/en/zh/yue) offline 모델. 스트리밍 API가 없어
    faster-whisper와 같은 발화 버퍼 재전사 방식을 쓴다.

    비자기회귀라 오디오 길이에는 둔감하지만 호출 1회의 고정 비용이 크다 —
    이 환경(8코어 CPU, ncpu=4) 실측으로 입력 0.25s/0.75s/1.6s 모두 ≈1.0s.
    그래서 partial 주기를 1.2s로 두고(PARTIAL_INTERVAL_SEC) 추론은 직렬화한다.
    ncpu를 8로 올리면 효율코어까지 쓰며 오히려 1.7s로 느려졌다 → 기본 4 유지.
    """

    PARTIAL_INTERVAL_SEC = 1.2

    def __init__(self, model_name: str, ncpu: int):
        from funasr import AutoModel
        from funasr.utils.postprocess_utils import emo_set, event_set, rich_transcription_postprocess

        self._post = rich_transcription_postprocess
        # 공식 후처리는 감정/이벤트 태그를 이모지로 바꿔 남긴다(😊 🎼 …) — 자막에는 불필요하므로 제거
        self._tag_emoji = emo_set | event_set | {"❓"}
        log.info("SenseVoice 모델 로드: %s (ncpu=%d)", model_name, ncpu)
        self.model = AutoModel(model=model_name, disable_update=True, hub="ms", device="cpu", ncpu=ncpu)
        log.info("모델 준비 완료")

    def transcribe(self, pcm: np.ndarray, lang: str | None) -> str:
        # language 미지원 코드는 모델이 auto(0)로 취급한다 — zh/en/yue/ja/ko 외엔 자동 판별
        res = self.model.generate(
            input=pcm, cache={}, language=lang or "auto", use_itn=True, disable_pbar=True
        )
        if not res:
            return ""
        # 출력에 <|ko|><|NEUTRAL|><|Speech|><|withitn|> 등 태그가 붙어 온다 → 공식 후처리로 정규화
        text = self._post(res[0]["text"])
        for emoji in self._tag_emoji:
            text = text.replace(emoji, "")
        return text.strip()

    def warmup(self) -> None:
        # 첫 호출만 그래프 초기화로 3배 느리다(실측 3.2s) — 무음으로 미리 태워 첫 발화 지연을 없앤다
        self.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32), None)


class FunAsrEngine:
    """paraformer-zh-streaming 증분 디코딩 — 600ms 청크마다 텍스트 조각을 누적."""

    CHUNK_SIZE = [0, 10, 5]  # 600ms 스트리밍 설정 (10*60ms)
    CHUNK_SAMPLES = 9600     # 600ms @16k

    def __init__(self, model_name: str):
        from funasr import AutoModel

        log.info("FunASR 모델 로드: %s", model_name)
        self.model = AutoModel(
            model=model_name,
            disable_update=True,
            hub="ms",
        )
        log.info("모델 준비 완료")

    def new_stream(self) -> dict:
        return {"cache": {}, "text": ""}

    def feed(self, state: dict, chunk: np.ndarray, is_final: bool) -> str:
        res = self.model.generate(
            input=chunk,
            cache=state["cache"],
            is_final=is_final,
            chunk_size=self.CHUNK_SIZE,
            encoder_chunk_look_back=4,
            decoder_chunk_look_back=1,
        )
        piece = res[0]["text"] if res else ""
        if piece:
            state["text"] += piece
        return state["text"]


# ── 세션 (접속 1개 = 발화 스트림 1개) ────────────────────────────────────
class Session:
    def __init__(self, ws, engine, engine_kind: str, loop):
        self.ws = ws
        self.engine = engine
        self.kind = engine_kind
        self.loop = loop
        self.lang: str | None = None
        self.buf = np.zeros(0, dtype=np.float32)   # 현재 발화 버퍼(faster-whisper)
        self.silence_sec = 0.0
        self.had_speech = False
        self.last_partial = ""
        self.fun_state = engine.new_stream() if engine_kind == "funasr" else None
        self.fun_pending = np.zeros(0, dtype=np.float32)
        # 엔진이 자기 추론 비용에 맞는 주기를 선언하면 그걸 쓴다(SenseVoice=1.2s)
        self.partial_interval = getattr(engine, "PARTIAL_INTERVAL_SEC", PARTIAL_INTERVAL_SEC)
        # 이 세션의 추론이 진행 중인지 — partial_loop이 locked()로 보고 그 주기를 건너뛴다.
        # 플래그가 아니라 Lock이어야 한다: partial과 finalize가 겹칠 때 먼저 끝난 쪽이
        # 플래그를 내려 "진행 중 아님"으로 오판하는 창이 생긴다.
        self.infer_lock = asyncio.Lock()

    async def infer(self, fn, *args):
        """추론을 전역 단일 워커에 위임한다 — 동시 실행 시 스레드 경쟁으로 되레 느려진다."""
        async with self.infer_lock:
            return await self.loop.run_in_executor(INFER_POOL, fn, *args)

    async def send(self, text: str, is_final: bool):
        if not text and not is_final:
            return
        try:
            await self.ws.send(json.dumps({"text": text, "isFinal": is_final}, ensure_ascii=False))
        except Exception:
            # 처리 백로그 중 클라이언트가 먼저 끊은 경우 — 늦은 결과는 버리고 핸들러는 살린다
            pass

    # 바이너리 PCM 프레임 수신
    async def on_pcm(self, data: bytes):
        pcm = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
        frame_sec = len(pcm) / SAMPLE_RATE
        voiced = rms(pcm) >= SILENCE_RMS
        self.silence_sec = 0.0 if voiced else self.silence_sec + frame_sec
        self.had_speech = self.had_speech or voiced

        if self.kind == "funasr":
            await self.on_pcm_funasr(pcm)
            return

        # faster-whisper: 발화 중이면 버퍼 누적, 무음 경계에서 확정
        if self.had_speech:
            self.buf = np.concatenate([self.buf, pcm])
        if self.had_speech and (
            self.silence_sec >= SILENCE_FINALIZE_SEC or len(self.buf) >= SAMPLE_RATE * MAX_UTTERANCE_SEC
        ):
            await self.finalize()

    async def on_pcm_funasr(self, pcm: np.ndarray):
        self.fun_pending = np.concatenate([self.fun_pending, pcm])
        n = FunAsrEngine.CHUNK_SAMPLES
        while len(self.fun_pending) >= n:
            chunk, self.fun_pending = self.fun_pending[:n], self.fun_pending[n:]
            text = await self.infer(self.engine.feed, self.fun_state, chunk, False)
            if text and text != self.last_partial:
                self.last_partial = text
                await self.send(text, False)
        if self.had_speech and self.silence_sec >= SILENCE_FINALIZE_SEC:
            await self.finalize()

    # 주기 partial (재전사 엔진 전용 — 현재 발화 버퍼 스냅샷 재전사)
    async def partial_loop(self):
        if self.kind != "funasr":
            while True:
                await asyncio.sleep(self.partial_interval)
                if not self.had_speech or len(self.buf) < SAMPLE_RATE // 2:
                    continue
                if self.infer_lock.locked():
                    continue  # 앞선 추론이 진행 중 — 재전사를 쌓으면 결과가 계속 뒤로 밀린다
                snapshot = self.buf[-SAMPLE_RATE * 15 :]  # 최근 15초까지만
                text = await self.infer(self.engine.transcribe, snapshot, self.lang)
                if text and text != self.last_partial:
                    self.last_partial = text
                    await self.send(text, False)

    async def finalize(self):
        if self.kind == "funasr":
            if self.fun_state and (self.fun_state["text"] or len(self.fun_pending)):
                pad = np.zeros(FunAsrEngine.CHUNK_SAMPLES, dtype=np.float32)
                tail = np.concatenate([self.fun_pending, pad])[: FunAsrEngine.CHUNK_SAMPLES]
                text = await self.infer(self.engine.feed, self.fun_state, tail, True)
                if text:
                    await self.send(text, True)
                self.fun_state = self.engine.new_stream()
                self.fun_pending = np.zeros(0, dtype=np.float32)
        else:
            if len(self.buf) >= SAMPLE_RATE // 4:
                text = await self.infer(self.engine.transcribe, self.buf, self.lang)
                if text:
                    await self.send(text, True)
            self.buf = np.zeros(0, dtype=np.float32)
        self.had_speech = False
        self.silence_sec = 0.0
        self.last_partial = ""


async def handle(ws, engine, engine_kind: str):
    loop = asyncio.get_running_loop()
    session = Session(ws, engine, engine_kind, loop)
    partial_task = asyncio.create_task(session.partial_loop())
    log.info("클라이언트 접속: %s", ws.remote_address)
    try:
        async for message in ws:
            if isinstance(message, (bytes, bytearray)):
                await session.on_pcm(bytes(message))
                continue
            try:
                msg = json.loads(message)
            except json.JSONDecodeError:
                continue
            if msg.get("type") == "start":
                # 'ko-KR' → 'ko' (faster-whisper 언어 코드)
                raw = str(msg.get("language") or "")
                session.lang = raw.split("-")[0] or None
                log.info("start: lang=%s", session.lang)
            elif msg.get("type") == "stop":
                await session.finalize()
                await ws.close()
    finally:
        partial_task.cancel()
        log.info("클라이언트 종료: %s", ws.remote_address)


async def main():
    ap = argparse.ArgumentParser(description="실시간 STT WebSocket 서버")
    ap.add_argument("--engine", choices=["faster-whisper", "funasr", "sensevoice"], default="faster-whisper")
    ap.add_argument(
        "--model", default=None, help="faster-whisper: tiny/base/small… · funasr/sensevoice: 모델명"
    )
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=None)
    # 8코어 맥에서 4가 가장 빨랐다(8은 효율코어까지 써서 1.0s → 1.7s로 악화)
    ap.add_argument("--ncpu", type=int, default=4, help="torch CPU 스레드 수 (sensevoice)")
    args = ap.parse_args()

    import websockets

    if args.engine == "funasr":
        # 기본은 non-large 스트리밍 모델 — CPU에서 실시간(rtf<1) 보장.
        # large(paraformer-zh-streaming)는 CPU에서 rtf≈2로 백로그가 쌓여 실시간 불가.
        engine = FunAsrEngine(args.model or "iic/speech_paraformer_asr_nat-zh-cn-16k-common-vocab8404-online")
        port = args.port or 8766
    elif args.engine == "sensevoice":
        engine = SenseVoiceEngine(args.model or "iic/SenseVoiceSmall", args.ncpu)
        port = args.port or 8767
    else:
        engine = FasterWhisperEngine(args.model or "base")
        port = args.port or 8765

    if hasattr(engine, "warmup"):
        log.info("워밍업 추론…")
        engine.warmup()

    async with websockets.serve(lambda ws: handle(ws, engine, args.engine), args.host, port, max_size=2**22):
        log.info("서버 시작: ws://%s:%d (engine=%s)", args.host, port, args.engine)
        await asyncio.Future()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    asyncio.run(main())
