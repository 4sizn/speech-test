import assert from 'node:assert/strict';
import { judge } from './gate.mjs';

const baseline = { features: { 'streaming-mic': { cerAvg: 0.1045 } } };
const baseRow = {
  feature: 'streaming-mic',
  skipped: null,
  gateOptional: false,
  tolerance: 0.07,
  maxNoFinalRate: 0,
  samples: 6,
};

assert.equal(
  judge([{ ...baseRow, cerAvg: 0.17, noFinals: 0 }], baseline).overall.pass,
  true,
  '정상 final이 모두 수신되고 CER 변동이 7%p 이내면 통과해야 한다',
);

const missingFinal = judge([{ ...baseRow, cerAvg: 0.11, noFinals: 1 }], baseline);
assert.equal(missingFinal.overall.pass, false, 'CER 평균이 좋아도 final 미수신은 통과하면 안 된다');
assert.match(missingFinal.verdicts[0].reason, /final 미수신/, '원인이 CER 오차가 아니라 final 미수신으로 보고돼야 한다');

console.log('gate no-final contract: PASS');
