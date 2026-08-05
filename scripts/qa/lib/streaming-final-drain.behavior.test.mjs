import assert from 'node:assert/strict';
import { awaitSocketCloseOrTimeout, FINAL_DRAIN_TIMEOUT_MS } from '../../../src/providers/streamingFinalDrain.ts';

class FakeSocket extends EventTarget {
  close() {
    this.dispatchEvent(new Event('close'));
  }
}

// RED regression: with serial server inference, a final can arrive after the
// legacy 6-second drain. The client must still be listening then, and it must
// unblock immediately once the server closes rather than always consuming 20s.
assert.equal(FINAL_DRAIN_TIMEOUT_MS, 20_000);
const socket = new FakeSocket();
let settled = false;
const waiting = awaitSocketCloseOrTimeout(socket).then(() => {
  settled = true;
});
await new Promise((resolve) => setTimeout(resolve, 6_100));
assert.equal(settled, false, 'must not discard a final at the legacy 6-second boundary');
socket.close();
await waiting;
assert.equal(settled, true, 'server close must complete final drain promptly');

console.log('streaming-final-drain-behavior: final drain survives legacy timeout and exits on close');
