import { SystemEvent } from './events.js';

/**
 * @typedef {Object} TranscriptSink
 * STT 결과/상태가 흘러나가는 주입된 채널. 엔진이 bind()로 주입한다.
 * Provider는 자신이 어떤 이벤트버스에 연결됐는지 알 필요가 없다(역의존 차단).
 * @property {(text: string, meta?: object) => void} partial  - 인식 중(interim) 텍스트
 * @property {(text: string, meta?: object) => void} final    - 확정(final) 텍스트
 * @property {(type: string, payload?: object) => void} system - 시스템 이벤트 발행
 * @property {(error: Error) => void} error                    - 에러 발행
 */

/**
 * @typedef {Object} SttInput
 * 엔진이 모드에 맞춰 조립해 Provider.start()로 넘기는 입력.
 * @property {string} mode                    - Mode 값
 * @property {MediaStream} [stream]           - 마이크 스트림(mic / loopback)
 * @property {HTMLAudioElement} [audioEl]     - 재생 중인 오디오 엘리먼트(file)
 * @property {File} [file]                    - 업로드 파일(file)
 * @property {string} [lang]                  - 인식 언어
 */

/**
 * 모든 STT Provider의 추상 베이스(=어댑터).
 *
 * ws-network의 WebSocketClientAdapter<T>와 같은 역할:
 * 서로 다른 STT 백엔드(브라우저 Web Speech API, 클라우드 ASR 등)의
 * 제각각인 API를 단일 인터페이스로 흡수한다.
 *
 * 서브클래스는 static id / label / capabilities를 선언하고
 * start()/stop()을 구현한다. 결과는 주입된 sink로만 내보낸다.
 *
 * @abstract
 */
export class SttProvider {
  /** @type {string} 고유 식별자 (레지스트리 키) */
  static id = 'abstract';
  /** @type {string} 사람이 읽는 이름 */
  static label = 'Abstract Provider';
  /** @type {string[]} 지원 모드(Mode). 엔진이 이걸로 모드 주입을 게이팅한다. */
  static capabilities = [];

  /**
   * @type {Array<{key:string,label:string,type?:string,placeholder?:string,default?:string}>}
   * Provider가 필요로 하는 설정 스키마. UI가 이걸 보고 설정 폼을 자동 렌더한다(하드코딩 제거).
   */
  static configSchema = [];

  /**
   * @type {'stream'|'loopback'|'upload'}
   * 파일 모드에서 엔진이 어떤 입력을 만들어 줘야 하는지 선언한다.
   *  - 'stream'   : 재생 트랙을 captureStream으로 캡처한 MediaStream (Whisper/Streaming)
   *  - 'loopback' : 마이크 스트림 + 파일을 스피커로 재생(음향 루프백). WebSpeech 전용 한계 우회.
   *  - 'upload'   : 가공 없이 원본 File (클라우드 업로드형, Qwen3)
   */
  static fileInputKind = 'stream';

  /**
   * 런타임 지원 여부. 브라우저 API 의존 Provider가 override.
   * @returns {boolean}
   */
  static isSupported() {
    return true;
  }

  /** @param {object} [config] Provider별 설정(엔드포인트/키/언어 등) */
  constructor(config = {}) {
    /** @type {object} */
    this.config = config;
    /** @type {TranscriptSink|null} */
    this._sink = null;
    /** @type {boolean} */
    this._active = false;
  }

  get id() {
    return /** @type {typeof SttProvider} */ (this.constructor).id;
  }

  get label() {
    return /** @type {typeof SttProvider} */ (this.constructor).label;
  }

  get capabilities() {
    return /** @type {typeof SttProvider} */ (this.constructor).capabilities;
  }

  get configSchema() {
    return /** @type {typeof SttProvider} */ (this.constructor).configSchema;
  }

  get fileInputKind() {
    return /** @type {typeof SttProvider} */ (this.constructor).fileInputKind;
  }

  /** 모드 지원 여부. */
  supports(mode) {
    return this.capabilities.includes(mode);
  }

  /**
   * 결과 싱크를 주입받는다(엔진이 호출). === 의존성 주입 지점.
   * @param {TranscriptSink} sink
   */
  bind(sink) {
    this._sink = sink;
  }

  /** 설정을 갱신한다. */
  configure(config) {
    this.config = { ...this.config, ...config };
  }

  /** 일회성 초기화(권한/연결 등). 기본은 no-op. */
  async init() {
    this._sink?.system(SystemEvent.PROVIDER_INIT, { provider: this.id });
  }

  /**
   * 인식을 시작한다.
   * @param {SttInput} _input
   * @abstract
   */
  async start(_input) {
    throw new Error(`[${this.id}] start() not implemented`);
  }

  /** 인식을 중지한다. */
  async stop() {
    this._active = false;
  }

  /** 자원 해제. */
  async dispose() {
    await this.stop();
    this._sink = null;
  }
}
