import { SttProvider, type ConfigField, type ProviderConfig, type RuntimeLocation, type SttInput } from '../core/SttProvider';
import { SystemEvent, Mode } from '../core/events';

interface WebSpeechConfig extends ProviderConfig {
  /** @deprecated location('local-client')으로 대체. 과거 저장값 호환용으로만 읽는다. */
  processLocally?: boolean;
}

function getSR(): SpeechRecognitionStatic | undefined {
  return window.SpeechRecognition || window.webkitSpeechRecognition;
}

/**
 * 브라우저 Web Speech API(SpeechRecognition) Provider.
 *
 * ── 핵심(2026~) ──
 * SpeechRecognition.start()에 `MediaStreamTrack` 오버로드가 추가되어,
 * 파일 재생 트랙(audio.captureStream())을 *디지털로 직접* 인식시킬 수 있다.
 * 스피커→마이크 음향 루프백이 필요 없고, 주변 소음/스피커 볼륨과 완전 무관하다.
 * 스펙상 audioTrack 경로는 마이크 권한을 요구하지 않는다(requestMicrophonePermission=false).
 *
 *   - mic  : 엔진이 준 마이크 트랙으로 start(track) (없으면 기본 마이크 start())
 *   - file : 엔진이 captureStream으로 캡처한 파일 오디오 트랙으로 start(track)  ← 노이즈/볼륨 무관
 *
 * Chromium 데스크톱(Chrome/Edge, ~M133+) 전용. 미지원 환경은 파일 모드에서 안내 후 폴백 권장.
 */
export class WebSpeechProvider extends SttProvider<WebSpeechConfig> {
  static override readonly id = 'webspeech';
  static override readonly label = 'Browser Web Speech API';
  static override readonly capabilities: readonly Mode[] = [Mode.MIC, Mode.FILE];
  // 파일 트랙을 captureStream으로 디지털 캡처해 start(track)로 주입 (음향 루프백 폐기)
  static override readonly fileInputKind = 'stream';
  // 기본은 브라우저 벤더 클라우드 인식, local-client 선택 시 클라이언트 온디바이스(processLocally) 인식
  static override readonly locations: readonly RuntimeLocation[] = ['remote-cloud', 'local-client'];
  static override readonly configSchema: readonly ConfigField[] = [];

  static override isSupported(): boolean {
    return typeof window !== 'undefined' && Boolean(getSR());
  }

  /** start(MediaStreamTrack) 오버로드 지원 여부(런타임 1회 탐지, 캐시). */
  static #trackInput: boolean | undefined;
  static supportsAudioTrackInput(): boolean {
    if (this.#trackInput !== undefined) return this.#trackInput;
    const SR = getSR();
    if (!SR) return (this.#trackInput = false);
    try {
      // 오버로드가 있으면 {}→MediaStreamTrack 변환 실패로 TypeError(시작 안 됨).
      // 없으면 여분 인자 무시되어 마이크로 시작 → 즉시 abort.
      const rec = new SR();
      rec.start({});
      try {
        rec.abort();
      } catch {
        /* noop */
      }
      return (this.#trackInput = false);
    } catch (e) {
      return (this.#trackInput = e instanceof Error && e.name === 'TypeError');
    }
  }

  #rec: SpeechRecognition | null = null;
  #track: MediaStreamTrack | null = null;
  /** 온디바이스 모델 확인 결과 — prepare()에서 미리 정해두고 start()에서는 쓰기만 한다 */
  #offline: boolean | null = null;

  /**
   * 온디바이스(SODA) 모델 가용성 확인·설치를 재생 **전에** 끝낸다.
   *
   * start() 안에서 확인하면 엔진이 이미 파일 재생을 시작한 뒤라, 모델 조회/다운로드가 걸리는
   * 사이에 짧은 파일은 재생이 끝나 captureStream 트랙이 죽는다 —
   * `start(track)`이 "MediaStreamTrack is not of state 'live'"로 실패한다(E2E QA에서 검출).
   */
  override async prepare(): Promise<void> {
    const wantOffline = this.config.location
      ? this.location === 'local-client'
      : Boolean(this.config.processLocally);
    if (!wantOffline) {
      this.#offline = false;
      return;
    }
    const lang = String(this.config.lang || 'ko-KR');
    const ok = await this.#ensureLocalModel(lang);
    this.#offline = ok !== false;
  }

  async start(input: SttInput): Promise<void> {
    // 시작 단계 실패는 throw — 엔진이 RECOGNITION_ERROR로 정규화하고 #active를 되돌린다
    const SR = getSR();
    if (!SR) throw new Error('이 브라우저는 Web Speech API를 지원하지 않습니다 (Chrome/Edge 권장)');

    // 입력 트랙 결정
    const track = input.stream?.getAudioTracks?.()[0] ?? null;
    const canTrack = WebSpeechProvider.supportsAudioTrackInput();
    const isFile = input.mode === Mode.FILE || input.mode === Mode.FILE_LOOPBACK;

    if (isFile && (!track || !canTrack)) {
      throw new Error(
        !canTrack
          ? '이 브라우저는 SpeechRecognition 오디오 트랙 입력을 지원하지 않습니다. Whisper Provider를 쓰거나 최신 Chrome을 사용하세요.'
          : '파일 오디오 트랙을 캡처하지 못했습니다.',
      );
    }

    const rec = new SR();
    rec.lang = input.lang || this.config.lang || 'ko-KR';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      const base = isFile ? '파일 인식 중 (오디오 트랙 직접 입력 · 노이즈/볼륨 무관)' : '마이크 인식 중';
      this._sink?.system(SystemEvent.STATUS, {
        message: base + (rec.processLocally ? ' · 🔒 오프라인(온디바이스)' : ' · ☁ 온라인'),
      });
    };

    rec.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? '';
        if (result.isFinal) this._sink?.final(transcript.trim(), { confidence: result[0]?.confidence });
        else interim += transcript;
      }
      if (interim) this._sink?.partial(interim.trim());
    };

    let fatal = false;
    rec.onerror = (event) => {
      if (event.error === 'aborted' || event.error === 'no-speech') return; // 양성: 자동재시작에 맡김
      // 치명적 에러는 재시작하면 무한 루프 → 중단
      const FATAL = ['not-allowed', 'service-not-allowed', 'language-not-supported', 'audio-capture', 'network'];
      if (FATAL.includes(event.error)) {
        fatal = true;
        this._active = false;
      }
      this._sink?.error(new Error(`SpeechRecognition error: ${event.error}`));
    };

    rec.onend = () => {
      // continuous 인식은 브라우저가 주기적으로 끊으므로, 활성 + 트랙 live + 치명적에러 아님이면 자동 재시작
      if (this._active && !fatal && (!this.#track || this.#track.readyState === 'live')) {
        try {
          if (this.#track) rec.start(this.#track);
          else rec.start();
        } catch {
          /* 이미 시작/트랙 종료 */
        }
      } else {
        this._sink?.system(SystemEvent.RECOGNITION_STOPPED, {});
      }
    };

    // 오프라인(클라이언트 온디바이스) 여부는 prepare()에서 이미 정해졌다 — 여기서 await하지 않는다.
    // prepare()를 거치지 않은 경로(직접 호출)만 폴백으로 확인한다.
    if (this.#offline === null) {
      const wantOffline = this.config.location
        ? this.location === 'local-client'
        : Boolean(this.config.processLocally);
      this.#offline = wantOffline ? (await this.#ensureLocalModel(rec.lang)) !== false : false;
    }
    rec.processLocally = this.#offline;

    this.#rec = rec;
    this.#track = canTrack ? track : null;
    this._active = true;

    // 트랙이 있고 지원되면 트랙 입력, 아니면(마이크) 기본 start()
    if (this.#track) rec.start(this.#track);
    else rec.start();
  }

  /**
   * 온디바이스 인식 모델(SODA 언어팩) 가용성 확인 + 필요시 설치.
   * @returns false=사용 불가(온라인 폴백), true/undefined=진행
   */
  async #ensureLocalModel(lang: string): Promise<boolean | undefined> {
    const SR = getSR();
    if (!SR || typeof SR.available !== 'function') return undefined; // 구버전: 그대로 진행

    let status: Awaited<ReturnType<NonNullable<SpeechRecognitionStatic['available']>>>;
    try {
      status = await SR.available({ langs: [lang], processLocally: true });
    } catch {
      return undefined;
    }

    if (status === 'downloadable' || status === 'downloading') {
      this._sink?.system(SystemEvent.MODEL_LOADING, { message: `온디바이스 모델 다운로드 중… (${lang})` });
      try {
        if (typeof SR.install === 'function') await SR.install({ langs: [lang], processLocally: true });
        this._sink?.system(SystemEvent.MODEL_READY, { message: `온디바이스 모델 준비 완료 (${lang})` });
        return true;
      } catch {
        this._sink?.system(SystemEvent.STATUS, { message: `온디바이스 모델 설치 실패 → 온라인으로 진행`, level: 'warn' });
        return false;
      }
    }

    if (status === 'unavailable') {
      this._sink?.system(SystemEvent.STATUS, {
        message: `이 환경은 ${lang} 온디바이스 인식 미지원 → 온라인으로 진행`,
        level: 'warn',
      });
      return false;
    }

    return true; // 'available'
  }

  override async stop(): Promise<void> {
    this._active = false;
    try {
      this.#rec?.stop();
    } catch {
      /* noop */
    }
    this.#rec = null;
    this.#track = null;
  }
}
