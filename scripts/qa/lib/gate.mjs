/**
 * 결과지 ↔ 기준선 비교 판정. 러너와 pre-push 훅이 함께 쓴다.
 *
 * 규칙
 *  - PASS  : cerAvg <= baseline + tolerance
 *  - FAIL  : 초과 / 기준선에 있던 기능이 이번에 SKIP(측정을 건너뛰어 통과하는 길을 막는다)
 *  - NEW   : 기준선에 없는 기능(정보) — 실패로 치지 않는다
 *  - SKIP  : 기준선에도 없고 이번에도 측정 못 함(자격 미설정 등)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT, STT_E2E_DIR } from './dataset.mjs';

export const BASELINE_PATH = join(STT_E2E_DIR, 'baseline.json');

/** 게이트가 감시하는 소스 — 이 파일들이 바뀌면 재측정이 필요하다. */
export const WATCHED_PATHS = [
  'src/providers',
  'src/core',
  'src/qa',
  'server/realtime_asr_server.py',
  'vite.config.ts',
  'package.json',
];

/**
 * 감시 대상 파일 내용의 해시 맵(경로 → 12자 해시).
 *
 * 추적 파일뿐 아니라 **아직 커밋되지 않은 새 파일(untracked)도 포함**한다.
 * 추적 파일만 보면, 새로 만든 Provider나 하네스로 측정한 뒤 그것을 커밋하는 순간
 * "측정 후 소스가 바뀌었다"로 잡혀 자기 자신 때문에 푸시가 막힌다(실제로 겪음).
 * .gitignore된 파일은 제외한다(--exclude-standard).
 */
export function sourceHashes() {
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', ...WATCHED_PATHS], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
    .sort();
  const out = {};
  for (const rel of listed) {
    const abs = join(PROJECT_ROOT, rel);
    if (!existsSync(abs)) continue;
    out[rel] = createHash('sha256').update(readFileSync(abs)).digest('hex').slice(0, 12);
  }
  return out;
}

/** 두 해시 맵의 차이 목록 */
export function diffHashes(recorded = {}, current = {}) {
  const changed = [];
  for (const [k, v] of Object.entries(current)) {
    if (recorded[k] !== v) changed.push(k);
  }
  for (const k of Object.keys(recorded)) {
    if (!(k in current)) changed.push(k);
  }
  return changed;
}

export function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return { features: {} };
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
}

/**
 * 판정.
 * @param {Array} rows writeReport가 만든 행
 * @param {object} baseline
 */
/**
 * @param {Array} rows            결과지 행
 * @param {object} baseline
 * @param {string[]} [planFeatures] 이번 실행이 다루기로 한 기능 목록.
 *   주면 누락 판정을 이 범위로 제한한다 — full 프로파일 기준선(tiny/small 포함)을 둔 채
 *   quick으로 돌리면 "빠진 기능"으로 매번 FAIL이 나기 때문. 없으면 기준선 전체를 본다.
 */
export function judge(rows, baseline = loadBaseline(), planFeatures) {
  const verdicts = [];

  // 기준선에 있는데 이번 결과지에 아예 없는 기능 → MISSING(FAIL).
  // --features로 일부만 측정한 결과지가 최신이 되면 나머지가 판정에서 빠져
  // 회귀를 품은 채 통과할 수 있다. 그 구멍을 막는다.
  const measuredNames = new Set(rows.map((r) => r.feature));
  const inScope = planFeatures?.length ? new Set(planFeatures) : null;
  for (const name of Object.keys(baseline.features ?? {})) {
    if (measuredNames.has(name)) continue;
    if (inScope && !inScope.has(name)) continue; // 이번 프로파일 범위 밖
    verdicts.push({
      feature: name,
      verdict: 'FAIL',
      baseline: baseline.features[name].cerAvg,
      cerAvg: null,
      reason: '이번 실행에 없음(부분 측정) — 전체 프로파일로 다시 측정 필요',
    });
  }

  for (const r of rows) {
    const base = baseline.features?.[r.feature];
    const baseCer = base?.cerAvg ?? null;
    const tol = r.tolerance ?? 0.02;
    const noFinals = Number(r.noFinals ?? 0);
    const finalSamples = Number(r.samples ?? 0);
    const maxNoFinalRate = r.maxNoFinalRate ?? 0;

    if (r.skipped) {
      verdicts.push({
        feature: r.feature,
        verdict: baseCer == null || r.gateOptional ? 'SKIP' : 'FAIL',
        baseline: baseCer,
        cerAvg: null,
        reason: baseCer == null ? r.skipped : `기준선이 있는데 측정 안 됨: ${r.skipped}`,
      });
      continue;
    }
    // CER은 텍스트가 도착했을 때의 정확도 지표다. final이 전혀 오지 않아 빈 문자열로
    // 계산된 CER 100%를 단순 "오차 변동"으로 취급하면 임계 완화가 무응답 결함을 숨긴다.
    // 따라서 final 미수신률은 CER 허용오차와 독립된 동작 계약으로 판정한다.
    if (finalSamples && noFinals / finalSamples > maxNoFinalRate + 1e-9) {
      verdicts.push({
        feature: r.feature,
        verdict: r.gateOptional ? 'WARN' : 'FAIL',
        baseline: baseCer,
        cerAvg: r.cerAvg,
        noFinals,
        reason: `final 미수신 ${noFinals}/${finalSamples}건 (허용 ${(maxNoFinalRate * 100).toFixed(0)}%)`,
      });
      continue;
    }
    if (baseCer == null) {
      verdicts.push({ feature: r.feature, verdict: 'NEW', baseline: null, cerAvg: r.cerAvg, reason: '기준선 없음' });
      continue;
    }
    const delta = r.cerAvg - baseCer;
    const pass = delta <= tol + 1e-9;
    // gateOptional 기능은 초과해도 WARN — 외부 서비스 상태를 커밋 통과 조건으로 삼지 않는다
    verdicts.push({
      feature: r.feature,
      verdict: pass ? 'PASS' : r.gateOptional ? 'WARN' : 'FAIL',
      baseline: baseCer,
      cerAvg: r.cerAvg,
      delta: +delta.toFixed(4),
      reason: `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}%p / 허용 ${(tol * 100).toFixed(0)}%p`,
    });
  }

  const failed = verdicts.filter((v) => v.verdict === 'FAIL');
  return {
    verdicts,
    overall: {
      pass: failed.length === 0,
      failed: failed.map((v) => v.feature),
      message: failed.length
        ? `${failed.map((v) => v.feature).join(', ')} 회귀 — 푸시 차단`
        : '모든 기능이 기준선 이하',
    },
  };
}

/** 현재 rows를 기준선으로 승격. */
export function updateBaseline(rows, env) {
  const baseline = loadBaseline();
  baseline.updatedAt = env.at;
  baseline.commit = env.commit;
  baseline.note = '기능별 기준 오류값 — npm run qa:stt -- --update-baseline 으로만 갱신';
  baseline.features = baseline.features ?? {};
  for (const r of rows) {
    if (r.skipped || r.cerAvg == null) continue;
    // 외부 서비스에 좌우되는 기능은 승격하지 않는다 — 서비스 이상 시점의 값(예: CER 100%)이
    // 기준선이 되면 이후 어떤 결과도 통과해 게이트가 무력해진다
    if (r.gateOptional) continue;
    baseline.features[r.feature] = {
      cerAvg: r.cerAvg,
      cerMedian: r.cerMedian,
      samples: r.samples,
      tolerance: r.tolerance,
      at: env.at,
    };
  }
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
  return baseline;
}
