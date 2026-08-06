import * as assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const providerPath = fileURLToPath(new URL('../../../src/providers/StreamingAsrProvider.ts', import.meta.url));
const source = await readFile(providerPath, 'utf8');
const selector = source.match(/key: 'wsEndpoint',[\s\S]*?options: \[([\s\S]*?)\],\n\s*hint:/);
const genericConfig = source.match(/static override readonly configSchema:[\s\S]*?= \[([\s\S]*?)\n  \];/);

assert.ok(selector, 'generic Streaming ASR must declare its WebSocket engine selector');
assert.ok(genericConfig, 'generic Streaming ASR must declare its configuration');
assert.match(selector[1], /streamingEndpoints\.fasterWhisper/, 'generic Streaming ASR must retain faster-whisper');
assert.match(selector[1], /streamingEndpoints\.whisperStreaming/, 'generic Streaming ASR must retain whisper-streaming');
assert.doesNotMatch(
  selector[1],
  /streamingEndpoints\.funAsr/,
  'FunASR must be exposed only through the dedicated FunASR provider, not duplicated in generic Streaming ASR',
);
assert.doesNotMatch(
  genericConfig[1],
  /whisper-streaming\|funasr/,
  'generic Streaming ASR setup guidance must not advertise the dedicated FunASR engine',
);

console.log('streaming provider options: generic engines are distinct from dedicated FunASR');
