import { StreamingAsrProvider } from './StreamingAsrProvider';
import type { ConfigField, RuntimeLocation } from '../core/SttProvider';

/**
 * SenseVoice 스트리밍 Provider (SenseVoiceSmall · 다국어).
 *
 * 전송 프로토콜은 StreamingAsrProvider와 동일해서 정적 선언만 다르다 —
 * 백엔드는 server/realtime_asr_server.py --engine sensevoice (기본 포트 8767).
 *
 * FunASR paraformer가 중국어 전용인 것과 달리 한국어(ko)를 공식 지원한다
 * (모델 lid_dict: zh/en/yue/ja/ko). 다만 offline 모델이라 증분 디코딩이 아니고,
 * 서버가 발화 버퍼를 주기 재전사해 partial을 만든다 — 비자기회귀라 CPU에서도 실시간.
 */
export class SenseVoiceProvider extends StreamingAsrProvider {
  static override readonly id = 'sensevoice';
  static override readonly label = 'SenseVoice (다국어 · 한국어 지원)';
  static override readonly locations: readonly RuntimeLocation[] = ['remote-onpremise'];
  static override readonly configSchema: readonly ConfigField[] = [
    {
      key: 'wsEndpoint',
      label: 'WebSocket URL',
      default: 'ws://localhost:8767',
      placeholder: 'ws://localhost:8767',
      hint: '온프레미스 백엔드: server/realtime_asr_server.py --engine sensevoice (기본 포트 8767) — ko/ja/en/zh/yue',
    },
  ];
}
