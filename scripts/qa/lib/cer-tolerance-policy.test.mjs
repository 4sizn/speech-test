import assert from 'node:assert/strict';
import { buildFeatures } from './features.mjs';
import { judge } from './gate.mjs';

const controlled = buildFeatures('full').filter((feature) => !feature.gateOptional);

assert.ok(controlled.length > 0, '정식 게이트 기능이 있어야 한다');
for (const feature of controlled) {
  assert.ok(
    feature.tolerance <= 0.05,
    `${feature.feature}: 임시 +5%p 완화는 회귀를 승인하는 근거가 될 수 없다; 정식 게이트는 최대 5%p여야 한다`,
  );
}

const streaming = controlled.find((feature) => feature.feature === 'streaming-file');
assert.ok(streaming, 'streaming-file 정식 게이트 기능이 있어야 한다');

const baseline = { features: { 'streaming-file': { cerAvg: 0.1451 } } };
const row = { feature: 'streaming-file', skipped: null, gateOptional: false, tolerance: streaming.tolerance };

assert.equal(
  judge([{ ...row, cerAvg: 0.1950 }], baseline).overall.pass,
  true,
  '기준선보다 4.99%p 높은 측정은 통과해야 한다',
);
assert.equal(
  judge([{ ...row, cerAvg: 0.1952 }], baseline).overall.pass,
  false,
  '기준선보다 5%p를 넘는 명확한 CER 회귀는 차단해야 한다',
);

console.log('CER tolerance policy: PASS');
