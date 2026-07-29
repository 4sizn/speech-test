import { SttProvider, type ConfigField, type ProviderConfig, type RuntimeLocation, type SttInput } from '../core/SttProvider';
import { AudioPcmTap } from '../core/AudioPcmTap';
import { SystemEvent, Mode } from '../core/events';
// Vite worker 빌드 — 추론을 메인 스레드 밖에서 돌린다(UI 멈춤 방지)
import WhisperWorker from './whisper-worker.ts?worker';

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

/** 인식 창 길이(초) — Whisper는 30s로 학습됐다 */
const CHUNK_LENGTH_SEC = 30;
/** 창 사이 겹침(초) — 경계에서 잘린 단어를 복원한다 */
const STRIDE_LENGTH_SEC = 5;

/** 워커 → 메인 메시지 */
type WorkerOut =
  | { type: 'loaded'; model: string; device: string }
  | { type: 'result'; id: number; text: string }
  | { type: 'error'; id?: number; message: string };

/**
 * 클라이언트 로컬 Whisper Provider (WASM / WebGPU, transformers.js) — 자체 CPU/GPU로 인식.
 *
 * 파일/마이크 어느 쪽이든 엔진이 만든 MediaStream을 AudioPcmTap으로 16kHz PCM으로 받아
 * 무음 경계마다 in-browser Whisper로 인식한다. 서버·키 불필요.
 *
 * **추론은 Web Worker에서 돌린다.** 메인 스레드에서 돌리면 UI가 멈춘다(실측: 3.3초 오디오
 * 1건에 최대 1,123ms 프레임 갭, 총 2.6초 정지). 긴 파일·small 모델에서는 "페이지 먹통"으로
 * 체감된다. 워커로 옮기면 인식 중에도 화면·버튼이 계속 반응한다.
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
      hint: '한국어 CER 실측(AI Hub 상담음성 · npm run qa:stt): tiny 48.8% · base 27.4% · small 15.7%(단 지연 2.6배) → 실시간 기본은 base. 가중치는 자체 출처(/models)에서만 로드',
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
  #worker: Worker | null = null;
  /** 현재 로드된 모델 — 설정 변경 시 재로드 판단용 */
  #loadedKey = '';
  /** 워커 요청 id → 대기 중인 resolver */
  #pending = new Map<number, { resolve: (text: string) => void; reject: (err: Error) => void }>();
  #seq = 0;
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
    if (this.#hadSpeech && this.#loadedKey) {
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

  /** 워커를 띄우고 메시지 라우팅을 건다(1회). */
  #ensureWorker(): Worker {
    if (this.#worker) return this.#worker;
    const worker = new WhisperWorker();
    worker.onmessage = (event: MessageEvent<WorkerOut>) => {
      const msg = event.data;
      if (msg.type === 'result') {
        this.#pending.get(msg.id)?.resolve(msg.text);
        this.#pending.delete(msg.id);
        return;
      }
      if (msg.type === 'error') {
        const err = new Error(msg.message);
        if (msg.id !== undefined && this.#pending.has(msg.id)) {
          this.#pending.get(msg.id)?.reject(err);
          this.#pending.delete(msg.id);
        } else {
          this._sink?.error(err);
        }
      }
    };
    worker.onerror = (e) => this._sink?.error(new Error(`Whisper 워커 오류: ${e.message}`));
    this.#worker = worker;
    return worker;
  }

  async #ensureModel(): Promise<void> {
    const model = this.config.modelId || 'Xenova/whisper-base';
    // 같은 모델이 이미 로드돼 있으면 재사용, 설정이 바뀌었으면 재로드
    if (this.#loadedKey === model && this.#worker) return;
    const worker = this.#ensureWorker();
    this.#loadedKey = '';
    this._sink?.system(SystemEvent.MODEL_LOADING, { model });

    await new Promise<void>((resolve, reject) => {
      const onMessage = (event: MessageEvent<WorkerOut>): void => {
        const msg = event.data;
        if (msg.type === 'loaded' && msg.model === model) {
          worker.removeEventListener('message', onMessage);
          this.#loadedKey = model;
          this._sink?.system(SystemEvent.MODEL_READY, { model, device: msg.device });
          resolve();
        } else if (msg.type === 'error' && msg.id === undefined) {
          worker.removeEventListener('message', onMessage);
          reject(new Error(msg.message));
        }
      };
      worker.addEventListener('message', onMessage);
      worker.postMessage({ type: 'load', model });
    });
  }

  /** 한 발화(무음 경계로 잘린 구간)를 워커에 보내 인식하고 final emit. */
  async #transcribe(pcm: Float32Array, lang: string | undefined): Promise<void> {
    const worker = this.#worker;
    if (!worker || !this.#loadedKey) return;
    this._sink?.partial('…인식 중');
    const id = ++this.#seq;
    try {
      const text = await new Promise<string>((resolve, reject) => {
        this.#pending.set(id, { resolve, reject });
        // PCM 버퍼는 소유권을 넘겨 복사 비용을 없앤다(전송 후 이 쪽 pcm은 비워진다)
        worker.postMessage(
          {
            type: 'transcribe',
            id,
            pcm,
            language: lang,
            // 발화가 maxChunkSec(기본 20s)로 강제 확정될 때를 위한 안전장치 —
            // 인식 창 30s를 넘는 분량은 5s 겹쳐 청킹해 경계 손실을 줄인다.
            chunkLengthSec: CHUNK_LENGTH_SEC,
            strideLengthSec: STRIDE_LENGTH_SEC,
          },
          [pcm.buffer],
        );
      });
      const cleaned = collapseHallucinatedRepeats(text);
      if (cleaned) this._sink?.final(cleaned);
    } catch (err) {
      this.#pending.delete(id);
      this._sink?.error(err instanceof Error ? err : new Error(String(err)));
    }
  }

  override async dispose(): Promise<void> {
    await super.dispose();
    this.#worker?.terminate();
    this.#worker = null;
    this.#loadedKey = '';
    this.#pending.clear();
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
