import type { Mode } from '../core/events';
import type { ProviderConfig, RuntimeLocation } from '../core/SttProvider';
import { streamingEndpoints } from '../providers/rvsSttKitAdapter';

export type PartialStrategy = 'none' | 'snapshot' | 'incremental' | 'stable-incremental';

/**
 * 사용자에게 선택되는 ASR 모델 동작 단위.
 *
 * Provider는 PCM/WebSocket·브라우저 API·HTTP upload처럼 transport를 담당하고,
 * EngineProfile은 모델/언어/partial semantics/runtime을 선언한다.
 */
export interface EngineProfile {
  readonly id: string;
  readonly label: string;
  readonly providerId: string;
  readonly config: Readonly<ProviderConfig>;
  readonly modes: readonly Mode[];
  readonly locations: readonly RuntimeLocation[];
  readonly languages: readonly string[];
  readonly partialStrategy: PartialStrategy;
  /** true면 즉각적인 대화용 partial transcript 후보로 UI에 표시한다. */
  readonly conversation: boolean;
  readonly description: string;
}

const ON_PREM: readonly RuntimeLocation[] = ['remote-onpremise'];
const STREAM_MODES: readonly Mode[] = ['mic', 'file'];

export const ENGINE_PROFILES: readonly EngineProfile[] = [
  {
    id: 'faster-whisper-live',
    label: 'faster-whisper · 실시간 재전사',
    providerId: 'streaming',
    config: { wsEndpoint: streamingEndpoints.fasterWhisper },
    modes: STREAM_MODES,
    locations: ['remote-onpremise', 'remote-cloud'],
    languages: ['ko', 'en', 'ja', 'zh'],
    partialStrategy: 'snapshot',
    conversation: true,
    description: '한국어 권장 · 주기 재전사 partial',
  },
  {
    id: 'whisper-streaming',
    label: 'whisper_streaming · 연속 증분',
    providerId: 'streaming',
    config: { wsEndpoint: streamingEndpoints.whisperStreaming },
    modes: STREAM_MODES,
    locations: ON_PREM,
    languages: ['ko', 'en', 'ja', 'zh'],
    partialStrategy: 'stable-incremental',
    conversation: true,
    description: '긴 연속 발화용 · 확정 단위 증분',
  },
  {
    id: 'funasr-streaming',
    label: 'FunASR · Streaming paraformer',
    providerId: 'funasr',
    config: { wsEndpoint: streamingEndpoints.funAsr },
    modes: STREAM_MODES,
    locations: ON_PREM,
    languages: ['zh'],
    partialStrategy: 'incremental',
    conversation: true,
    description: '중국어 전용 · 600ms 누적 incremental partial',
  },
  {
    id: 'funasr-offline',
    label: 'FunASR · Offline paraformer',
    providerId: 'streaming',
    config: { wsEndpoint: streamingEndpoints.funAsrOffline },
    modes: ['file'],
    locations: ON_PREM,
    languages: ['zh'],
    partialStrategy: 'snapshot',
    conversation: false,
    description: '파일 전사/정확도 우선 · 대화용 즉시 partial 미보장',
  },
  {
    id: 'sensevoice-snapshot',
    label: 'SenseVoice · 다국어 snapshot',
    providerId: 'sensevoice',
    config: { wsEndpoint: streamingEndpoints.senseVoice },
    modes: STREAM_MODES,
    locations: ON_PREM,
    languages: ['ko', 'en', 'ja', 'zh'],
    partialStrategy: 'snapshot',
    conversation: true,
    description: 'ko/ja/en/zh · 주기 재전사 partial',
  },
  {
    id: 'whisper-local',
    label: 'Whisper · 로컬 WASM/WebGPU',
    providerId: 'whisper',
    config: {},
    modes: STREAM_MODES,
    locations: ['local-client'],
    languages: ['ko', 'en', 'ja', 'zh'],
    partialStrategy: 'snapshot',
    conversation: false,
    description: '브라우저 로컬 모델 · 파일 전사 중심',
  },
  {
    id: 'webspeech',
    label: 'Browser Web Speech API',
    providerId: 'webspeech',
    config: {},
    modes: STREAM_MODES,
    locations: ['remote-cloud'],
    languages: ['ko', 'en', 'ja', 'zh'],
    partialStrategy: 'incremental',
    conversation: true,
    description: '브라우저 클라우드 음성 인식',
  },
  {
    id: 'qwen3-batch',
    label: 'Qwen3 ASR · 파일 전송',
    providerId: 'qwen3',
    config: {},
    modes: ['file'],
    locations: ['remote-cloud'],
    languages: ['ko', 'en', 'ja', 'zh'],
    partialStrategy: 'none',
    conversation: false,
    description: '파일 upload batch 전사',
  },
];

export function getEngineProfile(id: string): EngineProfile {
  const profile = ENGINE_PROFILES.find((candidate) => candidate.id === id);
  if (!profile) throw new Error(`알 수 없는 EngineProfile: ${id}`);
  return profile;
}

export function resolveEngineProfile(id: string, overrides: ProviderConfig = {}): { profile: EngineProfile; providerId: string; config: ProviderConfig } {
  const profile = getEngineProfile(id);
  return { profile, providerId: profile.providerId, config: { ...profile.config, ...overrides } };
}

export function supportsLanguage(profile: EngineProfile, language: string): boolean {
  return profile.languages.includes(language.split('-')[0]);
}
