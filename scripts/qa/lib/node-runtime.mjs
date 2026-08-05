import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Vite 8 and the QA runner are validated on Node 24+. Keep this in sync with
// package.json engines and .nvmrc so npm, direct scripts, and spawned Vite use
// the same minimum runtime.
const MIN_NODE_MAJOR = 24;

function major(version) {
  const match = /^v?(\d+)\./.exec(version ?? '');
  return match ? Number(match[1]) : 0;
}

/** Pick the first executable Node runtime compatible with Vite 8. */
export function selectCompatibleNode(candidates, { versionOf } = {}) {
  for (const candidate of candidates) {
    try {
      const version = versionOf ? versionOf(candidate) : execFileSync(candidate, ['--version'], { encoding: 'utf8' }).trim();
      if (major(version) >= MIN_NODE_MAJOR) return candidate;
    } catch {
      // Missing/non-executable candidates are not usable runtimes.
    }
  }
  throw new Error(`Vite 8 QA requires Node >=${MIN_NODE_MAJOR}; set STT_QA_NODE to a compatible node executable`);
}

/**
 * Resolve a Node executable for the child Vite process. The parent QA runner can
 * remain on an older Node, but its Vite child must not inherit a PATH-first v16.
 */
export function resolveQaNode({ env = process.env, execPath = process.execPath } = {}) {
  const candidates = [];
  if (env.STT_QA_NODE) candidates.push(env.STT_QA_NODE);
  candidates.push(execPath);

  const nvmRoot = join(env.HOME ?? '', '.nvm/versions/node');
  if (existsSync(nvmRoot)) {
    for (const version of readdirSync(nvmRoot).sort().reverse()) candidates.push(join(nvmRoot, version, 'bin/node'));
  }

  // Homebrew keeps versioned Node formulae outside PATH when an old /usr/local
  // Node shadows them. Probe the maintained Node 24 formula explicitly.
  for (const prefix of [env.HOMEBREW_PREFIX, '/opt/homebrew', '/usr/local']) {
    if (prefix) candidates.push(join(prefix, 'opt/node@24/bin/node'));
  }
  return selectCompatibleNode([...new Set(candidates)]);
}

/**
 * Return a re-exec command when npm launched the QA runner on an incompatible
 * Node. The runner itself needs fetch and AbortSignal.timeout before it can
 * start its separately-versioned Vite child.
 */
export function parentQaRuntimeCommand({ currentNode, compatibleNode, script, args = [] } = {}) {
  if (!currentNode || !compatibleNode || !script) throw new Error('currentNode, compatibleNode, and script are required');
  return currentNode === compatibleNode ? null : [compatibleNode, [script, ...args]];
}

export function viteCommand({ node, root, host, port }) {
  return [node, [join(root, 'node_modules/vite/bin/vite.js'), '--host', host, '--port', String(port), '--strictPort']];
}
