import { ProviderRegistry } from '../core/ProviderRegistry';
import { WebSpeechProvider } from './WebSpeechProvider';
import { WhisperWasmProvider } from './WhisperWasmProvider';
import { StreamingAsrProvider } from './StreamingAsrProvider';
import { FunAsrProvider } from './FunAsrProvider';
import { SenseVoiceProvider } from './SenseVoiceProvider';
import { Qwen3Provider } from './Qwen3Provider';

/**
 * Provider 등록(주입) 목록 — 앱(`app.ts`)과 QA 하네스(`src/qa/harness.ts`)가 공유한다.
 *
 * 두 곳에서 각자 등록하면 Provider를 추가할 때 한쪽만 고쳐져, QA가 앱과 다른 집합을
 * 테스트하면서도 "전부 테스트했다"고 보고하는 상황이 생긴다. 등록은 여기 한 곳에서만.
 *
 * 새 Provider는 이 한 줄만 추가하면 UI/엔진 수정 없이 앱과 QA에 동시에 반영된다.
 */
export function createProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry()
    .register(WebSpeechProvider)
    .register(WhisperWasmProvider)
    .register(StreamingAsrProvider)
    .register(FunAsrProvider)
    .register(SenseVoiceProvider)
    .register(Qwen3Provider);
}
