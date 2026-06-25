import { SttProvider } from '../core/SttProvider.js';
import { AudioPcmTap, floatTo16BitPCM } from '../core/AudioPcmTap.js';
import { SystemEvent, Mode } from '../core/events.js';

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
export class StreamingAsrProvider extends SttProvider {
  static id = 'streaming';
  static label = 'Cloud Streaming ASR (WebSocket)';
  static capabilities = [Mode.FILE, Mode.MIC];
  static configSchema = [
    { key: 'wsEndpoint', label: 'WebSocket URL', placeholder: 'wss://...' },
    { key: 'apiKey', label: 'API Key', type: 'password', placeholder: '(필요 시)' },
  ];

  static isSupported() {
    return typeof WebSocket !== 'undefined';
  }

  /** @type {WebSocket|null} */
  #ws = null;
  /** @type {AudioPcmTap|null} */
  #tap = null;

  async start(input) {
    if (!this.config.wsEndpoint) {
      this._sink?.system(SystemEvent.STATUS, { message: 'Streaming 미설정 — WebSocket URL 필요', level: 'warn' });
      this._sink?.error(new Error('Streaming ASR이 설정되지 않았습니다'));
      return;
    }
    if (!input.stream) {
      this._sink?.error(new Error('PCM 스트림이 없습니다 (파일/마이크 캡처 실패)'));
      return;
    }
    this._active = true;

    try {
      this.#ws = new WebSocket(this.config.wsEndpoint);
      this.#ws.binaryType = 'arraybuffer';
      this.#ws.onopen = () => this.#onOpen(input.lang);
      this.#ws.onmessage = (e) => this.#onMessage(e);
      this.#ws.onerror = () => this._sink?.error(new Error('WebSocket 에러'));
      this.#ws.onclose = () => this._active && this._sink?.system(SystemEvent.STATUS, { message: 'WebSocket 종료됨' });
    } catch (err) {
      this._sink?.error(err instanceof Error ? err : new Error(String(err)));
      return;
    }

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

  async stop() {
    this._active = false;
    await this.#tap?.stop();
    this.#tap = null;
    try {
      // TODO: 벤더에 따라 종료 신호(예: {type:'CloseStream'}) 전송 필요할 수 있음
      this.#ws?.close();
    } catch {
      /* noop */
    }
    this.#ws = null;
  }

  // ── 벤더별로 조정할 지점 ──────────────────────────────────────────
  #onOpen(lang) {
    // TODO: 핸드셰이크/설정 프레임 전송 (샘플레이트/언어/인증 등)
    const init = { type: 'start', sampleRate: 16000, language: lang, apiKey: this.config.apiKey || undefined };
    this.#ws?.send(JSON.stringify(init));
  }

  #send(arrayBuffer) {
    // TODO: 벤더가 base64/JSON 래핑을 요구하면 여기서 변환
    this.#ws?.send(arrayBuffer);
  }

  #onMessage(event) {
    // TODO: 응답 스키마에 맞게 파싱
    try {
      const data = JSON.parse(typeof event.data === 'string' ? event.data : '');
      const text = data.text ?? data.transcript ?? data.channel?.alternatives?.[0]?.transcript ?? '';
      const isFinal = data.isFinal ?? data.is_final ?? data.type === 'final';
      if (!text) return;
      if (isFinal) this._sink?.final(String(text).trim());
      else this._sink?.partial(String(text).trim());
    } catch {
      /* 바이너리/비JSON 메시지 무시 */
    }
  }
}
