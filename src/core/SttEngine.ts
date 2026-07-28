import { EventBus } from './EventBus';
import { EventCategory, SystemEvent, FeatureEvent, Mode } from './events';
import type { ProviderRegistry, ProviderMeta } from './ProviderRegistry';
import type { ProviderConfig, SttInput, SttProvider, TranscriptSink } from './SttProvider';

/**
 * STT 파사드(Facade).
 *
 * ws-network의 WebSocketClient, RVS의 SDK에 대응하는 단일 진입점.
 * 소비자(UI)는 이 클래스 하나만 알면 된다:
 *   - 어떤 Provider를 쓸지 주입(useProvider)
 *   - 어떤 모드로 들을지 선택(setMode)
 *   - 오디오 로드/시작/중지
 * 그러면 Provider 종류와 무관하게 동일한 이벤트가 bus로 흘러나온다.
 *
 * Provider의 결과는 주입된 sink를 거쳐 EventBus로 정규화되며,
 * 시스템 이벤트(생명주기/상태)와 기능 이벤트(STT 결과)로 분리되어 발행된다.
 */
export class SttEngine {
  #bus = new EventBus();
  #registry: ProviderRegistry;
  #provider: SttProvider | null = null;
  #mode: Mode = Mode.MIC;
  #lang = 'ko-KR';

  #audio: HTMLAudioElement | null = null;
  #file: File | null = null;
  #objectUrl = '';

  // 마이크 레벨 미터용
  #micStream: MediaStream | null = null;
  #audioCtx: AudioContext | null = null;
  #analyser: AnalyserNode | null = null;
  #rafId = 0;

  // 파일 트랙 캡처(Web Audio fallback용 — createMediaElementSource는 1회만 허용)
  #captureCtx: AudioContext | null = null;
  #elementSource: MediaElementAudioSourceNode | null = null;
  #captureDest: MediaStreamAudioDestinationNode | null = null;

  #active = false;

  constructor(registry: ProviderRegistry) {
    this.#registry = registry;
  }

  /** 외부 구독용 이벤트 버스. */
  get bus(): EventBus {
    return this.#bus;
  }
  get mode(): Mode {
    return this.#mode;
  }
  get lang(): string {
    return this.#lang;
  }
  get provider(): SttProvider | null {
    return this.#provider;
  }
  get file(): File | null {
    return this.#file;
  }
  get isActive(): boolean {
    return this.#active;
  }

  listProviders(): ProviderMeta[] {
    return this.#registry.list();
  }

  /** 엔진을 준비 완료 상태로 알린다. */
  ready(): void {
    this.#bus.emit(EventCategory.SYSTEM, SystemEvent.ENGINE_READY, {
      providers: this.listProviders(),
    });
  }

  // ─── Provider 주입 (의존성 주입) ────────────────────────────────────
  /** 사용할 Provider를 주입한다. */
  async useProvider(id: string, config: ProviderConfig = {}): Promise<void> {
    if (this.#active) await this.stop();
    await this.#provider?.dispose();

    this.#provider = this.#registry.create(id, { lang: this.#lang, ...config });
    this.#provider.bind(this.#makeSink());
    await this.#provider.init();

    // 현재 모드가 지원되지 않으면 Provider의 첫 지원 모드로 보정
    if (!this.#provider.supports(this.#mode)) {
      this.#mode = this.#provider.capabilities[0] ?? Mode.MIC;
      this.#bus.emit(EventCategory.SYSTEM, SystemEvent.MODE_CHANGED, {
        mode: this.#mode,
        auto: true,
      });
    }

    this.#bus.emit(EventCategory.SYSTEM, SystemEvent.PROVIDER_CHANGED, {
      provider: id,
      label: this.#provider.label,
      capabilities: this.#provider.capabilities,
      configSchema: this.#provider.configSchema,
      fileInputKind: this.#provider.fileInputKind,
      locations: this.#provider.locations,
      location: this.#provider.location,
      mode: this.#mode,
    });
  }

  /** Provider 설정 갱신(예: Qwen 엔드포인트/키). */
  configureProvider(config: ProviderConfig): void {
    this.#provider?.configure(config);
  }

  setMode(mode: Mode): void {
    if (this.#provider && !this.#provider.supports(mode)) {
      throw new Error(
        `[${this.#provider.id}] 모드 "${mode}" 미지원. 지원: [${this.#provider.capabilities.join(', ')}]`,
      );
    }
    this.#mode = mode;
    this.#bus.emit(EventCategory.SYSTEM, SystemEvent.MODE_CHANGED, { mode });
  }

  setLang(lang: string): void {
    this.#lang = lang;
    this.#provider?.configure({ lang });
  }

  // ─── 오디오 입력 ─────────────────────────────────────────────────────
  /** index.html의 <audio>를 연결하고 재생 이벤트를 시스템 이벤트로 승격한다. */
  attachAudioElement(el: HTMLAudioElement): void {
    this.#audio = el;
    el.addEventListener('play', () =>
      this.#bus.emit(EventCategory.SYSTEM, SystemEvent.AUDIO_PLAY, {}),
    );
    el.addEventListener('pause', () =>
      this.#bus.emit(EventCategory.SYSTEM, SystemEvent.AUDIO_PAUSE, {}),
    );
    el.addEventListener('ended', () => {
      this.#bus.emit(EventCategory.SYSTEM, SystemEvent.AUDIO_ENDED, {});
      // 파일 재생이 끝나면 인식도 종료
      if (this.#active && (this.#mode === Mode.FILE || this.#mode === Mode.FILE_LOOPBACK)) void this.stop();
    });
  }

  /** 업로드한 파일을 오디오 소스로 로드한다. */
  loadFile(file: File): void {
    if (!this.#audio) throw new Error('audio 엘리먼트가 연결되지 않았습니다');
    if (this.#objectUrl) URL.revokeObjectURL(this.#objectUrl);
    this.#objectUrl = URL.createObjectURL(file);
    this.#audio.src = this.#objectUrl;
    this.#file = file;
    this.#bus.emit(EventCategory.SYSTEM, SystemEvent.AUDIO_LOADED, {
      name: file.name,
      size: file.size,
      type: file.type,
    });
  }

  play(): Promise<void> | undefined {
    return this.#audio?.play();
  }
  pause(): void {
    this.#audio?.pause();
  }

  /**
   * <audio> 출력을 특정 장치로 라우팅한다(setSinkId).
   * 가상 오디오 장치로 보내고 그 장치를 OS 기본 입력으로 두면,
   * WebSpeech가 파일 오디오를 음향(공기) 없이 디지털로 인식한다 — 노이즈/볼륨 무관.
   * @param deviceId enumerateDevices의 audiooutput deviceId ('default' 가능)
   */
  async setOutputSink(deviceId: string): Promise<void> {
    if (typeof this.#audio?.setSinkId !== 'function') {
      throw new Error('이 브라우저는 출력 라우팅(setSinkId)을 지원하지 않습니다');
    }
    await this.#audio.setSinkId(deviceId);
    this.#bus.emit(EventCategory.SYSTEM, SystemEvent.STATUS, {
      message: `출력 라우팅 → ${deviceId === 'default' ? '기본 장치' : deviceId.slice(0, 8) + '…'}`,
    });
  }

  // ─── 인식 제어 ───────────────────────────────────────────────────────
  async start(): Promise<void> {
    if (!this.#provider) throw new Error('Provider가 선택되지 않았습니다');
    // 모델 로딩 등 준비 단계에서 재클릭 시 이중 시작 방지
    if (this.#active) throw new Error('이미 인식이 진행/준비 중입니다 — 먼저 중지하세요');
    if (!this.#provider.supports(this.#mode)) {
      throw new Error(`현재 Provider는 "${this.#mode}" 모드를 지원하지 않습니다`);
    }
    this.#active = true;
    try {
      // 모델 로드 같은 무거운 준비를 재생/캡처 시작 *전에* 끝낸다 —
      // 준비 중에 재생된 파일 앞부분이 인식에서 잘리는 문제 방지
      await this.#provider.prepare();
    } catch (err) {
      this.#active = false;
      this.#bus.emit(EventCategory.SYSTEM, SystemEvent.RECOGNITION_ERROR, {
        message: err instanceof Error ? err.message : String(err),
        provider: this.#provider.id,
      });
      throw err;
    }
    if (!this.#active) return; // 준비 중 사용자가 중지함
    try {
      const input = await this.#buildInput();
      await this.#provider.start(input);
    } catch (err) {
      this.#active = false;
      throw err;
    }
    this.#bus.emit(EventCategory.SYSTEM, SystemEvent.RECOGNITION_STARTED, {
      provider: this.#provider.id,
      mode: this.#mode,
    });
  }

  async stop(): Promise<void> {
    this.#active = false;
    await this.#provider?.stop();
    this.#stopLevelMeter();
    this.#releaseMic();
    if (this.#mode === Mode.FILE || this.#mode === Mode.FILE_LOOPBACK) this.pause();
    this.#bus.emit(EventCategory.SYSTEM, SystemEvent.RECOGNITION_STOPPED, {});
  }

  /** 모드에 맞춰 Provider 입력을 조립한다. */
  async #buildInput(): Promise<SttInput> {
    const base = { mode: this.#mode, lang: this.#lang, audioEl: this.#audio };

    // 마이크 모드
    if (this.#mode === Mode.MIC) {
      const stream = await this.#ensureMicStream();
      return { ...base, stream };
    }

    // 명시적 루프백 모드(하위호환)
    if (this.#mode === Mode.FILE_LOOPBACK) {
      if (!this.#file) throw new Error('파일을 먼저 선택하세요');
      const stream = await this.#ensureMicStream();
      await this.play();
      return { ...base, stream, loopback: true };
    }

    // 파일 모드 — Provider가 선언한 입력 방식(fileInputKind)대로 조립
    if (!this.#file) throw new Error('파일을 먼저 선택하세요');
    const kind = this.#provider?.fileInputKind ?? 'stream';

    if (kind === 'loopback') {
      // WebSpeech: 디지털 주입 불가 → 마이크 켜고 파일을 스피커로 재생(음향 루프백)
      const stream = await this.#ensureMicStream();
      await this.play();
      return { ...base, stream, loopback: true };
    }

    if (kind === 'upload') {
      // 클라우드 업로드형 — 원본 File 전달 (+ 사용자 청취용 재생)
      void this.play()?.catch(() => {});
      return { ...base, file: this.#file };
    }

    // 'stream' — 재생 트랙을 captureStream으로 디지털 캡처 (Whisper/Streaming)
    await this.play();
    const stream = this.#captureFileStream();
    if (stream) this.#startLevelMeter(stream);
    return { ...base, file: this.#file, stream };
  }

  /** 재생 중인 <audio>의 출력 트랙을 MediaStream으로 캡처한다(스피커 우회). */
  #captureFileStream(): MediaStream | null {
    const a = this.#audio;
    if (!a) return null;
    if (typeof a.captureStream === 'function') return a.captureStream();
    if (typeof a.mozCaptureStream === 'function') return a.mozCaptureStream();
    // Web Audio fallback
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      if (!this.#captureCtx) {
        this.#captureCtx = new Ctx();
        this.#elementSource = this.#captureCtx.createMediaElementSource(a);
        this.#captureDest = this.#captureCtx.createMediaStreamDestination();
        this.#elementSource.connect(this.#captureDest);
        this.#elementSource.connect(this.#captureCtx.destination); // 사용자 청취 유지
      }
      return this.#captureDest?.stream ?? null;
    } catch (err) {
      console.warn('[SttEngine] captureFileStream fallback 실패', err);
      return null;
    }
  }

  // ─── 마이크 레벨 미터 ────────────────────────────────────────────────
  async #ensureMicStream(): Promise<MediaStream> {
    if (this.#micStream) return this.#micStream;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('이 환경에서는 마이크 접근이 불가합니다 (https/localhost 필요)');
    }
    this.#micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.#startLevelMeter(this.#micStream);
    return this.#micStream;
  }

  #startLevelMeter(stream: MediaStream): void {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.#audioCtx = new Ctx();
      const src = this.#audioCtx.createMediaStreamSource(stream);
      this.#analyser = this.#audioCtx.createAnalyser();
      this.#analyser.fftSize = 512;
      src.connect(this.#analyser);
      const data = new Uint8Array(this.#analyser.frequencyBinCount);

      const tick = () => {
        if (!this.#analyser) return;
        this.#analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const level = sum / data.length / 255; // 0~1
        this.#bus.emit(EventCategory.SYSTEM, SystemEvent.AUDIO_LEVEL, { level });
        this.#rafId = requestAnimationFrame(tick);
      };
      this.#rafId = requestAnimationFrame(tick);
    } catch (err) {
      console.warn('[SttEngine] level meter 비활성', err);
    }
  }

  #stopLevelMeter(): void {
    if (this.#rafId) cancelAnimationFrame(this.#rafId);
    this.#rafId = 0;
    this.#analyser = null;
    this.#audioCtx?.close().catch(() => {});
    this.#audioCtx = null;
    this.#bus.emit(EventCategory.SYSTEM, SystemEvent.AUDIO_LEVEL, { level: 0 });
  }

  #releaseMic(): void {
    this.#micStream?.getTracks().forEach((t) => t.stop());
    this.#micStream = null;
  }

  /** Provider에 주입되는 결과 싱크. Provider→EventBus 정규화 지점. */
  #makeSink(): TranscriptSink {
    return {
      partial: (text, meta = {}) =>
        this.#bus.emit(EventCategory.FEATURE, FeatureEvent.TRANSCRIPT_PARTIAL, {
          text,
          provider: this.#provider?.id,
          mode: this.#mode,
          ...meta,
        }),
      final: (text, meta = {}) =>
        this.#bus.emit(EventCategory.FEATURE, FeatureEvent.TRANSCRIPT_FINAL, {
          text,
          provider: this.#provider?.id,
          mode: this.#mode,
          ...meta,
        }),
      system: (type, payload = {}) =>
        this.#bus.emit(EventCategory.SYSTEM, type, {
          provider: this.#provider?.id,
          ...payload,
        }),
      error: (err) =>
        this.#bus.emit(EventCategory.SYSTEM, SystemEvent.RECOGNITION_ERROR, {
          message: err instanceof Error ? err.message : String(err),
          provider: this.#provider?.id,
        }),
    };
  }
}
