import assert from 'node:assert/strict';
import { BootstrapProfileResolver } from '../../../src/composition/BootstrapProfileResolver.ts';
import { createEngineBackedSttServiceRuntime } from '../../../src/composition/SttServiceRuntime.ts';
import { FeatureEvent, Mode, SystemEvent } from '../../../src/core/events.ts';

class FakeBus {
  listeners = new Map();

  on(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    return () => listeners.delete(listener);
  }

  emit(type, payload) {
    for (const listener of this.listeners.get(type) ?? []) listener({ payload });
  }
}

class FakeEngine {
  bus = new FakeBus();
  mode = Mode.MIC;
  file = null;
  starts = 0;
  stops = 0;
  stopFinal = '';

  async start() {
    this.starts += 1;
  }

  async stop() {
    this.stops += 1;
    if (this.stopFinal) {
      this.bus.emit(FeatureEvent.TRANSCRIPT_FINAL, {
        text: this.stopFinal,
        provider: 'streaming',
        mode: this.mode,
      });
    }
  }
}

const engine = new FakeEngine();
const streamingProfile = {
  id: 'faster-whisper-live',
  label: 'faster-whisper · 실시간 재전사',
  providerId: 'streaming',
};
const resolver = new BootstrapProfileResolver(() => ({
  profile: streamingProfile,
  mode: engine.mode,
  file: engine.file,
}));

assert.equal(resolver.isServiceProfile(), true, 'generic streaming profile should be service-managed');
assert.deepEqual(resolver.resolve().input, { kind: 'microphone' }, 'mic mode should resolve to microphone service input');

engine.mode = Mode.FILE;
engine.file = { name: 'sample.wav' };
assert.deepEqual(
  resolver.resolve().input,
  { kind: 'file', file: engine.file },
  'file mode should resolve to the currently loaded file',
);

const nonStreaming = new BootstrapProfileResolver(() => ({
  profile: {
    id: 'webspeech',
    label: 'Browser Web Speech API',
    providerId: 'webspeech',
  },
  mode: Mode.MIC,
  file: null,
}));
assert.equal(nonStreaming.isServiceProfile(), false, 'non-streaming profiles must stay on legacy UI paths');
assert.throws(() => nonStreaming.resolve(), /service-managed/, 'resolver must reject non-streaming profiles');

const runtime = createEngineBackedSttServiceRuntime({ engine, resolver });
const seen = [];
let completed = 0;
const run = runtime.createRun({ kind: 'file', file: engine.file }, {
  partial: (text) => seen.push(`partial:${text}`),
  final: (text) => seen.push(`final:${text}`),
  error: (error) => seen.push(`error:${error instanceof Error ? error.message : String(error)}`),
  complete: () => { completed += 1; },
});

await run.start();
assert.equal(engine.starts, 1, 'service runtime should delegate start to the current engine');

engine.bus.emit(FeatureEvent.TRANSCRIPT_PARTIAL, {
  text: '중간',
  provider: 'streaming',
  mode: engine.mode,
});
engine.bus.emit(FeatureEvent.TRANSCRIPT_FINAL, {
  text: '확정',
  provider: 'streaming',
  mode: engine.mode,
});
engine.bus.emit(SystemEvent.RECOGNITION_ERROR, {
  message: 'socket dropped',
  provider: 'streaming',
});
assert.deepEqual(
  seen,
  ['partial:중간', 'final:확정', 'error:socket dropped'],
  'service runtime must relay transcript and error events from the engine bus',
);
engine.stopFinal = 'tail-final';
await run.stop();
assert.equal(engine.stops, 1, 'service runtime should delegate stop to the current engine');
assert.equal(seen.at(-1), 'final:tail-final', 'final drain emitted during stop must still reach the service sink');
engine.bus.emit(SystemEvent.RECOGNITION_STOPPED, { provider: 'streaming', mode: engine.mode });
assert.equal(completed, 1, 'engine natural stop must complete the service run without aborting its final drain');

engine.bus.emit(FeatureEvent.TRANSCRIPT_FINAL, {
  text: 'late-final',
  provider: 'streaming',
  mode: engine.mode,
});
assert.equal(seen.includes('final:late-final'), false, 'events after stop must be dropped');

console.log('stt service runtime adapter: resolver, relay, and final-drain behavior verified');
