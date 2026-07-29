#!/usr/bin/env node
/**
 * STT E2E 러너 — 한 명령으로 전 기능을 자동 측정하고 결과지·판정을 낸다.
 *
 *   npm run qa:stt [-- --profile quick|full] [--samples N] [--features a,b]
 *                     [--update-baseline] [--no-servers] [--keep-open]
 *
 * 흐름: 전제 점검 → 온프레미스 서버 기동 → vite dev 확보 → QA 서버 →
 *      Chrome(시스템 설치본) → 하네스 순회 → 결과지 작성 → 기준선 대비 판정 → exit code
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import puppeteer from 'puppeteer-core';
import { PROJECT_ROOT, DATASET_ROOT, STT_E2E_LOCAL_DIR, assertNormalizerInSync, loadSamples } from './lib/dataset.mjs';
import { buildFeatures, SERVER_PORTS } from './lib/features.mjs';
import { startQaServer } from './server.mjs';
import { writeReport, writeSummary } from './lib/report.mjs';
import { judge, updateBaseline, sourceHashes } from './lib/gate.mjs';

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
const VITE_PORT = 5173;
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
    spawnBg(engine, py, [join(PROJECT_ROOT, 'server/realtime_asr_server.py'), '--engine', engine, '--port', String(port)]);
    try {
      await waitPort(port, { timeoutMs: 180_000, label: `${engine}(:${port})` });
      log(`  :${port} ${engine} 준비됨`);
      serverStatus[port] = 'started';
    } catch (err) {
      log(`  :${port} ${engine} 실패 — ${err.message}`);
      serverStatus[port] = 'failed';
    }
  }
} else {
  for (const engine of needServers) serverStatus[SERVER_PORTS[engine]] = (await portOpen(SERVER_PORTS[engine])) ? 'reused' : 'down';
}

// ── 3) vite dev ────────────────────────────────────────────────────────
const VITE_URL = `http://localhost:${VITE_PORT}`;
let viteStarted = false;
if (!(await httpAlive(`${VITE_URL}/qa-harness.html`))) {
  log(`  vite dev 기동…`);
  spawnBg('vite', 'npm', ['run', 'dev']);
  await waitHttp(`${VITE_URL}/qa-harness.html`, { timeoutMs: 60_000, label: 'vite dev' });
  viteStarted = true;
}
log(`  vite dev ${VITE_URL} ${viteStarted ? '기동됨' : '재사용'}`);

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

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false, // SpeechRecognition은 headless에서 동작을 보장하지 못한다
  userDataDir: join(STT_E2E_LOCAL_DIR, 'chrome-profile'),
  defaultViewport: { width: 1280, height: 800 },
  args: [
    // 사람이 재생 버튼을 누르지 않는 것이 요구사항 — 자동 재생이 막히면 전부 실패한다
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    '--disable-features=CalculateNativeWinOcclusion',
  ],
});

let exitCode = 0;
try {
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  page.on('console', (m) => {
    if (m.type() === 'error') log(`  [browser:error] ${m.text().slice(0, 200)}`);
  });
  const url = new URL(`http://localhost:${VITE_PORT}/qa-harness.html`);
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
      assets: assetStatus,
      servers: serverStatus,
      dataset: samplesDoc.datasetName,
      samples: qa.sampleCount,
      fakeMic: true,
    },
    sourceHashes: hashesAtStart,
    planFeatures: plan.map((f) => f.feature),
    envLine: `${Object.entries(serverStatus).map(([p, s]) => `:${p} ${s}`).join(' · ') || '온프레미스 미사용'} · 샘플 ${qa.sampleCount}`,
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
  if (!flag('keep-open')) await browser.close().catch(() => {});
  await qa.close();
  killChildren();
}

process.exit(exitCode);
