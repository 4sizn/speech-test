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
                   기본 small — 한국어 CER 13.4% · 띄어쓰기(WER) 44.2%로 SenseVoice보다 낫다.
                   정확도 우선이면 --model medium (CER 11.6%, 단 RTF 0.93으로 실시간 빡빡)
  funasr         : paraformer-zh-streaming 증분 디코딩(진짜 스트리밍). (zh 전용)
  sensevoice     : SenseVoiceSmall 재전사 방식 — 호출당 고정비용 ≈1s(CPU)라 partial 주기 1.2s. (ko/ja/en/zh/yue)
  whisper-streaming : UFAL whisper_streaming(vendor/, MIT) — 단어 타임스탬프로 확정 지점을 알아
                   오디오 버퍼를 잘라내는 진짜 증분 처리. 발화가 길어도 전사 비용이 일정하다.

사용:
  python3 realtime_asr_server.py --engine faster-whisper --port 8765            # 기본 small
  python3 realtime_asr_server.py --engine faster-whisper --model medium --port 8765
  python3 realtime_asr_server.py --engine funasr --port 8766
  python3 realtime_asr_server.py --engine sensevoice --port 8767
  python3 realtime_asr_server.py --engine whisper-streaming --port 8768

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
# 무음이 없어도 이 길이에서 강제 확정. **모델 속도와 묶여 있다** — 확정은 그 길이만큼을
# 다시 전사하므로 25s×RTF 0.36(small) ≈ 9s가 걸리고, 그 사이 재생/발화가 끝나면 확정 결과가
# 클라이언트 종료 뒤에 도착해 유실된다(실측: 35초 파일에서 final 0건 → CER 100%).
# 15s면 ≈5s로 줄어 여유가 생기고, partial 스냅샷 상한(최근 15초)과도 맞는다.
MAX_UTTERANCE_SEC = 15.0
# whisper-streaming: process_iter를 부르기 전에 모을 최소 오디오. 250ms 프레임마다 부르면
# 호출마다 전사가 돌아 비용이 과하다 — UFAL 서버 기본값(1s)과 같게 둔다.
WSTREAM_MIN_CHUNK_SEC = 1.0


def rms(pcm: np.ndarray) -> float:
    return float(np.sqrt(np.mean(pcm * pcm))) if len(pcm) else 0.0


# ── 엔진 어댑터 ─────────────────────────────────────────────────────────
class FasterWhisperEngine:
    """
    발화 버퍼 재전사 방식 — partial은 현재 발화 전체를 다시 전사한 스냅샷.

    ── 기본 모델을 small로 두는 근거 (AI Hub 상담음성 8샘플 · beam_size=1 · 이 서버와 같은 옵션) ──
      모델      CER     WER(어절)   RTF
      base     21.4%    50.6%      0.13
      small    13.4%    44.2%      0.36   ← 기본
      medium   11.6%    40.3%      0.93
      (비교) SenseVoice 16.4%  65.3%
    small이 SenseVoice보다 정확하고 **띄어쓰기가 크게 낫다**(WER 44% vs 65%). Whisper 계열은
    문장부호·띄어쓰기를 자연히 넣는데 SenseVoice는 거의 넣지 않고 간헐적으로 음절을 분리한다
    ("등록해볼까 하 하고요"). 그 문제는 후처리로 고칠 수 없었다 — 한국어 띄어쓰기 교정기
    (kiwipiepy)를 붙이면 오인식 단어를 더 쪼개 WER이 65%→74%로 악화됐다.

    medium은 더 정확하지만 RTF 0.93이라 partial 재전사(주기 0.6s)에서 백로그가 생긴다
    — 정확도 우선이면 `--model medium`으로 옵트인한다.
    """

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

    def warmup(self) -> None:
        # 첫 호출은 커널 초기화로 느리다 — 무음으로 미리 태워 첫 발화 확정이 밀리지 않게 한다
        # (SenseVoice와 같은 이유. 확정이 늦으면 클라이언트 종료 뒤에 도착해 유실된다.)
        self.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32), None)


class WhisperStreamingEngine:
    """
    UFAL whisper_streaming(`vendor/whisper_online.py`, MIT) 기반 진짜 스트리밍 처리.

    ── 우리 재전사 방식과 무엇이 다른가 ──
    둘 다 LocalAgreement(연속 재전사가 일치한 접두를 확정)를 쓰지만, 우리 `Session.stabilize`는
    **텍스트 어절 접두**만 보고 오디오 버퍼는 그대로 둔다 → 발화가 길어지면 매 주기 전사 비용이
    계속 커진다(상한 15s). UFAL은 `word_timestamps=True`로 **확정 지점의 시각**을 알기 때문에
    그만큼 오디오 버퍼를 잘라낸다 → 발화가 길어도 전사 비용이 일정하게 유지된다.
    긴 발화에서 확정이 밀려 유실되던 문제(MAX_UTTERANCE_SEC 참고)의 근본 해법이다.

    `OnlineASRProcessor`는 상태를 가지므로 **세션마다 하나**를 만든다(엔진은 모델만 공유).
    """

    # 이 엔진은 재전사 루프를 쓰지 않는다 — 오디오를 넣는 즉시 확정분이 나온다
    INCREMENTAL = True

    def __init__(self, model_size: str, beam_size: int):
        import sys as _sys

        _sys.path.insert(0, str(Path(__file__).parent / "vendor"))
        from whisper_online import FasterWhisperASR, OnlineASRProcessor  # noqa: E402

        self._processor_cls = OnlineASRProcessor

        class CpuFasterWhisperASR(FasterWhisperASR):
            """
            업스트림을 CPU에서 쓰기 위한 두 곳의 오버라이드.
              - load_model: 업스트림은 device="cuda" 하드코딩이다.
              - transcribe: beam_size=5가 하드코딩돼 kwargs로 덮을 수 없다(중복 인자 TypeError).
                `word_timestamps=True`는 반드시 유지해야 한다 — 확정 지점의 시각을 알아 오디오
                버퍼를 잘라내는 것이 이 라이브러리의 핵심이다.
            """

            def load_model(self, modelsize=None, cache_dir=None, model_dir=None):
                from faster_whisper import WhisperModel

                return WhisperModel(
                    modelsize, device="cpu", compute_type="int8", download_root=cache_dir
                )

            def transcribe(self, audio, init_prompt=""):
                segments, _info = self.model.transcribe(
                    audio,
                    language=self.original_language,
                    initial_prompt=init_prompt,
                    beam_size=beam_size,
                    word_timestamps=True,
                    condition_on_previous_text=True,
                    **self.transcribe_kargs,
                )
                return list(segments)

        log.info("whisper_streaming 모델 로드: %s (beam=%d)", model_size, beam_size)
        self.asr = CpuFasterWhisperASR(
            lan="ko", modelsize=model_size, cache_dir=str(MODELS_DIR / "faster-whisper")
        )
        log.info("모델 준비 완료")

    def new_processor(self):
        # buffer_trimming=("segment", 15): 문장 토크나이저 없이 세그먼트 경계에서 15s 상한으로 자른다
        return self._processor_cls(self.asr, buffer_trimming=("segment", 15))

    def warmup(self) -> None:
        p = self.new_processor()
        p.insert_audio_chunk(np.zeros(SAMPLE_RATE, dtype=np.float32))
        p.process_iter()
        p.finish()


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
        # LocalAgreement 상태 — 재전사 결과가 흔들려도 이미 보여준 자막을 되돌리지 않기 위한 것.
        # committed: 연속 두 재전사가 일치해 확정된 접두 · prev_snapshot: 직전 재전사 결과
        self.committed = ""
        self.prev_snapshot = ""
        self.fun_state = engine.new_stream() if engine_kind == "funasr" else None
        self.fun_pending = np.zeros(0, dtype=np.float32)
        # whisper-streaming: 프로세서가 상태(오디오 버퍼·확정 접두)를 가지므로 세션마다 하나
        self.ws_proc = engine.new_processor() if engine_kind == "whisper-streaming" else None
        self.ws_pending = np.zeros(0, dtype=np.float32)
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
        if self.kind == "whisper-streaming":
            await self.on_pcm_wstream(pcm)
            return

        # faster-whisper: 발화 중이면 버퍼 누적, 무음 경계에서 확정
        if self.had_speech:
            self.buf = np.concatenate([self.buf, pcm])
        if self.had_speech and (
            self.silence_sec >= SILENCE_FINALIZE_SEC or len(self.buf) >= SAMPLE_RATE * MAX_UTTERANCE_SEC
        ):
            await self.finalize()

    async def on_pcm_wstream(self, pcm: np.ndarray):
        """
        whisper_streaming 증분 처리.

        **무음 경계로 발화를 자르지 않는다.** UFAL은 연속 스트림을 가정하고 세그먼트 경계와 버퍼
        트리밍을 내부에서 관리한다 — 우리가 무음 0.9s마다 프로세서를 리셋하면 짧은 발화(2~3s)는
        LocalAgreement가 "2회 연속 일치"를 볼 기회조차 없이 버려진다(실측: 그렇게 했을 때
        wstream-mic CER 70.3% · 중앙값 100%, 즉 절반이 빈 결과였다).
        그래서 확정분(process_iter의 반환)을 그대로 final로 흘리고, 리셋은 stop에서만 한다.

        `process_iter()`는 250ms 프레임마다 부르면 호출마다 전사가 돌아 비용이 과하다 →
        UFAL 서버 기본값과 같이 최소 청크(1s)를 모아 부른다. 추론이 밀리는 동안 ws_pending에
        쌓이고 다음 호출에 함께 들어가므로 오디오는 유실되지 않는다.
        """
        self.ws_pending = np.concatenate([self.ws_pending, pcm])
        if len(self.ws_pending) < SAMPLE_RATE * WSTREAM_MIN_CHUNK_SEC:
            return
        chunk, self.ws_pending = self.ws_pending, np.zeros(0, dtype=np.float32)
        self.ws_proc.insert_audio_chunk(chunk)
        _beg, _end, text = await self.infer(self.ws_proc.process_iter)
        if text and text.strip():
            # 확정분은 되돌아오지 않는다 → 그대로 확정 자막으로 보낸다(FunASR 증분과 같은 결)
            await self.send(text.strip(), True)

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
        # funasr·whisper-streaming은 증분 엔진이라 재전사 루프가 필요 없다
        if self.kind not in ("funasr", "whisper-streaming"):
            while True:
                await asyncio.sleep(self.partial_interval)
                if not self.had_speech or len(self.buf) < SAMPLE_RATE // 2:
                    continue
                if self.infer_lock.locked():
                    continue  # 앞선 추론이 진행 중 — 재전사를 쌓으면 결과가 계속 뒤로 밀린다
                snapshot = self.buf[-SAMPLE_RATE * 15 :]  # 최근 15초까지만
                text = await self.infer(self.engine.transcribe, snapshot, self.lang)
                out = self.stabilize(text)
                if out and out != self.last_partial:
                    self.last_partial = out
                    await self.send(out, False)

    def stabilize(self, text: str) -> str:
        """
        LocalAgreement — 이미 보여준 자막이 되돌아가는 양을 줄인다.

        재전사 방식은 매 주기 발화 전체를 다시 인식하므로 앞부분 결과가 계속 바뀐다.
        사용자 눈에는 자막이 튀는 것으로 보인다. **연속 두 재전사가 일치한 접두**는 상당히
        믿을 만하므로 확정(committed)으로 굳히고, 그 뒤로는 확정분을 유지한다.

        실측(AI Hub 8샘플 · faster-whisper small · 주기 0.6s):
          되돌려진 글자 수  380 → 183 (절반)
          갱신 횟수          52 → 49
        역행이 완전히 사라지지는 않는다 — 기반 인식이 흔들리면 확정 접두도 짧게 잡힌다.
        확정을 더 강하게 밀면(항상 committed 유지) 틀린 앞부분을 고집하게 되므로 여기까지가 균형.

        final은 이 함수를 거치지 않는다(발화 전체 재전사 그대로) → CER에 영향이 없다.
        """
        if not text:
            return text
        prev_words = self.prev_snapshot.split()
        cur_words = text.split()
        n = 0
        while n < min(len(prev_words), len(cur_words)) and prev_words[n] == cur_words[n]:
            n += 1
        agreed = " ".join(cur_words[:n])
        if len(agreed) > len(self.committed):
            self.committed = agreed
        self.prev_snapshot = text
        # 새 결과가 확정분을 지키면 그대로, 아니면 확정분까지만 보여 되돌림을 막는다
        return text if text.startswith(self.committed) else self.committed

    async def finalize(self):
        if self.kind == "whisper-streaming":
            # 스트림 종료(stop) 시에만 호출된다 — 무음 경계로는 자르지 않는다(on_pcm_wstream 참고)
            if len(self.ws_pending):
                self.ws_proc.insert_audio_chunk(self.ws_pending)
                self.ws_pending = np.zeros(0, dtype=np.float32)
                # **finish()는 오디오를 전사하지 않는다** — transcript_buffer에 남은 미확정분만
                # 비운다(vendor/whisper_online.py:603). 방금 넣은 오디오를 전사하려면 process_iter를
                # 한 번 더 불러야 한다. 이걸 빼면 발화 끝이 잘렸다(실측 CER 47.8% → 29.5%).
                _b, _e, more = await self.infer(self.ws_proc.process_iter)
                if more and more.strip():
                    await self.send(more.strip(), True)
            _beg, _end, tail = await self.infer(self.ws_proc.finish)
            if tail and tail.strip():
                await self.send(tail.strip(), True)
            self.ws_proc = self.engine.new_processor()
            self.ws_pending = np.zeros(0, dtype=np.float32)
        elif self.kind == "funasr":
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
        # 발화가 끝났으므로 확정 접두도 버린다 — 다음 발화까지 끌고 가면 엉뚱한 접두를 고집한다
        self.committed = ""
        self.prev_snapshot = ""


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
    ap.add_argument(
        "--engine",
        choices=["faster-whisper", "funasr", "sensevoice", "whisper-streaming"],
        default="faster-whisper",
    )
    ap.add_argument(
        "--model", default=None,
        help="faster-whisper: tiny/base/small(기본)/medium/large-v3 · funasr/sensevoice: 모델명"
    )
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=None)
    # 8코어 맥에서 4가 가장 빨랐다(8은 효율코어까지 써서 1.0s → 1.7s로 악화)
    ap.add_argument("--ncpu", type=int, default=4, help="torch CPU 스레드 수 (sensevoice)")
    ap.add_argument("--beam", type=int, default=1, help="beam size (whisper-streaming)")
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
    elif args.engine == "whisper-streaming":
        engine = WhisperStreamingEngine(args.model or "small", args.beam)
        port = args.port or 8768
    else:
        engine = FasterWhisperEngine(args.model or "small")
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
