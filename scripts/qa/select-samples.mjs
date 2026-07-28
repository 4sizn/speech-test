#!/usr/bin/env node
/**
 * STT E2E 테스트 사운드 배열 선정.
 *
 * AI Hub 「상황별음성 상담 음성」에서 발화를 결정적으로 골라 stt-e2e/samples.json을 만든다.
 *  - short : 짧은 발화 N개(기본 8) — Provider별 기본 정확도 비교용
 *  - long  : 세션 내 연속 발화를 0.5s 무음으로 이어붙인 35초 내외 2개 — 청킹 전략 회귀 검출용
 *            (짧은 발화로는 안 드러난다: 실측 짧은 발화 27.6% vs 긴 오디오 175.8%)
 *
 * ⚠ 정답 전사(ref) 원문은 저장하지 않는다 — 이 저장소는 public이고 데이터셋은 재배포 제약이 있다.
 *   해시와 길이만 남기고, 실제 ref는 실행 시점에 QA 서버가 로컬 데이터셋에서 읽는다.
 *
 * 사용: node scripts/qa/select-samples.mjs [--short 8] [--long 2]
 *      STT_QA_DATASET=<데이터셋 경로>로 위치 재정의
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import {
  DATASET_ROOT,
  PROJECT_ROOT,
  STT_E2E_DIR,
  normalizeAihubText,
  normalizerFingerprint,
  readWav,
  wavInfo,
} from './lib/dataset.mjs';

const args = process.argv.slice(2);
const numArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const SHORT_COUNT = numArg('short', 8);
const LONG_COUNT = numArg('long', 2);

const refHash = (text) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);

if (!existsSync(DATASET_ROOT)) {
  console.error(`데이터셋을 찾을 수 없습니다: ${DATASET_ROOT}`);
  console.error('STT_QA_DATASET 환경변수로 경로를 지정하세요.');
  process.exit(1);
}

const labelRoot = join(DATASET_ROOT, '라벨링데이터');
const wavRoot = join(DATASET_ROOT, '원천데이터');

/** 세션 목록(라벨 JSON이 있는 디렉터리) — 정렬해 결정적으로 만든다. */
function listSessions() {
  const out = [];
  for (const top of readdirSync(labelRoot).sort()) {
    for (const mid of readdirSync(join(labelRoot, top)).sort()) {
      for (const sid of readdirSync(join(labelRoot, top, mid)).sort()) {
        const dir = join(labelRoot, top, mid, sid);
        if (existsSync(join(dir, `${sid}.json`))) out.push({ sid, dir });
      }
    }
  }
  return out.sort((a, b) => a.sid.localeCompare(b.sid));
}

/** "세션ID/파일명.wav" → 실제 경로 (JSON의 audioPath는 실제 배치와 달라 신뢰하지 않는다) */
function indexWavs() {
  const map = new Map();
  for (const top of readdirSync(wavRoot).sort()) {
    for (const mid of readdirSync(join(wavRoot, top)).sort()) {
      for (const sid of readdirSync(join(wavRoot, top, mid)).sort()) {
        const dir = join(wavRoot, top, mid, sid);
        for (const f of readdirSync(dir).sort()) {
          if (f.endsWith('.wav')) map.set(`${sid}/${f}`, join(dir, f));
        }
      }
    }
  }
  return map;
}

const sessions = listSessions();
const wavBySuffix = indexWavs();
console.log(`데이터셋: 세션 ${sessions.length}개 · wav ${wavBySuffix.size}개`);

// ── short: 세션을 고르게 훑어 세션당 최대 2발화 ──────────────────────────
const stride = Math.max(1, Math.floor(sessions.length / 30));
const shortItems = [];
for (const s of sessions.filter((_, i) => i % stride === 0)) {
  if (shortItems.length >= SHORT_COUNT) break;
  let perSession = 0;
  for (const f of readdirSync(s.dir).sort()) {
    if (shortItems.length >= SHORT_COUNT || perSession >= 2) break;
    if (!f.endsWith('.txt')) continue;
    const uttId = f.replace(/\.txt$/, '');
    const wavPath = wavBySuffix.get(`${s.sid}/${uttId}.wav`);
    if (!wavPath) continue;
    const ref = normalizeAihubText(readFileSync(join(s.dir, f), 'utf8'));
    if (ref.length < 20 || ref.length > 120) continue;
    const { sampleRate, sec } = wavInfo(wavPath);
    if (sec < 2 || sec > 10) continue;
    shortItems.push({
      id: `${s.sid}/${uttId}`,
      set: 'short',
      kind: 'utterance',
      relPath: relative(DATASET_ROOT, wavPath),
      refPath: relative(DATASET_ROOT, join(s.dir, f)),
      refHash: refHash(ref),
      refLength: ref.length,
      sec: +sec.toFixed(2),
      sampleRate,
    });
    perSession++;
  }
}

// ── long: short에 쓰지 않은 세션에서 연속 발화를 이어붙인다 ────────────────
const usedSessions = new Set(shortItems.map((i) => i.id.split('/')[0]));
const longItems = [];
for (const s of sessions) {
  if (longItems.length >= LONG_COUNT) break;
  if (usedSessions.has(s.sid)) continue;
  const parts = [];
  let totalSec = 0;
  for (const f of readdirSync(s.dir).sort()) {
    if (totalSec >= 35) break;
    if (!f.endsWith('.txt')) continue;
    const uttId = f.replace(/\.txt$/, '');
    const wavPath = wavBySuffix.get(`${s.sid}/${uttId}.wav`);
    if (!wavPath) continue;
    const ref = normalizeAihubText(readFileSync(join(s.dir, f), 'utf8'));
    if (!ref) continue;
    const { sec } = wavInfo(wavPath);
    if (sec > 12) continue;
    parts.push({ uttId, relPath: relative(DATASET_ROOT, wavPath), refPath: relative(DATASET_ROOT, join(s.dir, f)), sec: +sec.toFixed(2) });
    totalSec += sec + 0.5; // 발화 사이 0.5s 무음
  }
  if (parts.length < 4 || totalSec < 25) continue;
  // 이어붙인 참조 = 각 발화 전사를 공백으로 연결 (서버가 실행 시점에 같은 규칙으로 재구성)
  const joinedRef = parts
    .map((p) => normalizeAihubText(readFileSync(join(DATASET_ROOT, p.refPath), 'utf8')))
    .join(' ');
  longItems.push({
    id: `long/${s.sid}`,
    set: 'long',
    kind: 'concat',
    parts, // 러너/서버가 이 순서로 이어붙인다(0.5s 무음 삽입)
    gapSec: 0.5,
    refHash: refHash(joinedRef),
    refLength: joinedRef.length,
    sec: +totalSec.toFixed(2),
    utterances: parts.length,
    sampleRate: readWav(join(DATASET_ROOT, parts[0].relPath)).sampleRate,
  });
}

const items = [...shortItems, ...longItems];
if (shortItems.length < SHORT_COUNT || longItems.length < LONG_COUNT) {
  console.warn(
    `⚠ 목표 미달 — short ${shortItems.length}/${SHORT_COUNT} · long ${longItems.length}/${LONG_COUNT}`,
  );
}

mkdirSync(STT_E2E_DIR, { recursive: true });
const out = {
  generatedBy: 'scripts/qa/select-samples.mjs',
  datasetName: 'aihub_call_center_dataset (AI Hub 상황별음성 상담 음성 / KtelSpeech)',
  note: '정답 전사 원문은 저장하지 않는다(재배포 제약). refHash/refLength만 기록하고 실행 시점에 로컬 데이터셋에서 읽는다.',
  // 프로덕션 어댑터의 normalizeAihubText 본문 해시 — 규칙이 바뀌면 러너가 경고한다
  normalizerFingerprint: normalizerFingerprint(),
  short: SHORT_COUNT,
  long: LONG_COUNT,
  items,
};
writeFileSync(join(STT_E2E_DIR, 'samples.json'), JSON.stringify(out, null, 2) + '\n');

const totalSec = items.reduce((a, b) => a + b.sec, 0);
console.log(`\nstt-e2e/samples.json 작성 — ${items.length}개 (short ${shortItems.length} · long ${longItems.length})`);
console.log(`총 재생 길이 ${totalSec.toFixed(1)}초 · 세션 ${new Set(items.map((i) => i.id.split('/')[0])).size}개`);
console.log(`참조 길이 평균 ${Math.round(items.reduce((a, b) => a + b.refLength, 0) / items.length)}자`);
for (const i of items) {
  console.log(`  ${i.set.padEnd(5)} ${i.id.padEnd(20)} ${String(i.sec).padStart(6)}s  ref ${String(i.refLength).padStart(3)}자  ${i.sampleRate}Hz`);
}
console.log(`\n프로젝트 루트: ${PROJECT_ROOT}`);
