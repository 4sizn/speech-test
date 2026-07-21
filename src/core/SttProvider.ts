import { SystemEvent, Mode } from './events';

/**
 * STT 결과/상태가 흘러나가는 주입된 채널. 엔진이 bind()로 주입한다.
 * Provider는 자신이 어떤 이벤트버스에 연결됐는지 알 필요가 없다(역의존 차단).
 */
export interface TranscriptSink {
  /** 인식 중(interim) 텍스트 */
  partial(text: string, meta?: Record<string, unknown>): void;
  /** 확정(final) 텍스트 */
  final(text: string, meta?: Record<string, unknown>): void;
  /** 시스템 이벤트 발행 */
  system(type: string, payload?: Record<string, unknown>): void;
  /** 에러 발행 */
  error(error: unknown): void;
}

/** 엔진이 모드에 맞춰 조립해 Provider.start()로 넘기는 입력. */
export interface SttInput {
  mode: Mode;
  /** 인식 언어 */
  lang?: string;
  /** 재생 중인 오디오 엘리먼트(file) */
  audioEl?: HTMLAudioElement | null;
  /** 마이크 스트림(mic/loopback) 또는 파일 캡처 스트림(file) */
  stream?: MediaStream | null;
  /** 업로드 파일(file) */
  file?: File | null;
  /** 음향 루프백 여부 */
  loopback?: boolean;
}

/** Provider 설정 폼 자동 렌더용 필드 스키마. */
export interface ConfigField {
  key: string;
  label: string;
  type?: 'text' | 'url' | 'password' | 'checkbox';
  placeholder?: string;
  default?: string | boolean;
}

/**
 * 파일 모드에서 엔진이 어떤 입력을 만들어 줘야 하는지 선언한다.
 *  - 'stream'   : 재생 트랙을 captureStream으로 캡처한 MediaStream (Whisper/Streaming)
 *  - 'loopback' : 마이크 스트림 + 파일을 스피커로 재생(음향 루프백). WebSpeech 전용 한계 우회.
 *  - 'upload'   : 가공 없이 원본 File (클라우드 업로드형, Qwen3)
 */
export type FileInputKind = 'stream' | 'loopback' | 'upload';

/** Provider별 설정(엔드포인트/키/언어 등). 서브클래스가 구체 필드로 확장한다. */
export interface ProviderConfig {
  lang?: string;
  [key: string]: unknown;
}

/** 레지스트리가 다루는 Provider 클래스(정적 측) 계약. */
export interface SttProviderClass<C extends ProviderConfig = ProviderConfig> {
  readonly id: string;
  readonly label: string;
  readonly capabilities: readonly Mode[];
  readonly configSchema: readonly ConfigField[];
  readonly fileInputKind: FileInputKind;
  isSupported(): boolean;
  new (config?: C): SttProvider<C>;
}

/**
 * 모든 STT Provider의 추상 베이스(=어댑터).
 *
 * ws-network의 WebSocketClientAdapter<T>와 같은 역할:
 * 서로 다른 STT 백엔드(브라우저 Web Speech API, 클라우드 ASR 등)의
 * 제각각인 API를 단일 인터페이스로 흡수한다.
 *
 * 서브클래스는 static id / label / capabilities를 선언하고
 * start()/stop()을 구현한다. 결과는 주입된 sink로만 내보낸다.
 */
export abstract class SttProvider<C extends ProviderConfig = ProviderConfig> {
  /** 고유 식별자 (레지스트리 키) */
  static readonly id: string = 'abstract';
  /** 사람이 읽는 이름 */
  static readonly label: string = 'Abstract Provider';
  /** 지원 모드(Mode). 엔진이 이걸로 모드 주입을 게이팅한다. */
  static readonly capabilities: readonly Mode[] = [];
  /** Provider가 필요로 하는 설정 스키마. UI가 이걸 보고 설정 폼을 자동 렌더한다(하드코딩 제거). */
  static readonly configSchema: readonly ConfigField[] = [];
  static readonly fileInputKind: FileInputKind = 'stream';

  /** 런타임 지원 여부. 브라우저 API 의존 Provider가 override. */
  static isSupported(): boolean {
    return true;
  }

  config: C;
  protected _sink: TranscriptSink | null = null;
  protected _active = false;

  constructor(config?: C) {
    this.config = config ?? ({} as C);
  }

  /** 정적 측 접근용 — `this.constructor`를 한 번만 좁힌다. */
  #static(): SttProviderClass {
    return this.constructor as unknown as SttProviderClass;
  }

  get id(): string {
    return this.#static().id;
  }

  get label(): string {
    return this.#static().label;
  }

  get capabilities(): readonly Mode[] {
    return this.#static().capabilities;
  }

  get configSchema(): readonly ConfigField[] {
    return this.#static().configSchema;
  }

  get fileInputKind(): FileInputKind {
    return this.#static().fileInputKind;
  }

  /** 모드 지원 여부. */
  supports(mode: Mode): boolean {
    return this.capabilities.includes(mode);
  }

  /** 결과 싱크를 주입받는다(엔진이 호출). === 의존성 주입 지점. */
  bind(sink: TranscriptSink): void {
    this._sink = sink;
  }

  /** 설정을 갱신한다. */
  configure(config: Partial<C> & ProviderConfig): void {
    this.config = { ...this.config, ...config };
  }

  /** 일회성 초기화(권한/연결 등). 기본은 no-op. */
  async init(): Promise<void> {
    this._sink?.system(SystemEvent.PROVIDER_INIT, { provider: this.id });
  }

  /** 인식을 시작한다. */
  abstract start(input: SttInput): Promise<void>;

  /** 인식을 중지한다. */
  async stop(): Promise<void> {
    this._active = false;
  }

  /** 자원 해제. */
  async dispose(): Promise<void> {
    await this.stop();
    this._sink = null;
  }
}
