import { StreamingAsrProvider } from './StreamingAsrProvider';
import type { ConfigField, RuntimeLocation } from '../core/SttProvider';

/**
 * FunASR 스트리밍 Provider (paraformer-zh-streaming · 증분 디코딩).
 *
 * 전송 프로토콜은 StreamingAsrProvider와 동일해서 정적 선언만 다르다 —
 * 백엔드는 server/realtime_asr_server.py --engine funasr-streaming (기본 포트 8766).
 *
 * FunASR은 공식 브라우저(WASM) 런타임이 없어 local-client가 아닌 온프레미스로만 지원한다.
 * ⚠ 기본 모델(paraformer-zh-streaming)은 중국어 전용 — 한국어/영어 인식 불가.
 */
export class FunAsrProvider extends StreamingAsrProvider {
  static override readonly id = 'funasr';
  static override readonly label: string = 'FunASR Streaming (paraformer)';
  static override readonly locations: readonly RuntimeLocation[] = ['remote-onpremise'];
  static override readonly configSchema: readonly ConfigField[] = [
    {
      key: 'wsEndpoint',
      label: 'WebSocket URL',
      default: 'ws://localhost:8766',
      placeholder: 'ws://localhost:8766',
      hint: '온프레미스 백엔드: server/realtime_asr_server.py --engine funasr (기본 포트 8766) — 기본 모델은 중국어 전용(한국어는 SenseVoice Provider)',
    },
  ];
}
