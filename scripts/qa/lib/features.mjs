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
 *       → 정식 게이트 전 기능 5%p. 임시로 +5%p 완화했던 값은 승인 기준이 아니며,
 *       실제 회귀의 원인을 고치고 같은 환경에서 다시 측정해야 한다.
 *       ⚠ **기준선이 운 좋은 측정값으로 잡히면 정상 측정이 계속 경계에 걸린다.** whisper-base-file
 *       기준선 27.4%는 19회 관측(27.4~33.8%) 중 최저 수준이라, 부하가 조금 있으면 +5%p에 닿는다.
 *       같은 실행들의 **중앙값은 27.8%로 안정적**이었다 — 평균은 한 샘플의 실패에 크게 끌린다.
 *       무관한 커밋에서 FAIL이 반복되면 코드를 의심하기 전에 이 이력(runs[])을 먼저 확인하고,
 *       필요하면 중앙값이 안정적인 시점에 기준선을 다시 세운다(--promote).
 * gateOptional: true면 판정이 WARN이 되어 전체 PASS/FAIL에 반영되지 않고, 기준선 승격 대상에서도
 *       제외된다. 클라우드 인식은 우리 코드 밖 요인(서비스 상태·네트워크)에 좌우되기 때문이다.
 *       ⚠ 이 플래그를 "원인을 못 찾았을 때의 도피처"로 쓰면 안 된다. 실제로 그렇게 쓴 전례가 있다:
 *       webspeech CER 100%를 "서비스가 거부하는 상태"로 단정하고 WARN으로 넘겼는데, 진짜 원인은
 *       ko-KR SODA 언어팩이 있으면 한국어 인식이 온라인 경로까지 전부 network로 실패하는 것이었고
 *       (같은 Chrome의 en-US는 정상), 러너에 --disable-component-update를 줘 팩을 막자 CER이
 *       7.8%로 돌아왔다. 즉 통제 가능한 환경 요인을 외부 탓으로 덮고 있었다.
 *       WARN을 붙이기 전에 CLAUDE.md의 "외부 서비스 탓으로 결론내기 전" 판정 순서를 따를 것.
 *       기준선 승격 제외는 이때 도움이 됐다 — 100%가 기준선으로 굳지 않아 회복이 바로 드러났다.
 * requires: 러너가 전제 조건을 점검해 결과지 환경에 기록한다.
 */

import { STREAMING_ENDPOINT_PRESETS } from '@rsupport/rvs-stt-kit/streaming';

const ON_PREM = 'remote-onpremise';
const streamingEndpoints = Object.freeze({
  fasterWhisper: STREAMING_ENDPOINT_PRESETS.fasterWhisper.endpoint,
  funAsr: STREAMING_ENDPOINT_PRESETS.funAsr.endpoint,
  senseVoice: STREAMING_ENDPOINT_PRESETS.senseVoice.endpoint,
});

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
      config: { wsEndpoint: streamingEndpoints.fasterWhisper },
      sets: ['short', 'long'],
      tolerance: 0.05,
      requires: { server: 'faster-whisper' },
    },
    {
      feature: 'streaming-mic',
      provider: 'streaming',
      mode: 'mic',
      location: ON_PREM,
      config: { wsEndpoint: streamingEndpoints.fasterWhisper },
      sets: ['short'],
      tolerance: 0.05,
      requires: { server: 'faster-whisper' },
    },
    {
      feature: 'sensevoice-file',
      provider: 'sensevoice',
      mode: 'file',
      location: ON_PREM,
      config: { wsEndpoint: streamingEndpoints.senseVoice },
      sets: ['short', 'long'],
      tolerance: 0.05,
      requires: { server: 'sensevoice' },
    },
    {
      feature: 'sensevoice-mic',
      provider: 'sensevoice',
      mode: 'mic',
      location: ON_PREM,
      config: { wsEndpoint: streamingEndpoints.senseVoice },
      sets: ['short'],
      tolerance: 0.05,
      requires: { server: 'sensevoice' },
    },
    {
      feature: 'funasr-file',
      provider: 'funasr',
      mode: 'file',
      location: ON_PREM,
      config: { wsEndpoint: streamingEndpoints.funAsr },
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
      // gateOptional을 뗐다 — 그 플래그의 근거였던 "브라우저 서비스가 거부한다"는 판정이 오진이었고
      // (진짜 원인은 ko-KR SODA 언어팩), 러너에서 팩 유입을 막은 뒤 8.7%로 결정론적으로 측정된다.
      // 정식 게이트 대상이다: 회귀하면 푸시가 막힌다.
      tolerance: 0.05,
      requires: { network: true },
      note: '클라우드 인식 — 실행마다 흔들린다(허용 7%p)',
    },
    {
      feature: 'webspeech-mic',
      provider: 'webspeech',
      mode: 'mic',
      location: 'remote-cloud',
      config: {},
      sets: ['short'],
      /**
       * gateOptional 근거(실재함이 증명됐다) — **이 측정은 마이크 경로를 대변하지 못한다.**
       *
       * 하네스 가짜 마이크가 `<audio>` captureStream 트랙을 주므로, WebSpeech가 그 트랙을
       * `start(track)`에 넘기면 결국 **파일 트랙 경로를 다시 테스트**한다. 실제로 마이크 트랙을
       * 넘겨 결과가 오지 않던 결함이 이 측정에서 CER 5.0%로 통과했고(사용자가 발견),
       * 그 결함을 고쳐 "파일 모드에서만 트랙 입력"으로 바꾸자 **이 측정이 100%로 뒤집혔다**
       * — 올바른 코드가 막히고 결함이 통과하는 관계다. 게이트 조건으로 삼을 수 없다.
       *
       * 대신 결과지에는 WARN으로 남겨 추세를 본다. 마이크 경로 확인은
       * `npm run qa:mic`(진짜 장치 트랙 주입) + 사람이 물리 마이크로 직접 말해보는 것뿐이다.
       * WebSpeech는 qa:mic으로도 검증되지 않는다(가짜 파일 캡처가 인식 오디오 스택에 닿지 않음).
       */
      gateOptional: true,
      tolerance: 0.05,
      requires: { network: true },
      note: '파일 주입 가짜 마이크라 실제로는 파일 트랙 경로를 측정한다 — 마이크 경로는 사람이 확인',
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
      tolerance: 0.05,
      requires: { asset: 'Xenova/whisper-small' },
    },
    {
      feature: 'webspeech-local-file',
      provider: 'webspeech',
      mode: 'file',
      location: 'local-client',
      config: {},
      sets: ['short'],
      // 유일하게 남은 gateOptional — 근거가 실재한다: 러너가 --disable-component-update로 언어팩
      // 유입을 막으므로 이 기능은 보통 온디바이스가 아니라 온라인 폴백을 측정한다(즉 무엇을 재는지가
      // 환경에 따라 바뀐다). 온디바이스 경로를 실제로 재려면 언어팩이 설치된 환경이 필요하다.
      gateOptional: true,
      tolerance: 0.05,
      requires: { soda: true },
      // 이 기능이 QA 환경을 오염시킨 전례가 있다: Provider가 install()을 자동 호출하던 시절,
      // 이 기능이 브라우저 프로필에 불완전한 ko-KR 언어팩을 설치해 **같은 프로필의 다른
      // WebSpeech 측정까지 전부 CER 100%로 만들었다**(원인을 외부 서비스 탓으로 오진했다).
      // Provider에서 자동 설치를 제거해 재발은 막았지만, 온디바이스 경로는 환경 상태를 읽기만
      // 해야 한다 — 여기서 설치를 유발하는 설정을 추가하지 말 것.
      note: '온디바이스(SODA) — 준비된 언어팩이 없으면 온라인으로 폴백하며 경고(설치는 하지 않는다)',
    },
  ];
}

/** 기능이 요구하는 온프레미스 엔진 이름 → 포트 */
/**
 * 엔진별 기본 포트. whisper-streaming(8768)은 서버는 지원하되 **QA 상시 항목에는 없다** —
 * faster-whisper와 각각 small 모델을 물고 돌아 CPU를 다투면 다른 기능 측정까지 망친다
 * (실측: 두 서버 동시 기동 상태에서 streaming-mic이 10.4%→42.2%로 무너졌다).
 * 비교가 필요하면 8765를 내리고 wsEndpoint를 8768로 준 임시 기능으로 재라. 측정 근거는 README.
 */
export const SERVER_PORTS = {
  'faster-whisper': 8765,
  funasr: 8766,
  sensevoice: 8767,
  'whisper-streaming': 8768,
};
