/**
 * 이벤트 JSONL → 기능별 결과지(stt-e2e/<yyyy-mm-dd>/<기능>.json) + summary.
 *
 * 커밋되는 결과지에는 오류 수치만 담는다. 정답 전사·인식 결과 원문은 재배포 제약이 있어
 * stt-e2e/.local/<날짜>/<기능>.detail.json 으로 분리한다(gitignore).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { STT_E2E_DIR, STT_E2E_LOCAL_DIR } from './dataset.mjs';

export function todayStamp(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 3600 * 1000); // 결과지는 KST 날짜로 묶는다
  return kst.toISOString().slice(0, 10);
}

const median = (nums) => {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** JSONL을 읽어 기능별로 묶는다. */
export function parseEvents(eventsPath) {
  const events = readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  const features = new Map();
  const ensure = (name) => {
    if (!features.has(name)) {
      features.set(name, { feature: name, meta: null, items: [], skips: [], errors: [] });
    }
    return features.get(name);
  };

  let runStart = null;
  for (const e of events) {
    if (e.t === 'run-start') runStart = e;
    else if (e.t === 'feature-start') ensure(e.feature).meta = e;
    else if (e.t === 'item') ensure(e.feature).items.push(e);
    else if (e.t === 'feature-skip') ensure(e.feature).skips.push(e);
    else if (e.t === 'feature-error') ensure(e.feature).errors.push(e);
  }
  return { runStart, features: [...features.values()] };
}

/**
 * 결과지 작성.
 * @param {object} opts
 * @param {string} opts.eventsPath
 * @param {object} opts.env      환경 정보(커밋/해시/서버/자산 등)
 * @param {object[]} opts.plan   실행 계획(features.mjs)
 * @returns {{ dir: string, summary: object }}
 */
export function writeReport({ eventsPath, env, plan }) {
  const { runStart, features } = parseEvents(eventsPath);
  const stamp = todayStamp();
  const dir = join(STT_E2E_DIR, stamp);
  const localDir = join(STT_E2E_LOCAL_DIR, stamp);
  mkdirSync(dir, { recursive: true });
  mkdirSync(localDir, { recursive: true });

  const planByName = new Map(plan.map((p) => [p.feature, p]));
  const rows = [];

  for (const f of features) {
    const p = planByName.get(f.feature) ?? {};
    const measured = f.items.filter((i) => typeof i.cer === 'number');
    const rates = measured.map((i) => i.cer);
    const skipped = f.skips.length ? f.skips.map((s) => s.reason).join(' / ') : null;

    const run = {
      at: env.at,
      commit: env.commit,
      dirty: env.dirty,
      profile: runStart?.profile ?? null,
      env: env.snapshot,
      sourceHashes: env.sourceHashes,
      cerAvg: rates.length ? +(rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(4) : null,
      cerMedian: rates.length ? +median(rates).toFixed(4) : null,
      cerWorst: rates.length ? +Math.max(...rates).toFixed(4) : null,
      msAvg: measured.length ? Math.round(measured.reduce((a, b) => a + (b.ms ?? 0), 0) / measured.length) : null,
      samples: measured.length,
      skipped,
      items: measured.map((i) => ({
        id: i.id,
        sec: i.sec,
        cer: i.cer,
        distance: i.distance,
        refLength: i.refLength,
        hypLength: i.hypLength,
        ms: i.ms,
        finals: i.finals,
        partials: i.partials,
        timedOut: i.timedOut || false,
        errors: i.errors?.length ? i.errors : undefined,
      })),
    };

    // 기능별 결과지(커밋 대상) — 같은 날 재실행은 runs[]에 누적
    const filePath = join(dir, `${f.feature}.json`);
    const doc = existsSync(filePath)
      ? JSON.parse(readFileSync(filePath, 'utf8'))
      : {
          feature: f.feature,
          provider: p.provider ?? f.meta?.provider ?? null,
          mode: p.mode ?? f.meta?.mode ?? null,
          location: p.location ?? f.meta?.location ?? null,
          config: p.config ?? f.meta?.config ?? {},
          note: p.note ?? null,
          tolerance: p.tolerance ?? null,
          runs: [],
        };
    doc.runs.push(run);
    writeFileSync(filePath, JSON.stringify(doc, null, 2) + '\n');

    // 원문 상세(로컬 전용)
    writeFileSync(
      join(localDir, `${f.feature}.detail.json`),
      JSON.stringify(
        {
          feature: f.feature,
          at: env.at,
          items: f.items.map((i) => ({ id: i.id, cer: i.cer, ref: i.ref, hyp: i.hyp, errors: i.errors, error: i.error })),
        },
        null,
        2,
      ) + '\n',
    );

    rows.push({
      feature: f.feature,
      samples: run.samples,
      cerAvg: run.cerAvg,
      cerMedian: run.cerMedian,
      cerWorst: run.cerWorst,
      msAvg: run.msAvg,
      skipped,
      note: p.note ?? null,
      tolerance: p.tolerance ?? 0.02,
      gateOptional: p.gateOptional ?? false,
      runsInDoc: doc.runs.length,
      prev: doc.runs.length > 1 ? doc.runs[doc.runs.length - 2].cerAvg : null,
    });
  }

  return { dir, localDir, stamp, rows, runStart };
}

/** 판정 결과까지 반영한 summary.md / summary.json 작성. */
export function writeSummary({ dir, stamp, rows, verdicts, env, overall }) {
  const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
  const lines = [];
  lines.push(`# STT E2E 결과지 — ${stamp} ${env.at.slice(11, 16)} (profile: ${env.profile})`);
  lines.push('');
  lines.push(`환경: ${env.envLine}`);
  lines.push(`커밋: ${env.commit}${env.dirty ? ' (dirty)' : ''}`);
  lines.push('마이크 모드는 파일 주입 가짜 마이크(getUserMedia 오버라이드)로 측정 — 물리 마이크·잡음은 검증 범위 밖.');
  lines.push('');
  lines.push('| 기능 | 샘플 | CER 평균 | 중앙값 | 최악 | 평균 지연 | 기준선 | 직전 | 판정 |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const v = verdicts.find((x) => x.feature === r.feature) ?? {};
    const reason = v.reason ? ` (${v.reason})` : '';
    lines.push(
      `| ${r.feature} | ${r.skipped ? '—' : r.samples} | ${pct(r.cerAvg)} | ${pct(r.cerMedian)} | ${pct(r.cerWorst)} | ${r.msAvg == null ? '—' : `${(r.msAvg / 1000).toFixed(1)}s`} | ${pct(v.baseline)} | ${pct(r.prev)} | ${v.verdict ?? '—'}${reason} |`,
    );
  }
  lines.push('');
  lines.push(`전체: **${overall.pass ? 'PASS' : 'FAIL'}** — ${overall.message}`);
  lines.push('');
  const notes = rows.filter((r) => r.note);
  if (notes.length) {
    lines.push('## 비고');
    for (const r of notes) lines.push(`- ${r.feature}: ${r.note}`);
    lines.push('');
  }
  lines.push('발화별 오류값은 같은 폴더의 `<기능>.json`(runs[].items) 참조.');
  lines.push('인식 결과·정답 원문 대조는 `stt-e2e/.local/<날짜>/<기능>.detail.json`(커밋 제외).');
  lines.push('');

  writeFileSync(join(dir, 'summary.md'), lines.join('\n'));
  writeFileSync(
    join(dir, 'summary.json'),
    JSON.stringify({ stamp, env, rows, verdicts, overall }, null, 2) + '\n',
  );
  return lines.join('\n');
}

/** 가장 최근 결과지 폴더의 summary.json */
export function latestSummary() {
  if (!existsSync(STT_E2E_DIR)) return null;
  const dates = readdirSync(STT_E2E_DIR)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .reverse();
  for (const d of dates) {
    const p = join(STT_E2E_DIR, d, 'summary.json');
    if (existsSync(p)) return { path: p, stamp: d, doc: JSON.parse(readFileSync(p, 'utf8')) };
  }
  return null;
}
