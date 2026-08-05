import assert from 'node:assert/strict';
import { parentQaRuntimeCommand, resolveQaNode, selectCompatibleNode } from './node-runtime.mjs';

// RED regression: this cron's PATH resolves /usr/local/bin/node v16 first, while
// the STT QA stack requires Node >=24. QA must select a compatible runtime, not silently
// wait 60 seconds for Vite to fail before any measurement begins.
const versionOf = (path) => ({
  '/usr/local/bin/node': 'v16.13.1',
  '/Users/test/.nvm/versions/node/v22.19.0/bin/node': 'v22.19.0',
  '/Users/test/.nvm/versions/node/v24.13.0/bin/node': 'v24.13.0',
}[path]);
assert.equal(
  selectCompatibleNode(['/usr/local/bin/node', '/Users/test/.nvm/versions/node/v22.19.0/bin/node', '/Users/test/.nvm/versions/node/v24.13.0/bin/node'], { versionOf }),
  '/Users/test/.nvm/versions/node/v24.13.0/bin/node',
);
assert.throws(
  () => selectCompatibleNode(['/usr/local/bin/node'], { versionOf }),
  /Node >=24/,
);

// Homebrew's versioned executable must be discovered when npm itself was
// launched from the legacy /usr/local Node 16 path.
assert.equal(
  resolveQaNode({ env: { HOME: '/no-nvm', HOMEBREW_PREFIX: '/opt/homebrew' }, execPath: '/usr/local/bin/node' }),
  '/opt/homebrew/opt/node@24/bin/node',
);

// The runner itself uses fetch/AbortSignal.timeout before it starts Vite. Merely
// selecting Node 24 for Vite is insufficient when npm launched run.mjs on Node 16.
assert.deepEqual(
  parentQaRuntimeCommand({
    currentNode: '/usr/local/bin/node',
    compatibleNode: '/Users/test/.nvm/versions/node/v24.13.0/bin/node',
    script: '/repo/scripts/qa/run.mjs',
    args: ['--profile', 'full'],
  }),
  ['/Users/test/.nvm/versions/node/v24.13.0/bin/node', ['/repo/scripts/qa/run.mjs', '--profile', 'full']],
);
assert.equal(
  parentQaRuntimeCommand({
    currentNode: '/Users/test/.nvm/versions/node/v24.13.0/bin/node',
    compatibleNode: '/Users/test/.nvm/versions/node/v24.13.0/bin/node', script: '/repo/scripts/qa/run.mjs', args: [],
  }),
  null,
);

console.log('node-runtime: Vite and parent QA runner reject PATH-first Node 16/22 and select Node 24');
