import { SttProvider, type ConfigField, type ProviderConfig, type RuntimeLocation, type SttInput } from '../core/SttProvider';
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
  chunkSec?: string | number;
}

/** transformers.js ASR 파이프라인의 이 코드가 쓰는 표면만 타입화. */
type Transcriber = (
  audio: Float32Array,
  options: { language?: string; task: 'transcribe' },
) => Promise<{ text?: string }>;

/**
 * 클라이언트 로컬 Whisper Provider (WASM / WebGPU, transformers.js) — 자체 CPU/GPU로 인식.
 *
 * 파일/마이크 어느 쪽이든 엔진이 만든 MediaStream을 AudioPcmTap으로 16kHz PCM으로 받아
 * 일정 길이(chunk)마다 in-browser Whisper로 인식한다. 서버·키 불필요.
 *
 * local-client 계약: 코드/모델 자산도 별도 도메인 없이 자체 출처에서 관리한다.
 *  - transformers.js : npm 의존성으로 번들에 포함 (CDN 동적 import 제거)
 *  - 모델 가중치     : same-origin /models 에서만 로드 (allowRemoteModels=false)
 *  - ONNX WASM 런타임: same-origin /ort 에서 서빙
 * 자산 준비는 최초 1회 `npm run assets` (scripts/fetch-local-assets.mjs).
 */
export class WhisperWasmProvider extends SttProvider<WhisperConfig> {
  static override readonly id = 'whisper';
  static override readonly label = 'Whisper (클라이언트 WASM/WebGPU)';
  static override readonly capabilities: readonly Mode[] = [Mode.FILE, Mode.MIC];
  // 인식 자체가 클라이언트 브라우저 내(WASM/WebGPU) CPU/GPU에서만 수행된다 — 원격 옵션 없음
  static override readonly locations: readonly RuntimeLocation[] = ['local-client'];
  static override readonly configSchema: readonly ConfigField[] = [
    {
      key: 'model',
      label: '모델',
      type: 'select',
      default: 'Xenova/whisper-tiny',
      options: [
        { value: 'Xenova/whisper-tiny', label: 'whisper-tiny (~39M · 가장 빠름)' },
        { value: 'Xenova/whisper-base', label: 'whisper-base (~74M · 균형)' },
        { value: 'Xenova/whisper-small', label: 'whisper-small (~244M · 정확)' },
      ],
      hint: '가중치는 자체 출처(/models)에서만 로드 — 외부 도메인 접근 없음. 최초 1회 npm run assets로 받아 관리',
    },
    { key: 'chunkSec', label: '청크(초)', default: '5', placeholder: '5' },
  ];

  static override isSupported(): boolean {
    return typeof window !== 'undefined' && typeof WebAssembly !== 'undefined';
  }

  #tap: AudioPcmTap | null = null;
  #transcriber: Transcriber | null = null;
  /** 현재 로드된 모델 식별자(moduleUrl|model) — 설정 변경 시 재로드 판단용 */
  #loadedKey = '';
  #frames: Float32Array[] = [];
  #samples = 0;
  #busy = false;

  /** 모델 로드/컴파일 — 엔진이 재생 시작 전에 호출한다. */
  override async prepare(): Promise<void> {
    try {
      await this.#ensureModel();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Whisper 로드 실패: ${msg} — 모델 자산이 없으면 npm run assets로 받아주세요`);
    }
  }

  async start(input: SttInput): Promise<void> {
    if (!input.stream) {
      this._sink?.error(new Error('PCM 스트림이 없습니다 (파일/마이크 캡처 실패)'));
      return;
    }
    this._active = true;

    try {
      await this.#ensureModel(); // prepare()가 로드해 둔 모델 재사용(설정이 바뀌었으면 재로드)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._sink?.error(new Error(`Whisper 로드 실패: ${msg} — 모델 자산이 없으면 npm run assets로 받아주세요`));
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
    this._sink?.system(SystemEvent.STATUS, { message: 'Whisper 인식 중 · 로컬(클라이언트)' });
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
    const model = this.config.model || 'Xenova/whisper-tiny';
    // 같은 모델이 이미 로드돼 있으면 재사용, 설정이 바뀌었으면 재로드
    if (this.#transcriber && this.#loadedKey === model) return;
    this.#transcriber = null;
    this._sink?.system(SystemEvent.MODEL_LOADING, { model });
    // 번들된 모듈을 최초 사용 시점에 지연 로드(코드 스플릿) — 외부 CDN 아님
    const { pipeline, env } = await import('@huggingface/transformers');
    // local-client 계약: 모델/런타임 자산 전부 same-origin에서만 가져온다 (외부 도메인 차단)
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = '/models/';
    // WASM 런타임도 same-origin — dev는 vite가 패키지 dist(매칭 버전 동봉)를 직접 서빙하고
    // (public의 .mjs는 모듈 import 불가), 빌드본은 npm run assets가 복사한 /ort/ 정적 파일 사용
    if (env.backends.onnx.wasm) {
      env.backends.onnx.wasm.wasmPaths = import.meta.env.DEV ? '/node_modules/@huggingface/transformers/dist/' : '/ort/';
      // COOP/COEP 미적용 호스팅이면 SharedArrayBuffer가 없어 멀티스레드 초기화가 멈춘다 → 단일 스레드 폴백
      if (!crossOriginIsolated) env.backends.onnx.wasm.numThreads = 1;
    }
    // 정적 서버는 없는 파일에 index.html(200)을 돌려줄 수 있어(SPA 폴백) ONNX 파싱/세션이
    // 조용히 죽는다 → 자산 실존을 선확인하고, 가능한 경로만 시도한다
    if (!(await assetExists(`/models/${model}/onnx/encoder_model_quantized.onnx`))) {
      throw new Error(`모델 자산(/models/${model})이 없습니다`);
    }
    const load = (options?: { device?: 'webgpu' }): Promise<Transcriber> =>
      pipeline('automatic-speech-recognition', model, options) as unknown as Promise<Transcriber>;
    const tryWebgpu = 'gpu' in navigator && (await assetExists(`/models/${model}/onnx/encoder_model.onnx`));
    try {
      this.#transcriber = tryWebgpu ? await load({ device: 'webgpu' }) : await load();
    } catch {
      // WebGPU 세션 생성 실패 시 WASM(q8)로 폴백
      this.#transcriber = await load();
    }
    this.#loadedKey = model;
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

/** same-origin 자산 실존 확인 — SPA 폴백(index.html 200)을 자산으로 오인하지 않도록 HEAD로 검사. */
async function assetExists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok && !(res.headers.get('content-type') ?? '').includes('text/html');
  } catch {
    return false;
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
