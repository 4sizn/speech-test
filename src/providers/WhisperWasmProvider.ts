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
  partialIntervalSec?: string | number;
}

// ── 발화 분할 기준 (온프레미스 서버 realtime_asr_server.py와 같은 규칙) ──
/** 무음 판정 RMS 임계 */
const SILENCE_RMS = 0.008;
/** 발화 뒤 이만큼 무음이 이어지면 그 지점에서 끊는다 */
const SILENCE_FLUSH_SEC = 0.5;
/** 이보다 짧은 조각은 인식하지 않는다 — 짧은 파편은 Whisper 환각의 주 원인 */
const MIN_UTTERANCE_SEC = 1.0;
/** AudioPcmTap의 프레임 주기(ms) — 중간 결과 트리거의 클럭. 이보다 짧은 주기는 의미가 없다 */
const FRAME_MS = 250;
/** 중간 결과 기본 주기(초) */
const DEFAULT_PARTIAL_SEC = 1.0;
/**
 * 이보다 짧은 발화에는 중간 결과를 내지 않는다.
 * 재인식이 CPU를 잡으면 오디오 캡처가 손실된다 — 실측으로 2.9초 발화의 확정 결과에서
 * 앞 두 어절이 뭉개져 CER이 11.8%→35.3%(재현 41.2%)로 뛰었다. 짧은 발화는
 * 어차피 곧 확정되므로 흐르는 자막의 값이 작다 → 긴 발화에만 쓴다.
 */
const PARTIAL_MIN_SEC = 2.0;
/**
 * 다음 중간 결과까지 최소 간격을 직전 소요시간의 몇 배로 둘지 — 워커 점유율 상한(1/N).
 * 2면 33%다. 1(=50%)로 두면 위 캡처 손실이 확정 CER을 3~5%p 악화시켰다.
 */
const PARTIAL_DUTY_DIVISOR = 2;

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
    {
      key: 'partialIntervalSec',
      label: '중간 결과 주기(초)',
      default: '1.0',
      placeholder: '1.0',
      hint:
        '발화 중 이 주기로 현재 발화 전체를 다시 인식해 중간 자막을 갱신한다(0이면 끔 — 무음 경계 확정만). ' +
        'whisper-base 재인식 비용이 대략 0.3s + 0.28×발화길이라 이보다 짧게 줘도 갱신이 그만큼 빨라지지 ' +
        '않고, 앞선 재인식이 진행 중이면 그 주기는 건너뛴다(온프레미스 서버와 같은 규칙). ' +
        '재인식 부하는 오디오 캡처를 흔들어 확정 정확도를 떨어뜨린다 — 2초 미만 발화는 건너뛰고 ' +
        '워커 점유율을 33%로 묶어 실측 회귀를 +2%p 안(관측 변동폭 이내)으로 억제했다',
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
  /**
   * 진행 중인 인식 건수 — 중간 결과는 이게 0일 때만 낸다.
   * boolean이 아닌 이유: 확정 인식이 연달아 2건 큐에 있을 때 먼저 끝난 쪽이 플래그를 내려
   * "진행 중 아님"으로 오판하는 창이 생긴다(서버가 같은 이유로 Lock을 쓴다).
   */
  #inflight = 0;
  /**
   * 발화 세대 — 확정(버퍼 분리)마다 증가. 늦게 도착한 중간 결과를 걸러내는 데 쓴다.
   * start()에서 되돌리지 않는다 — 단조 증가시켜 이전 실행의 응답과 겹치지 않게 한다.
   */
  #utterId = 0;
  /** 마지막으로 내보낸 중간 결과 — 같은 문장 재전송 억제 + 자리표시 판정 */
  #lastPartial = '';
  /** 직전 중간 결과가 끝난 시각(ms) */
  #partialAtMs = 0;
  #partialIntervalMs = 0;
  /** 다음 중간 결과까지 필요한 최소 간격 — 재인식이 길어지면 스스로 늘어난다 */
  #partialGapMs = 0;

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

    // 빈칸·잘못된 값은 기본값으로, 명시적 0만 "끄기"로 읽는다(설정 폼은 빈칸을 ''로 준다).
    const raw = this.config.partialIntervalSec;
    const parsed = raw === undefined || raw === null || raw === '' ? DEFAULT_PARTIAL_SEC : Number(raw);
    const partialSec = Number.isFinite(parsed) ? parsed : DEFAULT_PARTIAL_SEC;
    // 트리거 클럭이 onFrame(250ms)이라 그보다 짧은 주기는 의미가 없다
    this.#partialIntervalMs = partialSec > 0 ? Math.max(FRAME_MS, partialSec * 1000) : 0;
    this.#partialGapMs = this.#partialIntervalMs;
    this.#partialAtMs = 0;
    this.#lastPartial = '';

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
        if (atBoundary || sec >= maxSec) {
          this.#enqueueFlush(lang);
          return;
        }
        // 발화 중 중간 결과 — 온프레미스 서버 partial_loop과 같은 방식(현재 발화 전체를 재인식).
        // 검사를 버퍼 합치기보다 앞에 둔다 — 건너뛸 주기에 수 MB를 복사하지 않기 위해.
        if (
          this.#partialIntervalMs > 0 &&
          this.#inflight === 0 &&
          // 무음 프레임에서는 시작하지 않는다: 무음 0.5s(=프레임 2개)면 확정이므로 여기서
          // 수 초짜리 재인식을 걸면 확정이 그만큼 밀린다. 시작한 인식은 취소할 방법이 없다.
          this.#silenceSec === 0 &&
          sec >= PARTIAL_MIN_SEC &&
          performance.now() - this.#partialAtMs >= this.#partialGapMs
        ) {
          this.#enqueuePartial(lang);
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
    this.#lastPartial = '';
  }

  /** 무음 경계에서 호출 — 인식은 직렬로 처리하고, 버퍼는 즉시 떼어내 다음 발화를 계속 받는다. */
  #enqueueFlush(lang: string | undefined): void {
    if (!this.#hadSpeech || this.#samples === 0) return;
    const merged = mergeFloat32(this.#frames, this.#samples);
    this.#frames = [];
    this.#samples = 0;
    this.#silenceSec = 0;
    this.#hadSpeech = false;
    // 세대 증가는 버퍼를 떼어내는 이 동기 블록 안에서 — 응답 도착 시점에 올리면 그 사이
    // 발행된 중간 결과가 새 발화의 것으로 오인된다.
    this.#utterId++;
    this.#enqueue(merged, lang, null);
  }

  /** 발화 중 호출 — 누적 버퍼를 건드리지 않고 스냅샷만 떠서 중간 결과를 낸다. */
  #enqueuePartial(lang: string | undefined): void {
    // mergeFloat32는 항상 새 버퍼를 만들어 #frames와 메모리를 공유하지 않는다
    // → 확정 인식과 똑같이 소유권을 넘겨 보낼 수 있다(복사 비용 없음).
    // 길이 상한은 Whisper 인식 창(30s)에만 둔다: 기본 maxChunkSec 20s에서는 걸리지 않고,
    // 그보다 크게 올린 경우에만 여러 창으로 쪼개는 경로(비용이 창 수만큼 늘어난다)를 막는다.
    const snapshot = mergeFloat32(this.#frames, this.#samples, CHUNK_LENGTH_SEC * 16000);
    this.#enqueue(snapshot, lang, this.#utterId);
  }

  /** gen이 null이면 확정, 숫자면 그 세대의 중간 결과. */
  #enqueue(pcm: Float32Array, lang: string | undefined, gen: number | null): void {
    this.#inflight++;
    this.#queue = this.#queue
      .then(() => this.#transcribe(pcm, lang, gen))
      .catch(() => {})
      // 조기 return이나 예외에도 반드시 내려가야 한다 — 한 번 새면 중간 결과가 영구 정지한다
      .finally(() => {
        this.#inflight--;
      });
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
    worker.onerror = (e) => {
      // 워커가 죽으면 대기 중인 요청에는 영원히 응답이 오지 않는다 — 전부 거절해 큐를 풀어준다.
      // 안 풀면 #queue가 영구 대기가 되어 stop()이 끝나지 않고(엔진이 실행 중으로 굳어 재시작
      // 불가), #inflight도 0으로 돌아오지 않아 중간 결과가 영구 정지한다.
      const err = new Error(`Whisper 워커 오류: ${e.message}`);
      for (const p of this.#pending.values()) p.reject(err);
      this.#pending.clear();
      this._sink?.error(err);
    };
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

  /**
   * 워커에 보내 인식한다. gen이 null이면 확정 발화(final), 숫자면 그 세대의 중간 결과(partial).
   */
  async #transcribe(pcm: Float32Array, lang: string | undefined, gen: number | null): Promise<void> {
    const worker = this.#worker;
    if (!worker || !this.#loadedKey) return;
    const isPartial = gen !== null;
    // 큐에서 기다리는 동안 발화가 확정됐다면(세대가 바뀜) 이 중간 결과는 설명할 대상이 없다
    if (isPartial && (gen !== this.#utterId || !this._active)) return;
    // 보여줄 중간 결과가 아직 없을 때만 자리표시 — 있으면 마지막 중간 결과를 남긴다(깜빡임 방지)
    if (!isPartial && !this.#lastPartial) this._sink?.partial('…인식 중');
    const startedAt = performance.now();
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
      if (isPartial) {
        this.#partialAtMs = performance.now();
        // 재인식이 길어질수록 스스로 뜸해지게 — 워커 점유율 가드.
        // whisper-base 비용이 대략 0.3s + 0.28×발화길이라(20s 발화면 6s 가까이), 고정 주기로만
        // 재면 긴 발화에서 워커가 계속 붙잡혀 오디오 캡처까지 흔들린다(확정 CER 3~5%p 악화 실측).
        this.#partialGapMs = Math.max(
          this.#partialIntervalMs,
          (this.#partialAtMs - startedAt) * PARTIAL_DUTY_DIVISOR,
        );
        if (gen !== this.#utterId || !this._active) return; // 확정이 이미 나갔다 → 버린다
        if (!cleaned || cleaned === this.#lastPartial) return;
        this.#lastPartial = cleaned;
        this._sink?.partial(cleaned);
        return;
      }
      this.#lastPartial = '';
      if (cleaned) this._sink?.final(cleaned);
    } catch (err) {
      this.#pending.delete(id);
      if (isPartial) {
        // 중간 결과 실패는 알리지 않는다 — 같은 워커를 쓰는 확정 경로에서 어차피 드러난다.
        // 다만 간격은 갱신해야 한다: 안 하면 즉시 재시도해 실패 루프가 된다.
        this.#partialAtMs = performance.now();
        return;
      }
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

/**
 * 누적 프레임을 하나로 합친다. maxSamples를 주면 **뒤쪽 그만큼만** 취한다.
 * 반환값은 항상 새 버퍼라 frames와 메모리를 공유하지 않는다 — 그래서 결과를 워커로 보낼 때
 * 소유권을 넘겨도 누적 버퍼가 망가지지 않는다(frames의 원소를 직접 넘기면 안 되는 이유).
 */
function mergeFloat32(frames: Float32Array[], total: number, maxSamples = total): Float32Array {
  const take = Math.min(total, maxSamples);
  const out = new Float32Array(take);
  let skip = total - take;
  let off = 0;
  for (const f of frames) {
    let src = f;
    if (skip > 0) {
      if (skip >= f.length) {
        skip -= f.length;
        continue;
      }
      src = f.subarray(skip);
      skip = 0;
    }
    out.set(src, off);
    off += src.length;
  }
  return out;
}
