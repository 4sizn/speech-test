import { SttProvider, type ConfigField, type ProviderConfig, type SttInput } from '../core/SttProvider';
import { AudioPcmTap } from '../core/AudioPcmTap';
import { SystemEvent, Mode } from '../core/events';

/** 인식 언어 코드 → transformers.js whisper 언어명 */
const LANG_MAP: Record<string, string> = {
  'ko-KR': 'korean',
  'en-US': 'english',
  'ja-JP': 'japanese',
  'zh-CN': 'chinese',
};

interface WhisperConfig extends ProviderConfig {
  model?: string;
  moduleUrl?: string;
  chunkSec?: string | number;
}

/** transformers.js ASR 파이프라인의 이 코드가 쓰는 표면만 타입화. */
type Transcriber = (
  audio: Float32Array,
  options: { language?: string; task: 'transcribe' },
) => Promise<{ text?: string }>;

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
export class WhisperWasmProvider extends SttProvider<WhisperConfig> {
  static override readonly id = 'whisper';
  static override readonly label = 'Whisper (로컬 WASM/WebGPU)';
  static override readonly capabilities: readonly Mode[] = [Mode.FILE, Mode.MIC];
  static override readonly configSchema: readonly ConfigField[] = [
    { key: 'model', label: '모델', default: 'Xenova/whisper-tiny', placeholder: '예: Xenova/whisper-tiny' },
    { key: 'moduleUrl', label: 'transformers.js URL', default: 'https://esm.sh/@huggingface/transformers@3', placeholder: 'CDN ESM URL' },
    { key: 'chunkSec', label: '청크(초)', default: '5', placeholder: '5' },
  ];

  static override isSupported(): boolean {
    return typeof window !== 'undefined' && typeof WebAssembly !== 'undefined';
  }

  #tap: AudioPcmTap | null = null;
  #transcriber: Transcriber | null = null;
  #frames: Float32Array[] = [];
  #samples = 0;
  #busy = false;

  async start(input: SttInput): Promise<void> {
    if (!input.stream) {
      this._sink?.error(new Error('PCM 스트림이 없습니다 (파일/마이크 캡처 실패)'));
      return;
    }
    this._active = true;

    try {
      await this.#ensureModel();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._sink?.error(new Error(`Whisper 로드 실패: ${msg} (모듈/모델 URL 확인)`));
      this._active = false;
      return;
    }

    const lang = LANG_MAP[input.lang || this.config.lang || ''];
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

  override async stop(): Promise<void> {
    this._active = false;
    await this.#tap?.stop();
    this.#tap = null;
    // 남은 버퍼 마지막 인식
    if (this.#samples > 16000 && this.#transcriber) {
      const lang = LANG_MAP[this.config.lang || ''];
      await this.#flush(lang).catch(() => {});
    }
    this.#frames = [];
    this.#samples = 0;
  }

  async #ensureModel(): Promise<void> {
    if (this.#transcriber) return;
    this._sink?.system(SystemEvent.MODEL_LOADING, { model: this.config.model });
    const moduleUrl = this.config.moduleUrl || 'https://esm.sh/@huggingface/transformers@3';
    const mod = await import(/* @vite-ignore */ moduleUrl);
    const pipeline = mod.pipeline as (
      task: string,
      model: string,
      options?: { device?: string },
    ) => Promise<Transcriber>;
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
  async #flush(lang: string | undefined): Promise<void> {
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

function mergeFloat32(frames: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total);
  let off = 0;
  for (const f of frames) {
    out.set(f, off);
    off += f.length;
  }
  return out;
}
