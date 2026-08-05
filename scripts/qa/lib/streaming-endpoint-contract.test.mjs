import * as assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { STREAMING_ENDPOINT_PRESETS } from '@rsupport/rvs-stt-kit/streaming';
import { buildFeatures } from './features.mjs';

const sourcePath = fileURLToPath(new URL('./features.mjs', import.meta.url));
const source = await readFile(sourcePath, 'utf8');
const features = buildFeatures('quick');

for (const [featureName, preset] of [
  ['streaming-file', STREAMING_ENDPOINT_PRESETS.fasterWhisper],
  ['streaming-mic', STREAMING_ENDPOINT_PRESETS.fasterWhisper],
  ['sensevoice-file', STREAMING_ENDPOINT_PRESETS.senseVoice],
  ['sensevoice-mic', STREAMING_ENDPOINT_PRESETS.senseVoice],
  ['funasr-file', STREAMING_ENDPOINT_PRESETS.funAsr],
]) {
  const feature = features.find(({ feature }) => feature === featureName);
  assert.ok(feature, `${featureName} must exist`);
  assert.equal(feature.config.wsEndpoint, preset.endpoint, `${featureName} endpoint must equal its kit preset`);
}

assert.ok(
  source.includes("from '@rsupport/rvs-stt-kit/streaming';"),
  'QA endpoint configs must import rvs-stt-kit presets rather than retain legacy endpoint literals',
);
assert.doesNotMatch(source, /ws:\/\/localhost:(8765|8766|8767|8768)/, 'QA endpoint configs must not retain legacy endpoint literals');

console.log('streaming QA endpoint contract verified');
