import { spawnSync } from 'node:child_process';
import { resolveQaNode } from './node-runtime.mjs';

/** Return a re-exec command when a package binary inherited an old npm Node. */
export function commandForQaRuntime({ currentNode, compatibleNode, command, args = [] } = {}) {
  if (!currentNode || !compatibleNode || !command) throw new Error('currentNode, compatibleNode, and command are required');
  return currentNode === compatibleNode ? null : [compatibleNode, [command, ...args]];
}

const invokedAsScript = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedAsScript) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error('usage: run-with-qa-node.mjs <node-script> [...args]');
  const compatibleNode = resolveQaNode();
  const reexec = commandForQaRuntime({ currentNode: process.execPath, compatibleNode, command, args });
  const result = reexec
    ? spawnSync(reexec[0], reexec[1], { cwd: process.cwd(), stdio: 'inherit', env: process.env })
    : spawnSync(process.execPath, [command, ...args], { cwd: process.cwd(), stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
