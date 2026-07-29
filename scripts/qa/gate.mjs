#!/usr/bin/env node
/**
 * 게이트 검사 — 측정을 다시 하지 않고 "최신 결과지"만으로 푸시 가능 여부를 판정한다.
 * pre-push 훅과 `npm run qa:gate`가 같은 경로를 쓴다.
 *
 * 통과 조건
 *  1. 최신 결과지의 전체 판정이 PASS
 *  2. 그 결과지가 **지금 소스로** 측정된 것 (감시 경로 해시 일치)
 *  3. 샘플 정답(refHash)과 전사 정규화 규칙이 그대로
 */
import { dirname } from 'node:path';
import { latestSummary, writeSummary } from './lib/report.mjs';
import { sourceHashes, diffHashes, WATCHED_PATHS, updateBaseline, judge, loadBaseline } from './lib/gate.mjs';
import { assertNormalizerInSync, loadSamples } from './lib/dataset.mjs';
import { buildFeatures } from './lib/features.mjs';

const quiet = process.argv.includes('--quiet');
/** 재측정 없이 최신 결과지를 기준선으로 승격 — 첫 기준선 확립이나 의도된 변화 반영용 */
const promote = process.argv.includes('--promote');
/**
 * 기준선은 그대로 두고 **현재 정책(features.mjs의 tolerance/gateOptional)** 으로만 다시 판정한다.
 * 허용 오차를 재현성에 맞게 조정했을 때, 40분짜리 재측정 없이 기존 결과지에 반영하기 위한 경로.
 * 측정값을 건드리지 않으므로 회귀를 감추는 데 쓸 수 없다(기준선도 그대로다).
 */
const rejudge = process.argv.includes('--rejudge');
const say = (...a) => !quiet && console.log(...a);
const fail = (msg, hint) => {
  console.error(`\n✗ STT QA 게이트: ${msg}`);
  if (hint) console.error(`  → ${hint}`);
  process.exit(1);
};

const latest = latestSummary();
if (!latest) {
  fail('결과지가 없습니다', 'npm run qa:stt 를 실행해 측정하세요');
}

const { doc, stamp, path } = latest;
say(`최신 결과지: ${path.replace(process.cwd() + '/', '')} (${stamp}, profile ${doc.env?.profile ?? '?'})`);

// 결과지에 박힌 tolerance/gateOptional은 측정 시점의 정책이다. 판정에는 **현재 정책**을 쓴다.
const currentPolicy = new Map(buildFeatures(doc.env?.profile ?? 'quick').map((f) => [f.feature, f]));
for (const r of doc.rows ?? []) {
  const p = currentPolicy.get(r.feature);
  if (!p) continue;
  r.tolerance = p.tolerance ?? r.tolerance;
  r.gateOptional = p.gateOptional ?? false;
}

if (rejudge) {
  const rj = judge(doc.rows ?? [], loadBaseline(), doc.env?.planFeatures);
  writeSummary({ dir: dirname(path), stamp, rows: doc.rows ?? [], verdicts: rj.verdicts, env: doc.env, overall: rj.overall });
  console.log(`현재 정책으로 재판정: ${rj.overall.pass ? 'PASS' : 'FAIL'} — ${rj.overall.message}`);
  for (const v of rj.verdicts.filter((v) => v.verdict !== 'PASS')) {
    console.log(`  ${v.verdict.padEnd(5)} ${v.feature.padEnd(22)} ${v.reason ?? ''}`);
  }
  process.exit(rj.overall.pass ? 0 : 1);
}

if (promote) {
  const measured = (doc.rows ?? []).filter((r) => !r.skipped && r.cerAvg != null);
  if (!measured.length) fail('승격할 측정값이 없습니다');
  updateBaseline(measured, doc.env ?? { at: new Date().toISOString() });
  const promoted = measured.filter((r) => !r.gateOptional);
  console.log(`기준선 승격 완료 — ${promoted.length}개 기능 (stt-e2e/baseline.json)`);
  for (const r of promoted) console.log(`  ${r.feature.padEnd(22)} ${(r.cerAvg * 100).toFixed(1)}%`);
  for (const r of measured.filter((r) => r.gateOptional)) {
    console.log(`  ${r.feature.padEnd(22)} ${(r.cerAvg * 100).toFixed(1)}%  ← 승격 제외(gateOptional · 외부 서비스 의존)`);
  }

  // 결과지의 판정도 새 기준선으로 다시 계산해 저장한다 — 승격한 결과지는 정의상 PASS이고,
  // 측정 당시 판정을 그대로 두면 게이트가 계속 옛 판정을 읽어 FAIL로 막는다.
  const rejudged = judge(doc.rows ?? [], loadBaseline(), doc.env?.planFeatures);
  writeSummary({
    dir: dirname(path),
    stamp,
    rows: doc.rows ?? [],
    verdicts: rejudged.verdicts,
    env: doc.env,
    overall: rejudged.overall,
  });
  console.log(`결과지 판정 재계산: ${rejudged.overall.pass ? 'PASS' : 'FAIL'} — ${path.replace(process.cwd() + '/', '')}`);
  process.exit(rejudged.overall.pass ? 0 : 1);
}

// 1) 판정
if (!doc.overall?.pass) {
  fail(`최신 결과지가 FAIL — ${doc.overall?.message ?? ''}`, '회귀를 고치고 npm run qa:stt 를 다시 실행하세요');
}

// 2) 소스 일치 — 측정 후 코드를 더 고치고 푸시하는 것을 막는다
const current = sourceHashes();
const changed = diffHashes(doc.env?.sourceHashes ?? {}, current);
if (changed.length) {
  console.error(`\n✗ STT QA 게이트: 측정 이후 소스가 바뀌었습니다(${changed.length}개)`);
  for (const c of changed.slice(0, 10)) console.error(`    ${c}`);
  if (changed.length > 10) console.error(`    … 외 ${changed.length - 10}개`);
  console.error(`  → 감시 경로: ${WATCHED_PATHS.join(', ')}`);
  console.error('  → npm run qa:stt 로 현재 소스를 다시 측정하세요');
  process.exit(1);
}

// 3) 기준 데이터 동일성
const { doc: samples, mismatches } = loadSamples();
if (mismatches.length) fail(`샘플 정답이 바뀌었습니다(${mismatches.length}건)`, 'npm run qa:samples 로 다시 뽑고 재측정하세요');
const norm = assertNormalizerInSync(samples.normalizerFingerprint);
if (!norm.ok) fail('전사 정규화 규칙이 바뀌었습니다', 'npm run qa:samples 로 다시 뽑고 재측정하세요');

const rows = doc.rows ?? [];
const measured = rows.filter((r) => !r.skipped).length;
say(`✓ 게이트 통과 — 기능 ${rows.length}개(측정 ${measured}) · ${doc.overall.message}`);
if (doc.env?.dirty) say('  ⚠ 측정 시점 워킹트리가 dirty였습니다(커밋 전 측정).');
process.exit(0);
