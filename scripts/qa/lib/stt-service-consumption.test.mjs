import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const appPath = fileURLToPath(new URL('../../../src/app.ts', import.meta.url));
const appSource = await readFile(appPath, 'utf8');

assert.match(
  appSource,
  /import\s*\{\s*SttService\s*\}\s*from '@rsupport\/rvs-stt-kit';/,
  'UI composition must consume the published root kit SttService',
);
assert.match(
  appSource,
  /createEngineBackedSttServiceRuntime|BootstrapProfileResolver/,
  'app composition must use the local speech-test runtime adapter around SttService',
);
const kit = await import('@rsupport/rvs-stt-kit');
assert.equal(typeof kit.SttService, 'function', 'installed kit root must export SttService');

console.log('stt service consumption: root package import and local runtime contract verified');
