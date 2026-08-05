import assert from 'node:assert/strict';
import { selectQaVitePort } from './vite-port.mjs';

await assert.rejects(selectQaVitePort(5173), /5173 is forbidden/);
await assert.rejects(selectQaVitePort(-1), /invalid QA Vite port/);

const port = await selectQaVitePort(0);
assert.equal(Number.isInteger(port), true);
assert.equal(port > 0, true);
assert.notEqual(port, 5173);

console.log(`vite-port: selected isolated QA port ${port}`);
