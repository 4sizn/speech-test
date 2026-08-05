#!/usr/bin/env node
/**
 * STT E2E 러너 — 한 명령으로 전 기능을 자동 측정하고 결과지·판정을 낸다.
 *
 *   npm run qa:stt [-- --profile quick|full] [--samples N] [--features a,b]
 *                     [--vite-port N] [--faster-whisper-model M] [--max-utterance-sec S]
 *                     [--update-baseline] [--no-servers] [--keep-open]
 *
 * 흐름: 전제 점검 → 온프레미스 서버 기동 → vite dev 확보 → QA 서버 →
 *      Chrome(시스템 설치본) → 하네스 순회 → 결과지 작성 → 기준선 대비 판정 → exit code
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import puppeteer from 'puppeteer-core';
import { PROJECT_ROOT, DATASET_ROOT, STT_E2E_LOCAL_DIR, assertNormalizerInSync, loadSamples } from './lib/dataset.mjs';
import { buildFeatures, SERVER_PORTS } from './lib/features.mjs';
import { startQaServer } from './server.mjs';
import { selectQaVitePort } from './lib/vite-port.mjs';
import { createQaChromeProfile } from './lib/chrome-profile.mjs';
import { fasterWhisperCommand, fasterWhisperModelFromArgs } from './lib/server-command.mjs';
import { parentQaRuntimeCommand, resolveQaNode, viteCommand } from './lib/node-runtime.mjs';
import { writeReport, writeSummary } from './lib/report.mjs';
import { judge, updateBaseline, sourceHashes } from './lib/gate.mjs';

// npm inherits the shell's PATH and can launch this runner on Node 16. Re-exec
// before any use of fetch/AbortSignal.timeout so QA fails neither silently nor
// after a misleading 60-second Vite readiness timeout.
const qaRuntime = resolveQaNode();
const reexec = parentQaRuntimeCommand({
  currentNode: process.execPath,
  compatibleNode: qaRuntime,
  script: process.argv[1],
  args: process.argv.slice(2),
});
if (reexec) {
  const [node, nodeArgs] = reexec;
  const result = spawnSync(node, nodeArgs, { cwd: process.cwd(), stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const val = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const PROFILE = val('profile', 'quick');
const LIMIT = args.includes('--samples') ? Number(val('samples')) : undefined;
const ONLY = (val('features', '') || '').split(',').filter(Boolean);
const CHROME =
  process.env.STT_QA_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const REQUESTED_VITE_PORT = Number(val('vite-port', 0));
const FASTER_WHISPER_MODEL = fasterWhisperModelFromArgs(args);
const MAX_UTTERANCE_SEC = args.includes('--max-utterance-sec') ? Number(val('max-utterance-sec')) : undefined;
if (MAX_UTTERANCE_SEC !== undefined && (!Number.isFinite(MAX_UTTERANCE_SEC) || MAX_UTTERANCE_SEC <= 0)) {
  throw new Error('--max-utterance-sec requires a positive number');
}
// 항상 QA 전용 포트를 새로 할당한다. :5173은 사람의 dev server일 수 있어 절대 재사용하지 않는다.
const VITE_PORT = await selectQaVitePort(REQUESTED_VITE_PORT);
const QA_NODE = resolveQaNode();
// 기본 0 = 임의 포트. 고정 포트는 이전 실행의 하네스 탭이 결과를 섞어 넣을 수 있다
const QA_PORT = Number(val('qa-port', 0));

const log = (...a) => console.log(...a);
const sh = (cmd, cmdArgs, opts = {}) =>
  execFileSync(cmd, cmdArgs, { cwd: PROJECT_ROOT, encoding: 'utf8', ...opts }).trim();

function portOpen(port, host = '127.0.0.1', timeout = 400) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    const done = (v) => {
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(timeout);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

async function waitPort(port, { timeoutMs = 120_000, label = `:${port}` } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await portOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} 준비 실패(${Math.round(timeoutMs / 1000)}s 초과)`);
}

/**
 * HTTP로 살아있는지 확인한다. vite dev는 IPv6(::1)에만 바인딩할 수 있어
 * 127.0.0.1 TCP 연결 검사로는 "떠 있는데 없다"고 오판한다(실제로 겪음).
 */
async function httpAlive(url, timeoutMs = 1500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function waitHttp(url, { timeoutMs = 60_000, label = url } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await httpAlive(url)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} 준비 실패(${Math.round(timeoutMs / 1000)}s 초과)`);
}

const children = [];
function spawnBg(label, cmd, cmdArgs) {
  const child = spawn(cmd, cmdArgs, { cwd: PROJECT_ROOT, stdio: 'ignore', detached: false });
  children.push({ label, child });
  return child;
}
function killChildren() {
  for (const { child } of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* noop */
    }
  }
}
// Vite/QA 준비 단계에서 예외가 나도 이 실행이 기동한 child만 정리한다.
process.once('exit', killChildren);

// ── 1) 전제 점검 ────────────────────────────────────────────────────────
if (!existsSync(DATASET_ROOT)) {
  console.error(`데이터셋 없음: ${DATASET_ROOT} (STT_QA_DATASET로 지정 가능)`);
  process.exit(2);
}
if (!existsSync(CHROME)) {
  console.error(`Chrome을 찾을 수 없습니다: ${CHROME} (STT_QA_CHROME로 지정 가능)`);
  process.exit(2);
}

const { doc: samplesDoc, mismatches } = loadSamples();
const normalizer = assertNormalizerInSync(samplesDoc.normalizerFingerprint);
if (!normalizer.ok) {
  console.error(
    `전사 정규화 규칙이 바뀌었습니다(어댑터 ${normalizer.actual} ≠ samples.json ${normalizer.expected}).\n` +
      `기준선 비교의 전제가 깨집니다 — npm run qa:samples 로 샘플을 다시 뽑으세요.`,
  );
  process.exit(2);
}
if (mismatches.length) {
  console.error(`refHash 불일치 ${mismatches.length}건 — 데이터셋이 바뀌었습니다. npm run qa:samples 필요.`);
  for (const m of mismatches.slice(0, 5)) console.error(`  ${m.id}: ${m.expected} → ${m.actual}`);
  process.exit(2);
}

const plan = buildFeatures(PROFILE).filter((f) => !ONLY.length || ONLY.includes(f.feature));
const needServers = [...new Set(plan.map((f) => f.requires?.server).filter(Boolean))];
const assetsNeeded = [...new Set(plan.map((f) => f.requires?.asset).filter(Boolean))];

const assetStatus = {};
for (const model of assetsNeeded) {
  assetStatus[model] = existsSync(join(PROJECT_ROOT, 'public/models', model, 'onnx/encoder_model_quantized.onnx'));
}
const missingAssets = Object.entries(assetStatus).filter(([, ok]) => !ok).map(([m]) => m);
if (missingAssets.length) {
  console.error(`Whisper 자산 없음: ${missingAssets.join(', ')} — npm run assets 먼저 실행하세요.`);
  process.exit(2);
}

log(`프로파일 ${PROFILE} · 기능 ${plan.length}개 · 샘플 ${LIMIT ? `세트별 ${LIMIT}` : '전체'}`);

// ── 2) 온프레미스 서버 ──────────────────────────────────────────────────
const serverStatus = {};
if (!flag('no-servers')) {
  const py = join(PROJECT_ROOT, 'server/.venv/bin/python');
  for (const engine of needServers) {
    const port = SERVER_PORTS[engine];
    if (await portOpen(port)) {
      if (engine === 'faster-whisper' && (FASTER_WHISPER_MODEL || MAX_UTTERANCE_SEC !== undefined)) {
        throw new Error(
          'controlled faster-whisper variables require an unoccupied ' +
          `:${port} (model=${FASTER_WHISPER_MODEL ?? 'default'}, maxUtteranceSec=${MAX_UTTERANCE_SEC ?? 'default'}); ` +
          'refusing to measure an unidentified reused server',
        );
      }
      log(`  :${port} ${engine} — 이미 실행 중(그대로 사용)`);
      serverStatus[port] = 'reused';
      continue;
    }
    if (!existsSync(py)) {
      log(`  :${port} ${engine} — server/.venv 없음 → 해당 기능은 SKIP됩니다`);
      serverStatus[port] = 'missing-venv';
      continue;
    }
    log(`  :${port} ${engine} 기동…`);
    const command = engine === 'faster-whisper'
      ? fasterWhisperCommand({
          script: join(PROJECT_ROOT, 'server/realtime_asr_server.py'), port, model: FASTER_WHISPER_MODEL,
          maxUtteranceSec: MAX_UTTERANCE_SEC,
        })
      : [join(PROJECT_ROOT, 'server/realtime_asr_server.py'), '--engine', engine, '--port', String(port)];
    spawnBg(engine, py, command);
    try {
      await waitPort(port, { timeoutMs: 180_000, label: `${engine}(:${port})` });
      log(`  :${port} ${engine} 준비됨`);
      serverStatus[port] = engine === 'faster-whisper' && (FASTER_WHISPER_MODEL || MAX_UTTERANCE_SEC !== undefined)
        ? `started:model=${FASTER_WHISPER_MODEL ?? 'default'},maxUtteranceSec=${MAX_UTTERANCE_SEC ?? 'default'}` : 'started';
    } catch (err) {
      log(`  :${port} ${engine} 실패 — ${err.message}`);
      serverStatus[port] = 'failed';
    }
  }
} else {
  for (const engine of needServers) serverStatus[SERVER_PORTS[engine]] = (await portOpen(SERVER_PORTS[engine])) ? 'reused' : 'down';
}

// ── 3) vite dev ────────────────────────────────────────────────────────
const VITE_URL = `http://127.0.0.1:${VITE_PORT}`;
log(`  QA 전용 vite dev ${VITE_URL} 기동…`);
const [viteNode, viteArgs] = viteCommand({ node: QA_NODE, root: PROJECT_ROOT, host: '127.0.0.1', port: VITE_PORT });
spawnBg('vite', viteNode, viteArgs);
await waitHttp(`${VITE_URL}/qa-harness.html`, { timeoutMs: 60_000, label: 'QA 전용 vite dev' });
log(`  QA 전용 vite dev ${VITE_URL} 준비됨 (기존 서버 재사용 안 함)`);

// ── 4) QA 서버 ─────────────────────────────────────────────────────────
const qa = await startQaServer({ profile: PROFILE, limit: LIMIT, port: QA_PORT });
log(`  QA 서버 :${qa.port} · 샘플 ${qa.sampleCount}개 · 이벤트 ${qa.eventsPath.replace(PROJECT_ROOT + '/', '')}`);

// ── 5) 브라우저 ────────────────────────────────────────────────────────
const at = new Date().toISOString();
// 감시 경로 해시는 **측정 시작 전에** 찍는다. 결과지 작성 시점(러너 종료)에 찍으면,
// 측정 중 소스를 고쳤을 때 실제 측정 대상과 다른 해시가 기록되어 게이트가 무력해진다.
const hashesAtStart = sourceHashes();
let commit = 'unknown';
let dirty = false;
try {
  commit = sh('git', ['rev-parse', '--short', 'HEAD']);
  dirty = sh('git', ['status', '--porcelain']).length > 0;
} catch {
  /* git 없음 */
}

const chromeProfileDir = createQaChromeProfile();
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false, // SpeechRecognition은 headless에서 동작을 보장하지 못한다
  // Never share a userDataDir: concurrent serial A/B jobs otherwise either fail
  // to launch or silently measure the other run's browser state.
  userDataDir: chromeProfileDir,
  defaultViewport: { width: 1280, height: 800 },
  args: [
    // 사람이 재생 버튼을 누르지 않는 것이 요구사항 — 자동 재생이 막히면 전부 실패한다
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    '--disable-features=CalculateNativeWinOcclusion',
    // 온디바이스 음성 인식(SODA) 언어팩이 측정 중에 내려오지 않게 컴포넌트 업데이터를 끈다.
    // 실측: 새 프로필로 시작하면 Chrome이 스스로 ko-KR SODA 팩을 받고, 그 팩이 있으면
    // 한국어 WebSpeech가 온라인 경로까지 전부 즉시 network로 실패한다(en-US는 정상).
    // 7/28에 8.7%로 측정되던 webspeech-file이 7/29 팩 생성 이후 100%로 바뀐 것이 그 결과다.
    // 측정 환경을 결정론적으로 두기 위한 조치 — 앱 동작과는 무관하다.
    '--disable-component-update',
  ],
});

let exitCode = 0;
try {
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  page.on('console', (m) => {
    if (m.type() === 'error') log(`  [browser:error] ${m.text().slice(0, 200)}`);
  });
  const url = new URL(`${VITE_URL}/qa-harness.html`);
  url.searchParams.set('server', `http://127.0.0.1:${qa.port}`);
  if (ONLY.length) url.searchParams.set('features', ONLY.join(','));
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });

  // 실제 클릭으로 시작 — user activation을 만들어 autoplay 정책과 무관하게 재생된다
  await page.waitForSelector('#start');
  await page.click('#start');
  log('  하네스 시작(클릭) — 순회 중…');

  // 재생 시간 총합 + 기능 수를 감안한 넉넉한 상한
  const totalSec = qa.manifest.sets.short.reduce((a, b) => a + b.sec, 0) + qa.manifest.sets.long.reduce((a, b) => a + b.sec, 0);
  const budgetMs = Math.max(10 * 60_000, plan.length * (totalSec * 1000 + 240_000));
  const t0 = Date.now();
  let lastCount = 0;
  while (Date.now() - t0 < budgetMs) {
    const done = await page.evaluate(() => Boolean(window.__qaDone)).catch(() => false);
    const events = readFileSync(qa.eventsPath, 'utf8').split('\n').filter(Boolean);
    const items = events.filter((l) => l.includes('"t":"item"')).length;
    if (items !== lastCount) {
      lastCount = items;
      log(`    진행 ${items}개 측정 (${Math.round((Date.now() - t0) / 1000)}s)`);
    }
    if (done) break;
    await new Promise((r) => setTimeout(r, 3000));
  }

  // ── 6) 결과지 ────────────────────────────────────────────────────────
  const env = {
    at,
    commit,
    dirty,
    profile: PROFILE,
    snapshot: {
      chrome: (await browser.version()).replace('HeadlessChrome/', 'Chrome/'),
      vite: { url: VITE_URL, port: VITE_PORT, managed: true, reused: false },
      worktree: PROJECT_ROOT,
      assets: assetStatus,
      servers: serverStatus,
      dataset: samplesDoc.datasetName,
      samples: qa.sampleCount,
      fakeMic: true,
    },
    sourceHashes: hashesAtStart,
    planFeatures: plan.map((f) => f.feature),
    envLine: `vite ${VITE_URL} (managed-new) · ${Object.entries(serverStatus).map(([p, s]) => `:${p} ${s}`).join(' · ') || '온프레미스 미사용'} · 샘플 ${qa.sampleCount}`,
  };

  const stray = qa.rejectedEvents();
  if (stray) {
    log(`  ⚠ 다른 실행의 이벤트 ${stray}건을 버렸습니다 — 이전 실행의 브라우저가 살아있을 수 있습니다`);
  }

  const report = writeReport({ eventsPath: qa.eventsPath, env, plan });
  const { verdicts, overall } = judge(report.rows, undefined, env.planFeatures);
  const md = writeSummary({ ...report, verdicts, env, overall });
  log('\n' + md);
  log(`결과지: ${report.dir.replace(PROJECT_ROOT + '/', '')}/summary.md`);

  if (flag('update-baseline')) {
    updateBaseline(report.rows, env);
    log('기준선 갱신됨 — stt-e2e/baseline.json');
  } else if (!overall.pass) {
    exitCode = 1;
  }
} finally {
  if (!flag('keep-open')) {
    await browser.close().catch(() => {});
    rmSync(chromeProfileDir, { recursive: true, force: true });
  }
  await qa.close();
  killChildren();
}

process.exit(exitCode);
