import * as assert from 'node:assert/strict';
import { SttEngine } from '@rsupport/rvs-stt-kit';
import { STREAMING_ENDPOINT_PRESETS } from '@rsupport/rvs-stt-kit/streaming';

assert.equal(typeof SttEngine, 'function');
assert.equal(STREAMING_ENDPOINT_PRESETS.fasterWhisper.endpoint, 'ws://localhost:8765');
assert.equal(STREAMING_ENDPOINT_PRESETS.whisperStreaming.endpoint, 'ws://localhost:8768');
assert.equal(STREAMING_ENDPOINT_PRESETS.funAsr.endpoint, 'ws://localhost:8766');
assert.equal(STREAMING_ENDPOINT_PRESETS.senseVoice.endpoint, 'ws://localhost:8767');

console.log('rvs-stt-kit local package surface verified');
