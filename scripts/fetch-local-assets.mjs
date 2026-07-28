#!/usr/bin/env node
/**
 * local-client 자산 준비 스크립트.
 *
 * Whisper Provider는 실행 위치가 local-client — 인식 연산뿐 아니라 코드/모델 자산도
 * 별도 도메인 없이 자체 출처(same-origin)에서 받아 관리한다. 이 스크립트가 그 자산을 준비한다:
 *   public/ort/     ← onnxruntime-web WASM 런타임 (node_modules에서 복사)
 *   public/models/  ← Whisper 모델 가중치 (Hugging Face에서 1회 다운로드 후 자체 서빙)
 *
 * 사용:  node scripts/fetch-local-assets.mjs [모델ID ...] [--webgpu]
 *   모델ID 생략 시 UI가 제공하는 3종(tiny/base/small)을 모두 받는다.
 *   --webgpu : WebGPU용 fp32 가중치도 함께 받는다(용량 큼). 기본은 WASM(q8)용만.
 */
import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MODELS = ['Xenova/whisper-tiny', 'Xenova/whisper-base', 'Xenova/whisper-small'];

const args = process.argv.slice(2);
const webgpu = args.includes('--webgpu');
const models = args.filter((a) => !a.startsWith('--'));
const targets = models.length ? models : DEFAULT_MODELS;

// ── 1) ONNX 런타임 WASM 복사 ─────────────────────────────────────────
// transformers.js dist에 동봉된(버전 매칭 보장) 런타임을 복사한다
const ortSrc = path.join(root, 'node_modules/@huggingface/transformers/dist');
const ortDst = path.join(root, 'public/ort');
await mkdir(ortDst, { recursive: true });
let copied = 0;
for (const f of await readdir(ortSrc)) {
  if (/^ort-wasm-simd-threaded.*\.(wasm|mjs)$/.test(f)) {
    await copyFile(path.join(ortSrc, f), path.join(ortDst, f));
    copied++;
  }
}
console.log(`[ort] WASM 런타임 ${copied}개 복사 → public/ort/`);

// ── 2) 모델 가중치 다운로드 ──────────────────────────────────────────
const META_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
];
// transformers.js whisper: encoder + merged decoder. q8(WASM 기본) = *_quantized.onnx
const onnxFiles = (gpu) =>
  gpu
    ? ['onnx/encoder_model.onnx', 'onnx/decoder_model_merged.onnx']
    : ['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'];

async function fetchFile(model, file) {
  const dst = path.join(root, 'public/models', model, file);
  const exists = await stat(dst).then((s) => s.size > 0).catch(() => false);
  if (exists) {
    console.log(`  = ${file} (이미 있음)`);
    return;
  }
  await mkdir(path.dirname(dst), { recursive: true });
  const url = `https://huggingface.co/${model}/resolve/main/${file}`;
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url} → HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dst));
  const size = (await stat(dst)).size;
  console.log(`  ↓ ${file} (${(size / 1024 / 1024).toFixed(1)}MB)`);
}

for (const model of targets) {
  console.log(`[model] ${model}`);
  for (const f of [...META_FILES, ...onnxFiles(false), ...(webgpu ? onnxFiles(true) : [])]) {
    await fetchFile(model, f);
  }
}

// ── 3) 웹폰트 자체 서빙 ──────────────────────────────────────────────
// Google Fonts CSS를 받아 woff2를 public/fonts/로 내려받고, URL을 로컬로 재작성한
// fonts.css를 생성한다 (index.html이 /fonts/fonts.css를 참조).
const FONT_CSS_URL =
  'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&family=IBM+Plex+Mono:wght@400;500;600&display=swap';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const fontDir = path.join(root, 'public/fonts');
await mkdir(fontDir, { recursive: true });
let css = await (await fetch(FONT_CSS_URL, { headers: { 'User-Agent': UA } })).text();
const fontUrls = [...new Set(css.match(/https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2/g) ?? [])];
for (const u of fontUrls) {
  const name = u.split('/').slice(-2).join('-'); // <family-dir>-<file>.woff2 로 유일화
  const dst = path.join(fontDir, name);
  const exists = await stat(dst).then((s) => s.size > 0).catch(() => false);
  if (!exists) {
    const res = await fetch(u, { headers: { 'User-Agent': UA } });
    if (!res.ok || !res.body) throw new Error(`${u} → HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dst));
  }
  css = css.replaceAll(u, `/fonts/${name}`);
}
await writeFile(path.join(fontDir, 'fonts.css'), css);
console.log(`[fonts] woff2 ${fontUrls.length}개 + fonts.css → public/fonts/`);

console.log('완료 — 이후 앱은 외부 도메인 접근 없이 same-origin 자산만 사용합니다.');
