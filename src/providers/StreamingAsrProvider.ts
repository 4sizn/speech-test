import { StreamingAsrProvider as KitStreamingAsrProvider } from '@rsupport/rvs-stt-kit/streaming';
import { SttProvider, type ConfigField, type ProviderConfig, type RuntimeLocation, type SttInput } from '../core/SttProvider';
import { SystemEvent, Mode } from '../core/events';
import { streamingEndpoints } from './rvsSttKitAdapter';

interface StreamingConfig extends ProviderConfig {
  wsEndpoint?: string;
  apiKey?: string;
}

/**
 * speech-test UI/registry adapter for the UML-approved rvs-stt-kit shared
 * PCM-over-WebSocket transport. This class intentionally owns only the legacy
 * presentation contract (static metadata and actionable connection messages);
 * browser PCM capture, frame encoding, WebSocket lifecycle and final drain are
 * owned by the kit's StreamingAsrProvider.
 */
const ENGINE_BY_ENDPOINT: Record<string, string> = {
  [streamingEndpoints.fasterWhisper]: 'faster-whisper',
  [streamingEndpoints.funAsr]: 'FunASR',
  [streamingEndpoints.whisperStreaming]: 'whisper_streaming',
  [streamingEndpoints.senseVoice]: 'SenseVoice',
};
const SERVE_ARGS_BY_ENDPOINT: Record<string, string> = {
  [streamingEndpoints.fasterWhisper]: '--engine faster-whisper --port 8765',
  [streamingEndpoints.funAsr]: '--engine funasr --port 8766',
  [streamingEndpoints.whisperStreaming]: '--engine whisper-streaming --port 8768',
  [streamingEndpoints.senseVoice]: '--engine sensevoice --port 8767',
};

export class StreamingAsrProvider extends SttProvider<StreamingConfig> {
  static override readonly id: string = 'streaming';
  static override readonly label: string = 'Streaming ASR (faster-whisper 등)';
  static override readonly capabilities: readonly Mode[] = [Mode.FILE, Mode.MIC];
  static override readonly locations: readonly RuntimeLocation[] = ['remote-onpremise', 'remote-cloud'];
  static override readonly configSchema: readonly ConfigField[] = [
    {
      key: 'wsEndpoint',
      label: '백엔드 엔진 (WebSocket)',
      type: 'select',
      default: streamingEndpoints.fasterWhisper,
      options: [
        { value: streamingEndpoints.fasterWhisper, label: '8765 · faster-whisper 재전사 — 한국어 권장 (CER 14.5% · 마이크 10.4%)' },
        { value: streamingEndpoints.whisperStreaming, label: '8768 · whisper_streaming 증분 — 긴 연속 발화용 (파일 18.4% · 짧은 발화엔 불리)' },
        { value: streamingEndpoints.funAsr, label: '8766 · FunASR paraformer — ⚠ 중국어 전용(한국어는 중국어 음절로 매핑)' },
      ],
      hint:
        '고른 포트에 해당 엔진 서버가 떠 있어야 한다. ' +
        '기동: cd server && .venv/bin/python realtime_asr_server.py --engine <faster-whisper|whisper-streaming|funasr> --port <포트>. ' +
        'SenseVoice(8767)는 별도 Provider로 선택한다. 비교 시 서버를 동시에 띄우면 CPU를 다툰다.',
    },
  ];

  static override isSupported(): boolean {
    return typeof WebSocket !== 'undefined';
  }

  #delegate: KitStreamingAsrProvider | null = null;

  async start(input: SttInput): Promise<void> {
    if (!this.config.wsEndpoint) throw new Error('Streaming 미설정 — WebSocket URL 필요');
    if (!input.stream) throw new Error('PCM 스트림이 없습니다 (파일/마이크 캡처 실패)');
    if (this._active) throw new Error('Streaming ASR가 이미 실행 중입니다');

    const endpoint = this.config.wsEndpoint;
    const delegate = new KitStreamingAsrProvider({ endpoint, lang: input.lang ?? this.config.lang });
    delegate.bind({
      partial: (text) => this._sink?.partial(text),
      final: (text) => this._sink?.final(text),
      system: (type, payload) => this._sink?.system(type, payload),
      error: (error) => this._sink?.error(this.#connectionError(error, endpoint)),
    });

    this.#delegate = delegate;
    this._active = true;
    try {
      await delegate.start({
        kind: 'stream',
        sourceKind: input.mode === Mode.MIC ? 'device-mic' : 'captured-track',
        stream: input.stream,
      });
      this._sink?.system(SystemEvent.STATUS, { message: 'Streaming ASR 전송 중…' });
    } catch (error) {
      this._active = false;
      this.#delegate = null;
      throw this.#connectionError(error, endpoint);
    }
  }

  override async stop(): Promise<void> {
    this._active = false;
    const delegate = this.#delegate;
    this.#delegate = null;
    await delegate?.stop();
  }

  #connectionError(error: unknown, endpoint: string): Error {
    const message = error instanceof Error ? error.message : String(error);
    const engine = ENGINE_BY_ENDPOINT[endpoint] ?? '해당 엔진';
    const command = SERVE_ARGS_BY_ENDPOINT[endpoint] ?? '--engine <엔진> --port <포트>';
    if (/WebSocket|connect|network/i.test(message)) {
      return new Error(`${endpoint} 연결 실패 (${engine}) — 서버를 확인하세요. 기동: cd server && .venv/bin/python realtime_asr_server.py ${command}`);
    }
    return error instanceof Error ? error : new Error(message);
  }
}
