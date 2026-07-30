import { SttProvider, type ConfigField, type ProviderConfig, type RuntimeLocation, type SttInput } from '../core/SttProvider';
import { AudioPcmTap, floatTo16BitPCM } from '../core/AudioPcmTap';
import { SystemEvent, Mode } from '../core/events';

interface StreamingConfig extends ProviderConfig {
  wsEndpoint?: string;
  apiKey?: string;
}

/**
 * 클라우드 스트리밍 ASR Provider (WebSocket) — 골자.
 *
 * 파일/마이크 트랙을 AudioPcmTap으로 16kHz PCM으로 받아, 16-bit PCM 청크를
 * WebSocket으로 실시간 전송하고 interim/final 결과를 받는다.
 * (Qwen3 streaming, Deepgram, Google streaming 등 대부분 이 형태)
 *
 * ⚠️ 벤더마다 프로토콜(핸드셰이크/오디오 포맷/응답 스키마)이 다르다.
 *    아래는 "16k Int16 PCM 바이너리 전송 → {text,isFinal} JSON 수신"의 일반 골자이며,
 *    #onOpen / #send / #onMessage 를 실제 스펙에 맞춰 조정해야 한다(TODO).
 */
/**
 * 엔드포인트 → 사람이 읽는 엔진 이름 / 서버 기동 인자.
 * 연결 실패는 대개 "그 포트에 서버가 안 떠 있다"이므로, 에러 메시지에서 바로 명령을 알려준다.
 * configSchema의 select 옵션과 짝을 이룬다 — 옵션을 추가하면 여기도 함께 채운다.
 */
const ENGINE_BY_ENDPOINT: Record<string, string> = {
  'ws://localhost:8765': 'faster-whisper',
  'ws://localhost:8766': 'FunASR',
  'ws://localhost:8768': 'whisper_streaming',
};
const SERVE_ARGS_BY_ENDPOINT: Record<string, string> = {
  'ws://localhost:8765': '--engine faster-whisper --port 8765',
  'ws://localhost:8766': '--engine funasr --port 8766',
  'ws://localhost:8768': '--engine whisper-streaming --port 8768',
};

export class StreamingAsrProvider extends SttProvider<StreamingConfig> {
  // FunAsrProvider가 상속해 재선언할 수 있도록 리터럴이 아닌 string으로 선언
  static override readonly id: string = 'streaming';
  static override readonly label: string = 'Streaming ASR (faster-whisper 등)';
  static override readonly capabilities: readonly Mode[] = [Mode.FILE, Mode.MIC];
  // WebSocket 엔드포인트가 클라우드든 사내 자체 서버든 동일 프로토콜 — 둘 다 지원 (로컬(클라이언트) 처리 없음)
  static override readonly locations: readonly RuntimeLocation[] = ['remote-onpremise', 'remote-cloud'];
  static override readonly configSchema: readonly ConfigField[] = [
    {
      /**
       * 백엔드 선택 — 포트를 손으로 입력하면 오타·미기동 서버로 이어져 "웹소켓 에러"만 보게 된다.
       * 이 페이지는 엔진 비교용 테스트 콘솔이므로 동봉 서버의 고정 조합만 고르게 한다
       * (임의 엔드포인트가 필요하면 이 목록에 추가하는 것이 맞다 — 각 항목이 곧 기동 명령이다).
       */
      key: 'wsEndpoint',
      label: '백엔드 엔진 (WebSocket)',
      type: 'select',
      default: 'ws://localhost:8765',
      options: [
        { value: 'ws://localhost:8765', label: '8765 · faster-whisper 재전사 — 한국어 권장 (CER 14.5% · 마이크 10.4%)' },
        { value: 'ws://localhost:8768', label: '8768 · whisper_streaming 증분 — 긴 연속 발화용 (파일 18.4% · 짧은 발화엔 불리)' },
        { value: 'ws://localhost:8766', label: '8766 · FunASR paraformer — ⚠ 중국어 전용(한국어는 중국어 음절로 매핑)' },
      ],
      hint:
        '고른 포트에 해당 엔진 서버가 떠 있어야 한다 — 안 떠 있으면 연결 실패로 끝난다. ' +
        '기동: cd server && .venv/bin/python realtime_asr_server.py --engine <faster-whisper|whisper-streaming|funasr> --port <포트>. ' +
        'SenseVoice(8767)는 이 Provider가 아니라 위 Provider 목록에서 SenseVoice를 고른다. ' +
        '두 엔진을 동시에 띄우면 CPU를 다투어 양쪽 정확도가 함께 떨어진다 — 비교할 때는 하나만 켜라.',
    },
    { key: 'apiKey', label: 'API Key', type: 'password', placeholder: '(필요 시)' },
  ];

  static override isSupported(): boolean {
    return typeof WebSocket !== 'undefined';
  }

  #ws: WebSocket | null = null;
  #tap: AudioPcmTap | null = null;

  async start(input: SttInput): Promise<void> {
    // 시작 단계 실패는 throw — 엔진이 RECOGNITION_ERROR로 정규화하고 #active를 되돌린다
    if (!this.config.wsEndpoint) throw new Error('Streaming 미설정 — WebSocket URL 필요');
    if (!input.stream) throw new Error('PCM 스트림이 없습니다 (파일/마이크 캡처 실패)');
    this._active = true;

    const endpoint = this.config.wsEndpoint;
    this.#ws = new WebSocket(endpoint);
    this.#ws.binaryType = 'arraybuffer';
    this.#ws.onmessage = (e) => this.#onMessage(e);
    // 연결이 열리기 전에 끊기면 "서버가 안 떠 있다"가 압도적으로 흔한 원인이다.
    // 'WebSocket 에러' 한 줄만 띄우면 사용자가 무엇을 해야 할지 알 수 없어, 어느 포트에
    // 어떤 엔진을 띄워야 하는지까지 알려준다(실제로 8768을 안 띄운 채 고르고 헤맨 사례가 있었다).
    let opened = false;
    const engineHint = ENGINE_BY_ENDPOINT[endpoint] ?? '해당 엔진';
    this.#ws.onerror = () => {
      this._sink?.error(
        new Error(
          opened
            ? `WebSocket 통신 오류 (${endpoint})`
            : `${endpoint} 에 연결하지 못했습니다 — ${engineHint} 서버가 떠 있는지 확인하세요. ` +
              `기동: cd server && .venv/bin/python realtime_asr_server.py ${SERVE_ARGS_BY_ENDPOINT[endpoint] ?? '--engine <엔진> --port <포트>'}`,
        ),
      );
    };
    this.#ws.onopen = () => {
      opened = true;
      this.#onOpen(input.lang);
    };
    this.#ws.onclose = (e) => {
      if (!this._active) return;
      this._sink?.system(SystemEvent.STATUS, {
        message: opened ? 'WebSocket 종료됨' : `연결 실패 (${endpoint}) — 서버 미기동으로 보입니다`,
        level: opened ? undefined : 'warn',
      });
      void e;
    };

    // PCM 캡처 → 청크 전송
    this.#tap = new AudioPcmTap(input.stream, {
      onFrame: (pcm) => {
        if (this._active && this.#ws?.readyState === WebSocket.OPEN) {
          this.#send(floatTo16BitPCM(pcm).buffer);
        }
      },
    });
    await this.#tap.start();
    this._sink?.system(SystemEvent.STATUS, { message: 'Streaming ASR 전송 중…' });
  }

  override async stop(): Promise<void> {
    this._active = false;
    await this.#tap?.stop();
    this.#tap = null;
    const ws = this.#ws;
    this.#ws = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        // 종료 신호 → 서버가 잔여 청크 처리를 마치고 최종 결과를 보낸 뒤 닫는다.
        // 느린 엔진(FunASR CPU 등)의 처리 백로그를 감안해 최대 6초 대기.
        ws.send(JSON.stringify({ type: 'stop' }));
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 6000);
          ws.addEventListener(
            'close',
            () => {
              clearTimeout(timeout);
              resolve();
            },
            { once: true },
          );
        });
      } catch {
        /* noop */
      }
    }
    try {
      ws?.close();
    } catch {
      /* noop */
    }
  }

  // ── 벤더별로 조정할 지점 ──────────────────────────────────────────
  #onOpen(lang: string | undefined): void {
    // TODO: 핸드셰이크/설정 프레임 전송 (샘플레이트/언어/인증 등)
    const init = { type: 'start', sampleRate: 16000, language: lang, apiKey: this.config.apiKey || undefined };
    this.#ws?.send(JSON.stringify(init));
  }

  #send(arrayBuffer: ArrayBuffer): void {
    // TODO: 벤더가 base64/JSON 래핑을 요구하면 여기서 변환
    this.#ws?.send(arrayBuffer);
  }

  #onMessage(event: MessageEvent): void {
    // TODO: 응답 스키마에 맞게 파싱
    try {
      const data = JSON.parse(typeof event.data === 'string' ? event.data : '');
      const text: unknown = data.text ?? data.transcript ?? data.channel?.alternatives?.[0]?.transcript ?? '';
      const isFinal: boolean = Boolean(data.isFinal ?? data.is_final ?? data.type === 'final');
      if (!text) return;
      // 중지 대기 중에는 최종 결과만 받는다(늦게 도착하는 partial 무시)
      if (!this._active && !isFinal) return;
      if (isFinal) this._sink?.final(String(text).trim());
      else this._sink?.partial(String(text).trim());
    } catch {
      /* 바이너리/비JSON 메시지 무시 */
    }
  }
}
