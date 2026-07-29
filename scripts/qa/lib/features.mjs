/**
 * 테스트할 "기능" 정의 — Provider × 모드 × 실행 위치(+모델) 조합 하나가 결과지 한 파일이 된다.
 *
 * sets: 이 기능에 돌릴 샘플 세트. 긴 연속 오디오(long)는 청킹 전략 회귀를 잡는 용도라
 *       file 모드에만 넣는다(mic까지 넣으면 실시간 재생 시간이 두 배가 된다).
 * tolerance: 기준선 대비 허용 악화(퍼센트포인트/100).
 *       **측정 재현성에 맞춘 값이다.** 같은 구성으로 두 번 돌린 실측 변동폭:
 *       whisper-file 0.9%p · whisper-mic 0.5%p · streaming-mic 2.0%p · sensevoice-file 1.8%p ·
 *       sensevoice-mic 3.6%p · webspeech-file 3.7%p.
 *       실시간 스트리밍은 재생 타이밍과 서버 백로그에 따라 흔들리고, 클라우드는 더 흔들린다.
 *       재현성보다 타이트한 임계는 회귀가 없어도 매번 FAIL을 내 게이트를 무력화한다.
 *       whisper-base-file은 6회 관측 범위가 27.4~31.9%(4.5%p)였다 — WebGPU 경로와 무음 경계
 *       분할이 시스템 부하에 따라 조각 수를 바꾸기 때문. 처음 3%p로 뒀다가 무관한 커밋에서
 *       0.2%p 초과로 FAIL이 나 5%p로 올렸다.
 *       → 전 기능 5%p · 클라우드 7%p.
 * gateOptional: true면 판정이 WARN이 되어 전체 PASS/FAIL에 반영되지 않고, 기준선 승격 대상에서도
 *       제외된다. 클라우드 인식은 서비스 상태에 좌우되기 때문 — 실제로 대량 호출 후 partial만 오고
 *       final이 끊겨 CER이 100%로 튀었는데, 코드 변경과 무관했다(수정 전 코드로도 동일 재현).
 *       외부 요인을 우리 커밋의 통과 조건으로 삼으면 게이트가 신뢰를 잃는다.
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
      // partialIntervalSec: '0' — 기준선은 확정(final) 경로의 회귀만 봐야 한다. 중간 결과
      // 재인식 부하가 섞이면 게이트가 "정확도 회귀"와 "부하로 인한 캡처 흔들림"을 구분하지
      // 못한다(위 12행: 관측 변동폭 4.5%p / 허용 5%p). 중간 결과 경로는 아래 별도 기능이 본다.
      config: { modelId: 'Xenova/whisper-base', maxChunkSec: '20', partialIntervalSec: '0' },
      sets: ['short', 'long'],
      tolerance: 0.05,
      requires: { asset: 'Xenova/whisper-base' },
    },
    {
      feature: 'whisper-base-mic',
      provider: 'whisper',
      mode: 'mic',
      location: 'local-client',
      config: { modelId: 'Xenova/whisper-base', maxChunkSec: '20', partialIntervalSec: '0' },
      sets: ['short'],
      tolerance: 0.05,
      requires: { asset: 'Xenova/whisper-base' },
    },
    {
      feature: 'whisper-base-partial-file',
      provider: 'whisper',
      mode: 'file',
      location: 'local-client',
      config: { modelId: 'Xenova/whisper-base', maxChunkSec: '20', partialIntervalSec: '1.0' },
      sets: ['short'],
      tolerance: 0.05,
      requires: { asset: 'Xenova/whisper-base' },
      note: '중간 결과(주기 재인식)를 켠 실사용 경로 — 확정 정확도가 그 부하에 흔들리지 않는지 감시',
    },
    {
      feature: 'whisper-base-partial-mic',
      provider: 'whisper',
      mode: 'mic',
      location: 'local-client',
      config: { modelId: 'Xenova/whisper-base', maxChunkSec: '20', partialIntervalSec: '1.0' },
      sets: ['short'],
      tolerance: 0.05,
      requires: { asset: 'Xenova/whisper-base' },
      note: '중간 결과를 켠 마이크 경로 — 재인식 부하가 마이크 캡처에도 번지는지 감시. 다만 이 마이크도 파일 재생 주입이라 물리 마이크(디코딩 없음)보다 부하에 취약할 수 있다',
    },
    {
      feature: 'streaming-file',
      provider: 'streaming',
      mode: 'file',
      location: ON_PREM,
      config: { wsEndpoint: 'ws://localhost:8765' },
      sets: ['short', 'long'],
      tolerance: 0.05,
      requires: { server: 'faster-whisper' },
    },
    {
      feature: 'streaming-mic',
      provider: 'streaming',
      mode: 'mic',
      location: ON_PREM,
      config: { wsEndpoint: 'ws://localhost:8765' },
      sets: ['short'],
      tolerance: 0.05,
      requires: { server: 'faster-whisper' },
    },
    {
      feature: 'sensevoice-file',
      provider: 'sensevoice',
      mode: 'file',
      location: ON_PREM,
      config: { wsEndpoint: 'ws://localhost:8767' },
      sets: ['short', 'long'],
      tolerance: 0.05,
      requires: { server: 'sensevoice' },
    },
    {
      feature: 'sensevoice-mic',
      provider: 'sensevoice',
      mode: 'mic',
      location: ON_PREM,
      config: { wsEndpoint: 'ws://localhost:8767' },
      sets: ['short'],
      tolerance: 0.05,
      requires: { server: 'sensevoice' },
    },
    {
      feature: 'funasr-file',
      provider: 'funasr',
      mode: 'file',
      location: ON_PREM,
      config: { wsEndpoint: 'ws://localhost:8766' },
      sets: ['short', 'long'],
      tolerance: 0.05,
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
      gateOptional: true, // 외부 서비스 상태에 좌우된다 — 결과지에는 남기고 게이트 판정에서는 WARN
      tolerance: 0.07,
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
      gateOptional: true, // 외부 서비스 상태에 좌우된다 — 결과지에는 남기고 게이트 판정에서는 WARN
      tolerance: 0.07,
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
      gateOptional: true, // 외부 서비스 상태에 좌우된다 — 결과지에는 남기고 게이트 판정에서는 WARN
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
      config: { modelId: 'Xenova/whisper-tiny', maxChunkSec: '20', partialIntervalSec: '0' },
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
      config: { modelId: 'Xenova/whisper-small', maxChunkSec: '20', partialIntervalSec: '0' },
      sets: ['short', 'long'],
      tolerance: 0.03,
      requires: { asset: 'Xenova/whisper-small' },
    },
    {
      feature: 'webspeech-local-file',
      provider: 'webspeech',
      mode: 'file',
      location: 'local-client',
      config: {},
      sets: ['short'],
      gateOptional: true, // 외부 서비스 상태에 좌우된다 — 결과지에는 남기고 게이트 판정에서는 WARN
      tolerance: 0.07,
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
