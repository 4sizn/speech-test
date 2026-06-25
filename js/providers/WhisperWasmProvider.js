import { SttProvider } from '../core/SttProvider.js';
import { AudioPcmTap } from '../core/AudioPcmTap.js';
import { SystemEvent, Mode } from '../core/events.js';

/** 인식 언어 코드 → transformers.js whisper 언어명 */
const LANG_MAP = { 'ko-KR': 'korean', 'en-US': 'english', 'ja-JP': 'japanese', 'zh-CN': 'chinese' };

/**
 * 브라우저 로컬 Whisper Provider (WASM / WebGPU, transformers.js).
 *
 * 파일/마이크 어느 쪽이든 엔진이 만든 MediaStream을 AudioPcmTap으로 16kHz PCM으로 받아
 * 일정 길이(chunk)마다 in-browser Whisper로 인식한다. 서버·키 불필요.
 * 모델은 최초 1회 다운로드되며(수십~수백MB), 이후 캐시된다.
 *
 * ⚠️ transformers.js 모듈은 CDN에서 동적 import 한다(네트워크 필요).
 *    모델/모듈 URL은 설정에서 바꿀 수 있다.
 */
export class WhisperWasmProvider extends SttProvider {
  static id = 'whisper';
  static label = 'Whisper (로컬 WASM/WebGPU)';
  static capabilities = [Mode.FILE, Mode.MIC];
  static configSchema = [
    { key: 'model', label: '모델', default: 'Xenova/whisper-tiny', placeholder: '예: Xenova/whisper-tiny' },
    { key: 'moduleUrl', label: 'transformers.js URL', default: 'https://esm.sh/@huggingface/transformers@3', placeholder: 'CDN ESM URL' },
    { key: 'chunkSec', label: '청크(초)', default: '5', placeholder: '5' },
  ];

  static isSupported() {
    return typeof window !== 'undefined' && typeof WebAssembly !== 'undefined';
  }

  /** @type {AudioPcmTap|null} */
  #tap = null;
  #transcriber = null;
  /** @type {Float32Array[]} */
  #frames = [];
  #samples = 0;
  #busy = false;

  async start(input) {
    if (!input.stream) {
      this._sink?.error(new Error('PCM 스트림이 없습니다 (파일/마이크 캡처 실패)'));
      return;
    }
    this._active = true;

    try {
      await this.#ensureModel();
    } catch (err) {
      this._sink?.error(new Error(`Whisper 로드 실패: ${err?.message ?? err} (모듈/모델 URL 확인)`));
      this._active = false;
      return;
    }

    const lang = LANG_MAP[input.lang || this.config.lang] || undefined;
    const chunkSamples = Math.max(16000, Math.round(Number(this.config.chunkSec || 5) * 16000));

    this.#frames = [];
    this.#samples = 0;
    this.#tap = new AudioPcmTap(input.stream, {
      onFrame: (pcm) => {
        if (!this._active) return;
        this.#frames.push(pcm);
        this.#samples += pcm.length;
        if (this.#samples >= chunkSamples && !this.#busy) {
          void this.#flush(lang);
        }
      },
    });
    await this.#tap.start();
    this._sink?.system(SystemEvent.STATUS, { message: 'Whisper 인식 중 (로컬)' });
  }

  async stop() {
    this._active = false;
    await this.#tap?.stop();
    this.#tap = null;
    // 남은 버퍼 마지막 인식
    if (this.#samples > 16000 && this.#transcriber) {
      const lang = LANG_MAP[this.config.lang] || undefined;
      await this.#flush(lang).catch(() => {});
    }
    this.#frames = [];
    this.#samples = 0;
  }

  async #ensureModel() {
    if (this.#transcriber) return;
    this._sink?.system(SystemEvent.MODEL_LOADING, { model: this.config.model });
    const mod = await import(/* @vite-ignore */ this.config.moduleUrl);
    const { pipeline } = mod;
    const model = this.config.model || 'Xenova/whisper-tiny';
    try {
      this.#transcriber = await pipeline('automatic-speech-recognition', model, { device: 'webgpu' });
    } catch {
      // WebGPU 실패 시 WASM로 폴백
      this.#transcriber = await pipeline('automatic-speech-recognition', model);
    }
    this._sink?.system(SystemEvent.MODEL_READY, { model });
  }

  /** 누적 PCM을 합쳐 한 청크 인식 후 final emit. */
  async #flush(lang) {
    if (this.#busy || this.#samples === 0 || !this.#transcriber) return;
    this.#busy = true;
    const merged = mergeFloat32(this.#frames, this.#samples);
    this.#frames = [];
    this.#samples = 0;
    this._sink?.partial('…인식 중');
    try {
      const out = await this.#transcriber(merged, { language: lang, task: 'transcribe' });
      const text = (out?.text ?? '').trim();
      if (text) this._sink?.final(text);
    } catch (err) {
      this._sink?.error(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.#busy = false;
    }
  }
}

function mergeFloat32(frames, total) {
  const out = new Float32Array(total);
  let off = 0;
  for (const f of frames) {
    out.set(f, off);
    off += f.length;
  }
  return out;
}
