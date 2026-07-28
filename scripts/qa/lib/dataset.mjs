/**
 * QA 스크립트 공용 — 데이터셋 경로·WAV 처리·전사 정규화.
 *
 * 전사 정규화는 프로덕션 어댑터(src/datasets/adapters/AihubCallCenterAdapter.ts의
 * normalizeAihubText)와 **같은 규칙**이어야 한다. 갈라지면 QA의 CER과 앱 화면의 CER이
 * 달라져 기준선이 의미를 잃는다. TS는 Node에서 직접 import할 수 없어 재구현하고,
 * 어댑터 쪽 함수 본문 해시를 기록해 규칙이 바뀌면 감지한다(assertNormalizerInSync).
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const STT_E2E_DIR = join(PROJECT_ROOT, 'stt-e2e');
export const STT_E2E_LOCAL_DIR = join(STT_E2E_DIR, '.local');
export const DATASET_ROOT =
  process.env.STT_QA_DATASET ||
  resolve(PROJECT_ROOT, '..', 'aihub_call_center_dataset');

const ADAPTER_PATH = join(PROJECT_ROOT, 'src/datasets/adapters/AihubCallCenterAdapter.ts');

/**
 * 전사 원문 → 평가용 문장.
 * 규칙(어댑터와 동일): (표기)/(발음)→표기 · n/ u/ b/ o/ 태그 제거 · 간투어 '아/'→'아' · @ + 제거
 */
export function normalizeAihubText(raw) {
  return (raw || '')
    .replace(/\(([^)]*)\)\/\(([^)]*)\)/g, '$1')
    .replace(/(^|\s)[a-z]+\//g, '$1')
    .replace(/([가-힣])\//g, '$1')
    .replace(/[@+]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 어댑터의 normalizeAihubText 본문 해시 — 규칙 변경 감지용. */
export function normalizerFingerprint() {
  if (!existsSync(ADAPTER_PATH)) return null;
  const src = readFileSync(ADAPTER_PATH, 'utf8');
  const m = src.match(/export function normalizeAihubText[\s\S]*?\n}/);
  if (!m) return null;
  const body = m[0].replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12);
}

/**
 * 기록된 지문과 현재 어댑터를 비교한다.
 * @returns {{ ok: boolean, expected: string|null, actual: string|null }}
 */
export function assertNormalizerInSync(expected) {
  const actual = normalizerFingerprint();
  return { ok: !expected || !actual || expected === actual, expected, actual };
}

/** WAV에서 포맷과 PCM 데이터를 뽑는다. */
export function readWav(path) {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`WAV 아님: ${path}`);
  const sampleRate = buf.readUInt32LE(24);
  const channels = buf.readUInt16LE(22);
  const bits = buf.readUInt16LE(34);
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      return { sampleRate, channels, bits, pcm: buf.subarray(off + 8, off + 8 + size) };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error(`data 청크 없음: ${path}`);
}

/** 헤더만 읽어 길이/샘플레이트 확인(전체 로드 없이). */
export function wavInfo(path) {
  const { sampleRate, channels, bits, pcm } = readWav(path);
  const byteRate = (sampleRate * channels * bits) / 8;
  return { sampleRate, channels, bits, sec: pcm.length / byteRate };
}

/** PCM 버퍼 → WAV 파일 바이트. */
export function buildWav(pcm, sampleRate, channels, bits) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * channels * bits) / 8, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** samples.json의 항목 → { wav: Buffer, ref: string } (long이면 부분들을 무음으로 이어붙인다) */
export function materializeSample(item) {
  if (item.kind === 'concat') {
    const chunks = [];
    const refs = [];
    let fmt = null;
    for (const p of item.parts) {
      const w = readWav(join(DATASET_ROOT, p.relPath));
      fmt = fmt ?? w;
      chunks.push(w.pcm);
      const gapBytes = Math.round(w.sampleRate * (item.gapSec ?? 0.5)) * ((w.channels * w.bits) / 8);
      chunks.push(Buffer.alloc(gapBytes));
      refs.push(normalizeAihubText(readFileSync(join(DATASET_ROOT, p.refPath), 'utf8')));
    }
    return {
      wav: buildWav(Buffer.concat(chunks), fmt.sampleRate, fmt.channels, fmt.bits),
      ref: refs.join(' '),
    };
  }
  const w = readWav(join(DATASET_ROOT, item.relPath));
  return {
    wav: buildWav(w.pcm, w.sampleRate, w.channels, w.bits),
    ref: normalizeAihubText(readFileSync(join(DATASET_ROOT, item.refPath), 'utf8')),
  };
}

export function refHash(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

/** samples.json 로드 + refHash 검증 → { samples, mismatches } */
export function loadSamples() {
  const path = join(STT_E2E_DIR, 'samples.json');
  if (!existsSync(path)) throw new Error(`samples.json이 없습니다 — npm run qa:samples 먼저 실행하세요`);
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const mismatches = [];
  for (const item of doc.items) {
    const { ref } = materializeSample(item);
    const h = refHash(ref);
    if (h !== item.refHash) mismatches.push({ id: item.id, expected: item.refHash, actual: h });
  }
  return { doc, mismatches };
}
