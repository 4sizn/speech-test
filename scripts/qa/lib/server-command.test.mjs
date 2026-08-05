import assert from 'node:assert/strict';
import { fasterWhisperCommand, fasterWhisperModelFromArgs } from './server-command.mjs';

const defaultCommand = fasterWhisperCommand({ script: '/repo/server/realtime_asr_server.py', port: 8765 });
assert.deepEqual(defaultCommand, [
  '/repo/server/realtime_asr_server.py', '--engine', 'faster-whisper', '--port', '8765',
]);

const controlledCommand = fasterWhisperCommand({
  script: '/repo/server/realtime_asr_server.py', port: 8765, model: 'small', maxUtteranceSec: 15,
});
assert.deepEqual(controlledCommand, [
  '/repo/server/realtime_asr_server.py', '--engine', 'faster-whisper', '--port', '8765', '--model', 'small', '--max-utterance-sec', '15',
]);

// RED regression: a controlled A/B run must be able to name the exact model
// instead of silently inheriting whichever server default happens to be live.
assert.equal(fasterWhisperModelFromArgs(['--faster-whisper-model', 'base']), 'base');
assert.equal(fasterWhisperModelFromArgs([]), undefined);
assert.throws(() => fasterWhisperModelFromArgs(['--faster-whisper-model']), /requires a model/);
assert.throws(() => fasterWhisperModelFromArgs(['--faster-whisper-model', 'small;rm']), /invalid faster-whisper model/);

assert.throws(
  () => fasterWhisperCommand({ script: '/repo/server/realtime_asr_server.py', port: 8765, model: 'small;rm -rf /' }),
  /invalid faster-whisper model/,
);

console.log('server-command: controlled faster-whisper model command is explicit and validated');
