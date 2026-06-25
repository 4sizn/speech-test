/**
 * 이벤트 타입 정의.
 *
 * RVS MessageBus 규약을 따라 dot-namespace 문자열로 타입을 정의하고,
 * 카테고리를 통해 "시스템 이벤트"와 "기능 이벤트"를 명확히 분리한다.
 *
 *  - system  : 연결/초기화/생명주기/상태 등 인프라성 이벤트 (시스템 이벤트 호출)
 *  - feature : STT 도메인의 산출물(부분/최종 인식 결과) (기능 이벤트 호출)
 */

/** @enum {string} */
export const EventCategory = Object.freeze({
  SYSTEM: 'system',
  FEATURE: 'feature',
});

/**
 * 시스템 이벤트 호출 — 엔진/Provider/오디오의 생명주기·상태.
 * 도메인 결과가 아니라 "지금 무슨 상태인가"를 알린다.
 */
export const SystemEvent = Object.freeze({
  ENGINE_READY: 'system.engine.ready',
  PROVIDER_CHANGED: 'system.engine.provider-changed',
  MODE_CHANGED: 'system.engine.mode-changed',

  PROVIDER_INIT: 'system.provider.init',
  MODEL_LOADING: 'system.provider.model-loading',
  MODEL_READY: 'system.provider.model-ready',

  RECOGNITION_STARTED: 'system.recognition.started',
  RECOGNITION_STOPPED: 'system.recognition.stopped',
  RECOGNITION_ERROR: 'system.recognition.error',

  AUDIO_LOADED: 'system.audio.loaded',
  AUDIO_PLAY: 'system.audio.play',
  AUDIO_PAUSE: 'system.audio.pause',
  AUDIO_ENDED: 'system.audio.ended',
  AUDIO_LEVEL: 'system.audio.level',

  STATUS: 'system.status',
});

/**
 * 기능 이벤트 호출 — STT 도메인 산출물.
 * Provider가 무엇으로 구현됐든(브라우저/클라우드) 동일한 기능 이벤트로 흘러나온다.
 */
export const FeatureEvent = Object.freeze({
  TRANSCRIPT_PARTIAL: 'feature.stt.transcript.partial', // 인식 중(interim)
  TRANSCRIPT_FINAL: 'feature.stt.transcript.final', // 확정(final)
  TRANSCRIPT_RESET: 'feature.stt.transcript.reset',
});

/** 인식 입력 모드. Provider는 capabilities로 지원 모드를 선언한다. */
export const Mode = Object.freeze({
  MIC: 'mic', // 마이크 실시간
  FILE: 'file', // 업로드 파일 (클라우드 ASR 등)
  FILE_LOOPBACK: 'file-loopback', // 스피커 재생음을 마이크로 되받는 실험 모드
});
