/**
 * 테스트할 "기능" 정의 — Provider × 모드 × 실행 위치(+모델) 조합 하나가 결과지 한 파일이 된다.
 *
 * sets: 이 기능에 돌릴 샘플 세트. 긴 연속 오디오(long)는 청킹 전략 회귀를 잡는 용도라
 *       file 모드에만 넣는다(mic까지 넣으면 실시간 재생 시간이 두 배가 된다).
 * tolerance: 기준선 대비 허용 악화(퍼센트포인트/100). 비결정적 경로는 크게 둔다.
 * requires: 러너가 전제 조건을 점검해 결과지 환경에 기록한다.
 */

const ON_PREM = 'remote-onpremise';

/** @returns {Array<object>} */
export function buildFeatures(profile = 'quick') {
  const quick = [
    {
      feature: 'whisper-base-file',
      provider: 'whisper',
      mode: 'file',
      location: 'local-client',
      config: { modelId: 'Xenova/whisper-base', maxChunkSec: '20' },
      sets: ['short', 'long'],
      tolerance: 0.02,
      requires: { asset: 'Xenova/whisper-base' },
    },
    {
      feature: 'whisper-base-mic',
      provider: 'whisper',
      mode: 'mic',
      location: 'local-client',
      config: { modelId: 'Xenova/whisper-base', maxChunkSec: '20' },
      sets: ['short'],
      tolerance: 0.02,
      requires: { asset: 'Xenova/whisper-base' },
    },
    {
      feature: 'streaming-file',
      provider: 'streaming',
      mode: 'file',
      location: ON_PREM,
      config: { wsEndpoint: 'ws://localhost:8765' },
      sets: ['short', 'long'],
      tolerance: 0.02,
      requires: { server: 'faster-whisper' },
    },
    {
      feature: 'streaming-mic',
      provider: 'streaming',
      mode: 'mic',
      location: ON_PREM,
      config: { wsEndpoint: 'ws://localhost:8765' },
      sets: ['short'],
      tolerance: 0.02,
      requires: { server: 'faster-whisper' },
    },
    {
      feature: 'sensevoice-file',
      provider: 'sensevoice',
      mode: 'file',
      location: ON_PREM,
      config: { wsEndpoint: 'ws://localhost:8767' },
      sets: ['short', 'long'],
      tolerance: 0.02,
      requires: { server: 'sensevoice' },
    },
    {
      feature: 'sensevoice-mic',
      provider: 'sensevoice',
      mode: 'mic',
      location: ON_PREM,
      config: { wsEndpoint: 'ws://localhost:8767' },
      sets: ['short'],
      tolerance: 0.02,
      requires: { server: 'sensevoice' },
    },
    {
      feature: 'funasr-file',
      provider: 'funasr',
      mode: 'file',
      location: ON_PREM,
      config: { wsEndpoint: 'ws://localhost:8766' },
      sets: ['short', 'long'],
      tolerance: 0.02,
      requires: { server: 'funasr' },
      // 기본 모델이 중국어 전용이라 한국어 CER은 100%를 크게 넘는 게 정상이다.
      // 절대값이 아니라 직전 대비 변화만 의미가 있다.
      note: '중국어 전용 모델 — 절대 CER 무의미, 회귀 감지용',
    },
    {
      feature: 'webspeech-file',
      provider: 'webspeech',
      mode: 'file',
      location: 'remote-cloud',
      config: {},
      sets: ['short'],
      tolerance: 0.05,
      requires: { network: true },
      note: '클라우드 인식 — 실행마다 흔들린다',
    },
    {
      feature: 'webspeech-mic',
      provider: 'webspeech',
      mode: 'mic',
      location: 'remote-cloud',
      config: {},
      sets: ['short'],
      tolerance: 0.05,
      requires: { network: true },
      note: '클라우드 인식 · 파일 주입 가짜 마이크',
    },
    {
      feature: 'qwen3-file',
      provider: 'qwen3',
      mode: 'file',
      location: 'remote-cloud',
      config: {},
      sets: ['short'],
      tolerance: 0.05,
      requires: { credentials: 'endpoint+apiKey' },
      note: '자격 미설정이면 SKIP',
    },
  ];

  if (profile === 'quick') return quick;

  return [
    ...quick,
    {
      feature: 'whisper-tiny-file',
      provider: 'whisper',
      mode: 'file',
      location: 'local-client',
      config: { modelId: 'Xenova/whisper-tiny', maxChunkSec: '20' },
      sets: ['short', 'long'],
      tolerance: 0.05,
      requires: { asset: 'Xenova/whisper-tiny' },
      note: '한국어 비권장 — 회귀 감시용으로만 측정',
    },
    {
      feature: 'whisper-small-file',
      provider: 'whisper',
      mode: 'file',
      location: 'local-client',
      config: { modelId: 'Xenova/whisper-small', maxChunkSec: '20' },
      sets: ['short', 'long'],
      tolerance: 0.02,
      requires: { asset: 'Xenova/whisper-small' },
    },
    {
      feature: 'webspeech-local-file',
      provider: 'webspeech',
      mode: 'file',
      location: 'local-client',
      config: {},
      sets: ['short'],
      tolerance: 0.05,
      requires: { soda: true },
      note: '온디바이스(SODA) — 모델 미지원 환경이면 온라인으로 폴백하며 경고',
    },
  ];
}

/** 기능이 요구하는 온프레미스 엔진 이름 → 포트 */
export const SERVER_PORTS = {
  'faster-whisper': 8765,
  funasr: 8766,
  sensevoice: 8767,
};
