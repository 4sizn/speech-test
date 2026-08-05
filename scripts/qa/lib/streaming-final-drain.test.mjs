import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const helperPath = fileURLToPath(new URL('../../../src/providers/streamingFinalDrain.ts', import.meta.url));
const source = await readFile(helperPath, 'utf8');

// Regression lock: serial server inference can leave a final behind queued partials.
// A six-second client drain closes that socket before its final arrives, producing
// a blank hypothesis (CER 100%) even though the server later completes inference.
assert.match(
  source,
  /FINAL_DRAIN_TIMEOUT_MS = 20_000/,
  'default drain must outlast the observed serial-inference final queue',
);
assert.match(source, /clearTimeout\(timeout\)/, 'server close must cancel the fallback timer');

console.log('streaming-final-drain: default protects queued server finals');
