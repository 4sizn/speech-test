import * as assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const catalogPath = fileURLToPath(new URL('../../../src/profiles/engineProfiles.ts', import.meta.url));
const source = await readFile(catalogPath, 'utf8');

for (const profileId of ['funasr-streaming', 'funasr-offline']) {
  assert.match(source, new RegExp(`id: '${profileId}'`), `${profileId} profile must be declared`);
}
assert.match(source, /id: 'funasr-streaming',[\s\S]*?conversation: true/, 'FunASR streaming must be conversation eligible');
assert.match(source, /id: 'funasr-offline',[\s\S]*?conversation: false/, 'FunASR offline must not promise immediate conversation partials');
assert.match(source, /id: 'funasr-offline',[\s\S]*?partialStrategy: 'snapshot'/, 'FunASR offline must declare snapshot partial semantics');
assert.match(source, /resolveEngineProfile/, 'catalog must resolve an EngineProfile to its transport provider and configuration');

console.log('engine profile catalog separates FunASR streaming from offline');
