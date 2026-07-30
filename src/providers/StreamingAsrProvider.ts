import { SttProvider, type ConfigField, type ProviderConfig, type RuntimeLocation, type SttInput } from '../core/SttProvider';
import { AudioPcmTap, floatTo16BitPCM } from '../core/AudioPcmTap';
import { SystemEvent, Mode } from '../core/events';

interface StreamingConfig extends ProviderConfig {
  wsEndpoint?: string;
  apiKey?: string;
}

/**
 * 클라우드 스트리밍 ASR Provider (WebSocket) — 골자.
 *
 * 파일/마이크 트랙을 AudioPcmTap으로 16kHz PCM으로 받아, 16-bit PCM 청크를
 * WebSocket으로 실시간 전송하고 interim/final 결과를 받는다.
 * (Qwen3 streaming, Deepgram, Google streaming 등 대부분 이 형태)
 *
 * ⚠️ 벤더마다 프로토콜(핸드셰이크/오디오 포맷/응답 스키마)이 다르다.
 *    아래는 "16k Int16 PCM 바이너리 전송 → {text,isFinal} JSON 수신"의 일반 골자이며,
 *    #onOpen / #send / #onMessage 를 실제 스펙에 맞춰 조정해야 한다(TODO).
 */
export class StreamingAsrProvider extends SttProvider<StreamingConfig> {
  // FunAsrProvider가 상속해 재선언할 수 있도록 리터럴이 아닌 string으로 선언
  static override readonly id: string = 'streaming';
  static override readonly label: string = 'Streaming ASR (faster-whisper 등)';
  static override readonly capabilities: readonly Mode[] = [Mode.FILE, Mode.MIC];
  // WebSocket 엔드포인트가 클라우드든 사내 자체 서버든 동일 프로토콜 — 둘 다 지원 (로컬(클라이언트) 처리 없음)
  static override readonly locations: readonly RuntimeLocation[] = ['remote-onpremise', 'remote-cloud'];
  static override readonly configSchema: readonly ConfigField[] = [
    {
      key: 'wsEndpoint',
      label: 'WebSocket URL',
      default: 'ws://localhost:8765',
      placeholder: 'ws://localhost:8765 또는 wss://...',
      hint:
        '포트가 곧 엔진이다 — 같은 프로토콜이라 URL만 바꾸면 백엔드가 바뀐다. ' +
        '⚙ 8765 = faster-whisper 재전사(기본·권장) · 한국어 CER 14.5%, 마이크 10.4% / ' +
        '⚙ 8768 = whisper_streaming 증분(긴 연속 발화용) · 파일 18.4%, 짧은 발화나 마이크에는 불리 / ' +
        '⚙ 8766 = FunASR(중국어 전용 — 한국어 넣으면 중국어 음절로 매핑된다). ' +
        'SenseVoice(8767)는 이 Provider가 아니라 목록에서 SenseVoice를 고른다. ' +
        '서버 기동: server/realtime_asr_server.py --engine <엔진> --port <포트>',
    },
    { key: 'apiKey', label: 'API Key', type: 'password', placeholder: '(필요 시)' },
  ];

  static override isSupported(): boolean {
    return typeof WebSocket !== 'undefined';
  }

  #ws: WebSocket | null = null;
  #tap: AudioPcmTap | null = null;

  async start(input: SttInput): Promise<void> {
    // 시작 단계 실패는 throw — 엔진이 RECOGNITION_ERROR로 정규화하고 #active를 되돌린다
    if (!this.config.wsEndpoint) throw new Error('Streaming 미설정 — WebSocket URL 필요');
    if (!input.stream) throw new Error('PCM 스트림이 없습니다 (파일/마이크 캡처 실패)');
    this._active = true;

    this.#ws = new WebSocket(this.config.wsEndpoint);
    this.#ws.binaryType = 'arraybuffer';
    this.#ws.onopen = () => this.#onOpen(input.lang);
    this.#ws.onmessage = (e) => this.#onMessage(e);
    this.#ws.onerror = () => this._sink?.error(new Error('WebSocket 에러'));
    this.#ws.onclose = () => {
      if (this._active) this._sink?.system(SystemEvent.STATUS, { message: 'WebSocket 종료됨' });
    };

    // PCM 캡처 → 청크 전송
    this.#tap = new AudioPcmTap(input.stream, {
      onFrame: (pcm) => {
        if (this._active && this.#ws?.readyState === WebSocket.OPEN) {
          this.#send(floatTo16BitPCM(pcm).buffer);
        }
      },
    });
    await this.#tap.start();
    this._sink?.system(SystemEvent.STATUS, { message: 'Streaming ASR 전송 중…' });
  }

  override async stop(): Promise<void> {
    this._active = false;
    await this.#tap?.stop();
    this.#tap = null;
    const ws = this.#ws;
    this.#ws = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        // 종료 신호 → 서버가 잔여 청크 처리를 마치고 최종 결과를 보낸 뒤 닫는다.
        // 느린 엔진(FunASR CPU 등)의 처리 백로그를 감안해 최대 6초 대기.
        ws.send(JSON.stringify({ type: 'stop' }));
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 6000);
          ws.addEventListener(
            'close',
            () => {
              clearTimeout(timeout);
              resolve();
            },
            { once: true },
          );
        });
      } catch {
        /* noop */
      }
    }
    try {
      ws?.close();
    } catch {
      /* noop */
    }
  }

  // ── 벤더별로 조정할 지점 ──────────────────────────────────────────
  #onOpen(lang: string | undefined): void {
    // TODO: 핸드셰이크/설정 프레임 전송 (샘플레이트/언어/인증 등)
    const init = { type: 'start', sampleRate: 16000, language: lang, apiKey: this.config.apiKey || undefined };
    this.#ws?.send(JSON.stringify(init));
  }

  #send(arrayBuffer: ArrayBuffer): void {
    // TODO: 벤더가 base64/JSON 래핑을 요구하면 여기서 변환
    this.#ws?.send(arrayBuffer);
  }

  #onMessage(event: MessageEvent): void {
    // TODO: 응답 스키마에 맞게 파싱
    try {
      const data = JSON.parse(typeof event.data === 'string' ? event.data : '');
      const text: unknown = data.text ?? data.transcript ?? data.channel?.alternatives?.[0]?.transcript ?? '';
      const isFinal: boolean = Boolean(data.isFinal ?? data.is_final ?? data.type === 'final');
      if (!text) return;
      // 중지 대기 중에는 최종 결과만 받는다(늦게 도착하는 partial 무시)
      if (!this._active && !isFinal) return;
      if (isFinal) this._sink?.final(String(text).trim());
      else this._sink?.partial(String(text).trim());
    } catch {
      /* 바이너리/비JSON 메시지 무시 */
    }
  }
}
