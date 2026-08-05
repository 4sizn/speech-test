import { STREAMING_ENDPOINT_PRESETS } from '@rsupport/rvs-stt-kit/streaming';

/**
 * rvs-stt-kit의 공개 endpoint preset을 기존 Provider 설정 UI가 쓰는 문자열 계약으로 고정한다.
 *
 * 기존 StreamingAsrProvider가 lifecycle·상태 메시지·QA 동작을 계속 소유하므로, kit transport로
 * 성급히 교체해 provider-visible 동작을 바꾸지 않는다. 이 작은 adapter는 이후 transport
 * 전환 시에도 endpoint 값의 단일 출처를 제공한다.
 */
export const streamingEndpoints = Object.freeze({
  fasterWhisper: STREAMING_ENDPOINT_PRESETS.fasterWhisper.endpoint,
  whisperStreaming: STREAMING_ENDPOINT_PRESETS.whisperStreaming.endpoint,
  funAsr: STREAMING_ENDPOINT_PRESETS.funAsr.endpoint,
  senseVoice: STREAMING_ENDPOINT_PRESETS.senseVoice.endpoint,
});
