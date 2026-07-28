#!/usr/bin/env node
/**
 * QA 서버 — 하네스에 테스트 계획·오디오를 주고, 결과 이벤트를 파일로 받는다.
 *
 *   GET  /manifest.json   기능 목록 + 샘플 목록(정답 전사 포함 — 로컬 통신 전용)
 *   GET  /audio/<id>.wav  데이터셋에서 즉시 만들어 서빙(long은 무음으로 이어붙임)
 *   POST /event           하네스가 보내는 진행/결과 이벤트 → JSONL append
 *   GET  /health
 *
 * 결과를 브라우저 window에 쌓지 않고 POST로 받는 이유: WASM 추론이 메인 스레드를 점유하면
 * CDP 평가가 타임아웃되어 결과를 회수할 수 없다.
 */
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STT_E2E_LOCAL_DIR, loadSamples, materializeSample } from './lib/dataset.mjs';
import { buildFeatures } from './lib/features.mjs';

export const DEFAULT_PORT = 8899;

/**
 * @param {object} opts
 * @param {string} opts.profile   'quick' | 'full'
 * @param {number} [opts.limit]   샘플 세트별 최대 개수(--samples)
 * @param {number} [opts.port]
 * @param {string} [opts.eventsPath]
 */
export async function startQaServer({ profile = 'quick', limit, port = DEFAULT_PORT, eventsPath } = {}) {
  const { doc, mismatches } = loadSamples();
  const features = buildFeatures(profile);

  const pick = (set) => {
    const all = doc.items.filter((i) => i.set === set);
    return limit ? all.slice(0, limit) : all;
  };
  const sets = { short: pick('short'), long: pick('long') };

  // 샘플 id → { item, ref } (ref는 실행 시점에 데이터셋에서 읽은 정규화 전사)
  const byId = new Map();
  for (const item of [...sets.short, ...sets.long]) {
    byId.set(item.id, { item, ref: materializeSample(item).ref });
  }

  mkdirSync(STT_E2E_LOCAL_DIR, { recursive: true });
  const events = eventsPath || join(STT_E2E_LOCAL_DIR, `events-${Date.now()}.jsonl`);
  writeFileSync(events, '');

  const manifest = {
    profile,
    normalizerFingerprint: doc.normalizerFingerprint ?? null,
    features,
    sets: {
      short: sets.short.map((i) => ({ id: i.id, sec: i.sec, ref: byId.get(i.id).ref })),
      long: sets.long.map((i) => ({ id: i.id, sec: i.sec, ref: byId.get(i.id).ref })),
    },
  };

  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.end();

    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, features: features.length }));
    }

    if (url.pathname === '/manifest.json') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(manifest));
    }

    if (url.pathname.startsWith('/audio/')) {
      const id = decodeURIComponent(url.pathname.slice('/audio/'.length).replace(/\.wav$/, ''));
      const entry = byId.get(id);
      if (!entry) {
        res.writeHead(404);
        return res.end('unknown sample');
      }
      try {
        const { wav } = materializeSample(entry.item);
        res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length });
        return res.end(wav);
      } catch (err) {
        res.writeHead(500);
        return res.end(String(err));
      }
    }

    if (url.pathname === '/event' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (body) appendFileSync(events, body.replace(/\n/g, ' ') + '\n');
        res.writeHead(200);
        res.end('ok');
      });
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    port,
    eventsPath: events,
    manifest,
    refMismatches: mismatches,
    sampleCount: sets.short.length + sets.long.length,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// CLI 단독 실행(디버깅용) — 러너는 위 함수를 import해서 쓴다
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const val = (n, d) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : d;
  };
  const info = await startQaServer({
    profile: val('profile', 'quick'),
    limit: args.includes('--samples') ? Number(val('samples')) : undefined,
    port: Number(val('port', DEFAULT_PORT)),
  });
  console.log(`QA 서버 http://127.0.0.1:${info.port}`);
  console.log(`  기능 ${info.manifest.features.length}개 · 샘플 ${info.sampleCount}개`);
  console.log(`  이벤트 → ${info.eventsPath}`);
  if (info.refMismatches.length) {
    console.warn(`⚠ refHash 불일치 ${info.refMismatches.length}건 — 데이터셋이 바뀌었을 수 있습니다`);
  }
}
