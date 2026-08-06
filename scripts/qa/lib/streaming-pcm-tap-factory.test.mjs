import assert from 'node:assert/strict';
import { createAudioPcmTapFactory } from '../../../src/providers/audioPcmTapPort.ts';

class FakeAudioPcmTap {
  static instances = [];
  #stream;
  #options;
  starts = 0;
  stops = 0;

  constructor(stream, options) {
    this.#stream = stream;
    this.#options = options;
    FakeAudioPcmTap.instances.push(this);
  }

  get stream() {
    return this.#stream;
  }

  get options() {
    return this.#options;
  }

  async start() {
    this.starts += 1;
  }

  async stop() {
    this.stops += 1;
  }
}

const onFrame = () => {};
const fakeStream = { id: 'fake-stream' };
const factory = createAudioPcmTapFactory(FakeAudioPcmTap);
const port = factory(fakeStream, onFrame);

assert.equal(FakeAudioPcmTap.instances.length, 1, 'factory must construct exactly one AudioPcmTap-compatible instance');
assert.equal(FakeAudioPcmTap.instances[0].stream, fakeStream, 'factory must preserve the caller-owned MediaStream');
assert.equal(FakeAudioPcmTap.instances[0].options.onFrame, onFrame, 'factory must forward PCM frames to the delegated callback');

await port.start();
await port.stop();

assert.equal(FakeAudioPcmTap.instances[0].starts, 1, 'port start must delegate to the wrapped tap');
assert.equal(FakeAudioPcmTap.instances[0].stops, 1, 'port stop must delegate to the wrapped tap');

console.log('streaming pcm tap factory: local AudioPcmTap wiring preserved');
