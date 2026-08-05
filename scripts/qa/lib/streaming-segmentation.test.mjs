import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const source = readFileSync(join(here, '../../../server/realtime_asr_server.py'), 'utf8');

// RED regression lock: a same-day, same-model/sample controlled A/B found that
// small + 15s forced segmentation raised streaming-file CER to 21.5%, while
// small + 25s was 16.5% (historical baseline 14.5%).  A separately controlled
// base + 25s run was 29.4%, proving model selection and segmentation are
// independent causal variables. Keep both production defaults explicit; the CLI
// overrides exist only for future controlled experiments, never silent drift.
assert.match(source, /^MAX_UTTERANCE_SEC = 25\.0/m);
assert.match(source, /FasterWhisperEngine\(args\.model or "small"\)/);
assert.match(source, /--max-utterance-sec/);

console.log('streaming-segmentation: small + 25s production defaults and controlled override retained');
