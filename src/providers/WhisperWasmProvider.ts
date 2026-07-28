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
  /**
   * 모델 id. 키가 `model`이 아닌 이유: 기본값을 tiny→base로 바꿀 때
   * localStorage에 남은 이전 선택(tiny)이 새 기본값을 계속 덮어써서, 키를 갈아
   * 한 번 리셋되게 했다(tiny는 한국어 CER 458%로 사실상 사용 불가).
   */
  modelId?: string;
  maxChunkSec?: string | number;
}

// ── 발화 분할 기준 (온프레미스 서버 realtime_asr_server.py와 같은 규칙) ──
/** 무음 판정 RMS 임계 */
const SILENCE_RMS = 0.008;
/** 발화 뒤 이만큼 무음이 이어지면 그 지점에서 끊는다 */
const SILENCE_FLUSH_SEC = 0.5;
/** 이보다 짧은 조각은 인식하지 않는다 — 짧은 파편은 Whisper 환각의 주 원인 */
const MIN_UTTERANCE_SEC = 1.0;

function rms(pcm: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return pcm.length ? Math.sqrt(sum / pcm.length) : 0;
}

/** 반복 허용 횟수 — 이보다 많이 연속 반복되면 이 횟수로 줄인다. */
const MAX_REPEAT = 2;

/**
 * 토큰 내부의 문자 패턴 반복을 줄인다.
 * 실측 사례: 이메일 스펠링 구간에서 "…-2-2-2-2-2…"가 수백 자 이어져 CER이 129%까지 튀었다.
 * 같은 문자 1개(n=1)는 4회 이상일 때만 손대 정상 표기 훼손을 피한다.
 */
function collapseCharRepeats(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    let collapsed = false;
    for (let n = 1; n <= 8 && i + n * 3 <= s.length && !collapsed; n++) {
      const unit = s.slice(i, i + n);
      let reps = 1;
      while (s.slice(i + reps * n, i + (reps + 1) * n) === unit) reps++;
      if (reps > (n === 1 ? 3 : MAX_REPEAT)) {
        out += unit.repeat(MAX_REPEAT);
        i += reps * n;
        collapsed = true;
      }
    }
    if (!collapsed) out += s[i++];
  }
  return out;
}

/** 연속 반복된 어절 n-gram을 줄인다. 실측 사례: "이 시각에서"가 100회 이상 반복(CER 309%). */
function collapseWordRepeats(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; ) {
    let collapsed = false;
    for (let n = Math.min(6, words.length - i); n >= 1 && !collapsed; n--) {
      const gram = words.slice(i, i + n).join(' ');
      let reps = 1;
      while (words.slice(i + reps * n, i + (reps + 1) * n).join(' ') === gram) reps++;
      if (reps > MAX_REPEAT) {
        for (let k = 0; k < MAX_REPEAT; k++) out.push(...words.slice(i, i + n));
        i += reps * n;
        collapsed = true;
      }
    }
    if (!collapsed) out.push(words[i++]);
  }
  return out.join(' ');
}

/**
 * Whisper 반복 루프 환각 방어 — 무음/짧은 파편에서 같은 구절을 무한히 되풀이하는 실패 모드.
 * 정상 문장은 건드리지 않는다(실측: 정상 결과의 CER 변화 0).
 */
function collapseHallucinatedRepeats(text: string): string {
  return collapseWordRepeats(collapseCharRepeats(text)).trim();
}

/** transformers.js ASR 파이프라인의 이 코드가 쓰는 표면만 타입화. */
type Transcriber = (
  audio: Float32Array,
  options: {
    language?: string;
    task: 'transcribe';
    /** 인식 창 길이(초) — Whisper는 30s로 학습됨 */
    chunk_length_s?: number;
    /** 창 사이 겹침(초) — 경계에서 잘린 단어를 복원한다 */
    stride_length_s?: number;
  },
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
      key: 'modelId',
      label: '모델',
      type: 'select',
      default: 'Xenova/whisper-base',
      options: [
        { value: 'Xenova/whisper-tiny', label: 'whisper-tiny (~39M · 가장 빠름 · ⚠ 한국어 비권장)' },
        { value: 'Xenova/whisper-base', label: 'whisper-base (~74M · 한국어 기본)' },
        { value: 'Xenova/whisper-small', label: 'whisper-small (~244M · 가장 정확 · 느림)' },
      ],
      hint: '한국어 CER 실측(AI Hub 상담음성 12발화): tiny 458%(환각) · base 24.6% → 기본 base. 가중치는 자체 출처(/models)에서만 로드',
    },
    {
      key: 'maxChunkSec',
      label: '최대 발화 길이(초)',
      default: '20',
      placeholder: '20',
      hint: '무음 0.5s 경계에서 자동으로 끊고, 무음이 없으면 이 길이에서 강제 확정(Whisper 인식 창은 30s)',
    },
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
  /** 인식은 직렬로 — 무음 경계마다 큐에 넣고 순서대로 처리한다 */
  #queue: Promise<void> = Promise.resolve();
  #silenceSec = 0;
  #hadSpeech = false;

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
    // 시작 단계 실패는 throw — 엔진이 RECOGNITION_ERROR로 정규화하고 #active를 되돌린다
    // (sink.error 후 정상 return하면 엔진이 시작된 것으로 오인해 다음 시작이 차단된다)
    if (!input.stream) throw new Error('PCM 스트림이 없습니다 (파일/마이크 캡처 실패)');

    try {
      await this.#ensureModel(); // prepare()가 로드해 둔 모델 재사용(설정이 바뀌었으면 재로드)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Whisper 로드 실패: ${msg} — 모델 자산이 없으면 npm run assets로 받아주세요`);
    }
    this._active = true;

    const lang = LANG_MAP[input.lang || this.config.lang || ''];
    const maxSec = Math.max(5, Number(this.config.maxChunkSec || 20));

    this.#frames = [];
    this.#samples = 0;
    this.#silenceSec = 0;
    this.#hadSpeech = false;
    this.#queue = Promise.resolve();
    this.#tap = new AudioPcmTap(input.stream, {
      onFrame: (pcm) => {
        if (!this._active) return;
        const voiced = rms(pcm) >= SILENCE_RMS;
        // 발화 시작 전 무음은 버린다 — 무음을 인식에 넣으면 없는 말을 만들어낸다(환각).
        // 직전 1프레임만 남겨 발화 앞부분이 잘리지 않게 한다.
        if (!voiced && !this.#hadSpeech) {
          this.#frames = [pcm];
          this.#samples = pcm.length;
          return;
        }
        this.#frames.push(pcm);
        this.#samples += pcm.length;
        this.#silenceSec = voiced ? 0 : this.#silenceSec + pcm.length / 16000;
        this.#hadSpeech = true;

        const sec = this.#samples / 16000;
        const atBoundary = this.#silenceSec >= SILENCE_FLUSH_SEC && sec >= MIN_UTTERANCE_SEC;
        if (atBoundary || sec >= maxSec) this.#enqueueFlush(lang);
      },
    });
    await this.#tap.start();
    this._sink?.system(SystemEvent.STATUS, { message: 'Whisper 인식 중 · 로컬(클라이언트)' });
  }

  override async stop(): Promise<void> {
    this._active = false;
    await this.#tap?.stop();
    this.#tap = null;
    // 남은 발화 마지막 인식 — 짧아도 발화가 있었으면 버리지 않는다
    if (this.#hadSpeech && this.#transcriber) {
      const lang = LANG_MAP[this.config.lang || ''];
      this.#enqueueFlush(lang);
    }
    await this.#queue.catch(() => {});
    this.#frames = [];
    this.#samples = 0;
    this.#hadSpeech = false;
    this.#silenceSec = 0;
  }

  /** 무음 경계에서 호출 — 인식은 직렬로 처리하고, 버퍼는 즉시 떼어내 다음 발화를 계속 받는다. */
  #enqueueFlush(lang: string | undefined): void {
    if (!this.#hadSpeech || this.#samples === 0) return;
    const merged = mergeFloat32(this.#frames, this.#samples);
    this.#frames = [];
    this.#samples = 0;
    this.#silenceSec = 0;
    this.#hadSpeech = false;
    this.#queue = this.#queue.then(() => this.#transcribe(merged, lang)).catch(() => {});
  }

  async #ensureModel(): Promise<void> {
    const model = this.config.modelId || 'Xenova/whisper-base';
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

  /** 한 발화(무음 경계로 잘린 구간)를 인식해 final emit. */
  async #transcribe(pcm: Float32Array, lang: string | undefined): Promise<void> {
    if (!this.#transcriber) return;
    this._sink?.partial('…인식 중');
    try {
      const out = await this.#transcriber(pcm, {
        language: lang,
        task: 'transcribe',
        // 발화가 maxChunkSec(기본 20s)로 강제 확정될 때를 위한 안전장치 —
        // Whisper 인식 창은 30s이고, 초과분은 5s 겹쳐 청킹해 경계 손실을 줄인다.
        chunk_length_s: 30,
        stride_length_s: 5,
      });
      const text = collapseHallucinatedRepeats(out?.text ?? '');
      if (text) this._sink?.final(text);
    } catch (err) {
      this._sink?.error(err instanceof Error ? err : new Error(String(err)));
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
