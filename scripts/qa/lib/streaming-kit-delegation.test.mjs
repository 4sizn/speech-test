import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const providerPath = fileURLToPath(new URL('../../../src/providers/StreamingAsrProvider.ts', import.meta.url));
const source = await readFile(providerPath, 'utf8');

assert.match(
  source,
  /import\s*\{\s*StreamingAsrProvider as KitStreamingAsrProvider\s*\}\s*from '@rsupport\/rvs-stt-kit\/streaming';/,
  'speech-test Streaming adapter must delegate PCM/WebSocket transport to the UML-approved kit implementation',
);
assert.match(
  source,
  /createPcmTap:\s*createAudioPcmTapPort/,
  'adapter must keep the speech-test AudioPcmTap capture path when delegating the socket transport',
);
assert.match(source, /new KitStreamingAsrProvider\(/, 'adapter must construct the kit transport');
assert.match(source, /sourceKind: input\.mode === Mode\.MIC \? 'device-mic' : 'captured-track'/, 'adapter must preserve UML AudioSourcePort source ownership');
assert.match(source, /stream: input\.stream/, 'adapter must pass the engine-created stream to kit transport');

console.log('streaming kit delegation contract: PASS');
