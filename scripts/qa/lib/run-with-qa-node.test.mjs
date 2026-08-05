import assert from 'node:assert/strict';
import { commandForQaRuntime } from './run-with-qa-node.mjs';

// RED regression: npm scripts inherit this machine's PATH-first Node 16, which
// cannot load Vite 8/TypeScript's package binaries. Build commands must be
// explicitly re-executed by the same Node >=24 resolver used by QA.
assert.deepEqual(
  commandForQaRuntime({ currentNode: '/usr/local/bin/node', compatibleNode: '/Users/test/.nvm/versions/node/v24.14.0/bin/node', command: 'node_modules/typescript/bin/tsc', args: ['--noEmit'] }),
  ['/Users/test/.nvm/versions/node/v24.14.0/bin/node', ['node_modules/typescript/bin/tsc', '--noEmit']],
);
assert.equal(
  commandForQaRuntime({ currentNode: '/Users/test/.nvm/versions/node/v24.14.0/bin/node', compatibleNode: '/Users/test/.nvm/versions/node/v24.14.0/bin/node', command: 'node_modules/vite/bin/vite.js', args: ['build'] }),
  null,
);
console.log('run-with-qa-node: package binaries re-exec on Node >=24');
