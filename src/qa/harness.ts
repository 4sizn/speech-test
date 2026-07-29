/**
 * STT E2E 하네스 — 기능(Provider × 모드 × 실행 위치) × 샘플을 자동으로 끝까지 순회한다.
 *
 * 사람이 재생 버튼을 누르지 않는다:
 *  - 파일 모드: `engine.start()`가 재생을 시작하고, 재생이 끝나면 엔진이 스스로 인식을 종료한다
 *              (SttEngine의 audio `ended` → `stop()`).
 *  - 마이크 모드: `getUserMedia`를 오버라이드해 샘플을 재생한 `captureStream()`을 돌려준다.
 *                실제 물리 마이크가 아니라 파일 주입 가짜 마이크다(결과지에 명시된다).
 *
 * CER 채택 규칙은 앱의 DatasetPanel(reportCer)과 동일하게 맞춘다 — 중지 후 유예 수집 +
 * 개별 final과 전체 join 중 최소 CER. WebSpeech는 final이 중지 뒤에 도착하고 재시작 루프가
 * 중복 final을 내므로, 이 규칙이 없으면 부당하게 나쁘게 측정된다.
 *
 * 결과는 QA 서버로 POST한다. WASM 추론이 메인 스레드를 점유하면 CDP 평가가 타임아웃되어
 * window에서 결과를 회수할 수 없기 때문이다.
 */
import { SttEngine } from '../core/SttEngine';
import { createProviderRegistry } from '../providers/registerAll';
import { SystemEvent, FeatureEvent, Mode } from '../core/events';
import type { RuntimeLocation } from '../core/SttProvider';
import { cer } from '../core/cer';

interface Sample {
  id: string;
  sec: number;
  ref: string;
}

interface Feature {
  feature: string;
  provider: string;
  mode: 'file' | 'mic';
  location: RuntimeLocation;
  config: Record<string, unknown>;
  sets: Array<'short' | 'long'>;
  tolerance: number;
  note?: string;
}

interface Manifest {
  runId: string;
  profile: string;
  normalizerFingerprint: string | null;
  features: Feature[];
  sets: { short: Sample[]; long: Sample[] };
}

const params = new URLSearchParams(location.search);
const QA = params.get('server') || 'http://127.0.0.1:8899';
/** 중지 후 늦게 도착하는 final을 기다리는 시간 — DatasetPanel과 같은 값 */
const GRACE_MS = 1500;
/** 재생 길이에 더해 주는 인식 여유 — Whisper small처럼 느린 경로까지 감안 */
const RECOGNITION_SLACK_MS = 120_000;

const logEl = document.getElementById('log') as HTMLPreElement;
const lines: string[] = [];

/** 서버가 발급한 실행 식별자 — 모든 이벤트에 실어 보내 다른 실행과 섞이지 않게 한다. */
let runId = '';

function post(event: Record<string, unknown>): void {
  void fetch(`${QA}/event`, { method: 'POST', body: JSON.stringify({ runId, ...event }) }).catch(() => {});
}

function log(msg: string): void {
  lines.push(msg);
  logEl.textContent = lines.slice(-60).join('\n');
  console.log('[qa]', msg);
  post({ t: 'log', msg });
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ── 샘플 오디오 ────────────────────────────────────────────────────────
const fileCache = new Map<string, File>();

async function sampleFile(s: Sample): Promise<File> {
  const hit = fileCache.get(s.id);
  if (hit) return hit;
  const res = await fetch(`${QA}/audio/${encodeURIComponent(s.id)}.wav`);
  if (!res.ok) throw new Error(`샘플 오디오 로드 실패(${res.status}): ${s.id}`);
  const buf = await res.arrayBuffer();
  const file = new File([buf], `${s.id.replace(/\//g, '_')}.wav`, { type: 'audio/wav' });
  fileCache.set(s.id, file);
  return file;
}

// ── 파일 주입 가짜 마이크 ───────────────────────────────────────────────
interface FakeMic {
  audio: HTMLAudioElement;
  stream: MediaStream;
}
let fakeMic: FakeMic | null = null;

/**
 * 엔진이 마이크를 요청하면 준비된 샘플 재생 트랙을 돌려준다 — **재생은 시작하지 않는다.**
 *
 * 여기서 바로 play()하면, 엔진이 AudioPcmTap(AudioWorklet 로드)을 붙이는 사이 오디오가 흘러
 * 발화 앞부분이 잘린다. 시스템 부하가 크면 손실이 커져 CER이 13%p까지 튀었다(실측:
 * streaming-mic 29% → 42%, "네, 우리 아이 학습지…"가 "우리 아이콥스…"로).
 * 그래서 재생은 캡처 준비가 끝난 뒤(RECOGNITION_STARTED) 하네스가 시작한다.
 */
function installFakeMic(): void {
  const md = navigator.mediaDevices;
  md.getUserMedia = async () => {
    if (!fakeMic) throw new Error('가짜 마이크가 준비되지 않았습니다');
    return fakeMic.stream;
  };
}

/** 샘플마다 새 엘리먼트/스트림을 만든다 — 엔진이 stop()에서 트랙을 정지시키기 때문. */
async function prepareFakeMic(file: File): Promise<HTMLAudioElement> {
  const audio = new Audio(URL.createObjectURL(file));
  audio.preload = 'auto';
  audio.muted = true; // 스피커로 나갈 필요 없음(디지털 주입)
  await new Promise<void>((resolve, reject) => {
    audio.addEventListener('loadedmetadata', () => resolve(), { once: true });
    audio.addEventListener('error', () => reject(new Error('가짜 마이크 오디오 로드 실패')), { once: true });
  });
  type Capturable = HTMLAudioElement & {
    captureStream?: () => MediaStream;
    mozCaptureStream?: () => MediaStream;
  };
  const el = audio as Capturable;
  const stream = el.captureStream?.() ?? el.mozCaptureStream?.();
  if (!stream) throw new Error('captureStream 미지원 — 가짜 마이크를 만들 수 없습니다');
  fakeMic = { audio, stream };
  return audio;
}

// ── 실행 수집 ──────────────────────────────────────────────────────────
interface RunOutcome {
  finals: string[];
  errors: string[];
  partials: number;
  timedOut: boolean;
}

function collectRun(engine: SttEngine, timeoutMs: number): { done: Promise<RunOutcome>; cancel: () => void } {
  const finals: string[] = [];
  const errors: string[] = [];
  let partials = 0;
  let timedOut = false;
  const unsubs: Array<() => void> = [];
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let settle!: (v: RunOutcome) => void;
  const done = new Promise<RunOutcome>((resolve) => (settle = resolve));

  const finish = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(graceTimer);
    clearTimeout(hardTimer);
    for (const u of unsubs) u();
    settle({ finals, errors, partials, timedOut });
  };

  unsubs.push(
    engine.bus.feature((m) => {
      if (m.type === FeatureEvent.TRANSCRIPT_FINAL) finals.push(String(m.payload.text ?? ''));
      else if (m.type === FeatureEvent.TRANSCRIPT_PARTIAL) partials++;
    }),
  );
  unsubs.push(
    engine.bus.system((m) => {
      if (m.type === SystemEvent.RECOGNITION_ERROR) errors.push(String(m.payload.message ?? ''));
      else if (m.type === SystemEvent.RECOGNITION_STOPPED) {
        clearTimeout(graceTimer);
        graceTimer = setTimeout(finish, GRACE_MS);
      }
    }),
  );
  hardTimer = setTimeout(() => {
    timedOut = true;
    errors.push(`timeout ${Math.round(timeoutMs / 1000)}s`);
    finish();
  }, timeoutMs);

  return { done, cancel: finish };
}

/** DatasetPanel과 동일한 채택 규칙 — 개별 final과 전체 join 중 최소 CER. */
function bestCer(ref: string, finals: string[]): { rate: number; distance: number; refLength: number; hyp: string } {
  const candidates = finals.length ? [...finals, finals.join(' ')] : [''];
  let best: { rate: number; distance: number; refLength: number; hyp: string } | null = null;
  for (const hyp of candidates) {
    const r = cer(ref, hyp);
    if (r && (!best || r.rate < best.rate)) best = { ...r, hyp };
  }
  return best ?? { rate: 1, distance: 0, refLength: 0, hyp: '' };
}

// ── 순회 ───────────────────────────────────────────────────────────────
const registry = createProviderRegistry();
const engine = new SttEngine(registry);
const engineAudio = document.getElementById('audio') as HTMLAudioElement;
// 사용자 제스처 없이 재생하려면 muted여야 한다(autoplay 정책). muted는 스피커 출력만 끄고
// captureStream 트랙의 오디오는 그대로 흐른다 — 실측으로 확인(muted 가짜 마이크에서 CER 정상).
// 러너도 --autoplay-policy=no-user-gesture-required를 주지만, 하네스 자체로도 성립하게 둔다.
engineAudio.muted = true;
engine.attachAudioElement(engineAudio);

async function runSample(f: Feature, s: Sample): Promise<void> {
  const file = await sampleFile(s);
  const timeout = s.sec * 1000 + RECOGNITION_SLACK_MS;
  const t0 = performance.now();
  let run: { done: Promise<RunOutcome>; cancel: () => void } | null = null;

  try {
    if (f.mode === Mode.MIC) {
      const audio = await prepareFakeMic(file);
      const ended = new Promise<void>((resolve) => audio.addEventListener('ended', () => resolve(), { once: true }));
      // 캡처가 붙은 뒤에 재생을 시작해야 발화 앞부분이 잘리지 않는다
      let unsubStarted = (): void => {};
      const captureReady = new Promise<void>((resolve) => {
        unsubStarted = engine.bus.system((m) => {
          if (m.type === SystemEvent.RECOGNITION_STARTED) resolve();
        });
      });
      run = collectRun(engine, timeout);
      await engine.start(); // getUserMedia는 스트림만 준다(재생 없음)
      await captureReady;
      unsubStarted();
      audio.currentTime = 0;
      await audio.play();
      await ended;
      await engine.stop(); // 마이크 모드에는 엔진의 자동 종료가 없다
    } else {
      engine.loadFile(file);
      run = collectRun(engine, timeout);
      await engine.start(); // 엔진이 재생 → ended → 자동 stop
    }
  } catch (err) {
    run?.cancel();
    post({ t: 'item', feature: f.feature, id: s.id, sec: s.sec, error: errMsg(err), ms: Math.round(performance.now() - t0) });
    log(`  ${s.id} ✗ ${errMsg(err)}`);
    throw err; // 기능 단위 처리로 올린다(설정 누락 등은 기능 전체 skip)
  }

  const outcome = await run.done;
  const ms = Math.round(performance.now() - t0);
  const { rate, distance, refLength, hyp } = bestCer(s.ref, outcome.finals);
  post({
    t: 'item',
    feature: f.feature,
    id: s.id,
    sec: s.sec,
    cer: +rate.toFixed(4),
    distance,
    refLength,
    hypLength: hyp.length,
    ms,
    finals: outcome.finals.length,
    partials: outcome.partials,
    timedOut: outcome.timedOut,
    errors: outcome.errors,
    hyp,
    ref: s.ref,
  });
  log(`  ${s.id} CER ${(rate * 100).toFixed(1)}% · ${ms}ms · final ${outcome.finals.length}${outcome.timedOut ? ' (timeout)' : ''}`);
}

async function runFeature(f: Feature, manifest: Manifest): Promise<void> {
  const samples = f.sets.flatMap((set) => manifest.sets[set] ?? []);
  log(`▶ ${f.feature} (${f.provider}/${f.mode}/${f.location}) · 샘플 ${samples.length}`);
  post({ t: 'feature-start', feature: f.feature, provider: f.provider, mode: f.mode, location: f.location, config: f.config, note: f.note ?? null, samples: samples.length });

  try {
    await engine.useProvider(f.provider, { ...f.config, location: f.location, lang: 'ko-KR' });
    engine.setLang('ko-KR');
    engine.setMode(f.mode as Mode);
  } catch (err) {
    log(`  SKIP — ${errMsg(err)}`);
    post({ t: 'feature-skip', feature: f.feature, reason: errMsg(err) });
    return;
  }

  for (const s of samples) {
    try {
      await runSample(f, s);
    } catch (err) {
      // 시작 자체가 실패하는 원인(자격 미설정·서버 다운·미지원 브라우저)은 남은 샘플도 같다
      post({ t: 'feature-skip', feature: f.feature, reason: errMsg(err), partial: true });
      log(`  SKIP(나머지) — ${errMsg(err)}`);
      return;
    }
  }
  post({ t: 'feature-end', feature: f.feature });
}

async function main(): Promise<void> {
  installFakeMic();
  const manifest = (await (await fetch(`${QA}/manifest.json`)).json()) as Manifest;
  runId = manifest.runId; // 이후 모든 이벤트가 이 실행 소속으로 기록된다
  // ?features=a,b 로 일부만 — 부분 재실행/디버깅용
  const only = (params.get('features') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const features = only.length ? manifest.features.filter((f) => only.includes(f.feature)) : manifest.features;
  post({ t: 'run-start', profile: manifest.profile, features: features.length, only, short: manifest.sets.short.length, long: manifest.sets.long.length });
  log(`프로파일 ${manifest.profile} · 기능 ${features.length}${only.length ? `(필터: ${only.join(',')})` : ''} · 샘플 short ${manifest.sets.short.length} / long ${manifest.sets.long.length}`);

  for (const f of features) {
    try {
      await runFeature(f, manifest);
    } catch (err) {
      post({ t: 'feature-error', feature: f.feature, message: errMsg(err) });
      log(`✗ ${f.feature} — ${errMsg(err)}`);
    }
  }

  post({ t: 'run-end' });
  log('완료');
  (window as unknown as { __qaDone?: boolean }).__qaDone = true;
}

let started = false;

function startOnce(trigger: string): void {
  if (started) return;
  started = true;
  log(`시작(${trigger})`);
  void main().catch((err) => {
    post({ t: 'run-error', message: errMsg(err) });
    log(`실행 실패: ${errMsg(err)}`);
    (window as unknown as { __qaDone?: boolean }).__qaDone = true;
  });
}

// 러너는 이 버튼을 클릭한다 — 클릭이 user activation을 만들어 autoplay 정책을 통과한다
const startBtn = document.getElementById('start') as HTMLButtonElement;
startBtn.addEventListener('click', () => {
  startBtn.disabled = true;
  startOnce('click');
});

if (params.get('run') === '1') startOnce('auto');
else log('대기 — 러너가 [순회 시작]을 클릭하거나 ?run=1로 열면 시작한다');
