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
 * SpeechRecognition 에러 코드를 사용자가 다음 행동을 고를 수 있는 문장으로 바꾼다.
 *
 * 특히 `network`는 원인이 우리 쪽이 아닌데 조용히 실패해 오해를 산다. 계측으로 확인한 바:
 * 같은 코드·같은 Chrome 빌드에서 트랙 입력(start(track)) 세션만 즉시 network로 끊기고,
 * 마이크 경로(start())는 정상 열렸다. API 지원(오버로드)·권한·온라인 상태·격리(COOP/COEP)는
 * 모두 정상이었다 → 브라우저 인식 서비스가 트랙 입력 세션을 거부하는 상태(쿼터/정책 추정).
 * 코드로 우회할 수 없으므로 대체 Provider를 안내한다.
 */
function describeError(code: string, hadTrack: boolean): string {
  if (code === 'network') {
    return hadTrack
      ? '브라우저 음성 인식 서비스에 연결하지 못했습니다(network). 오디오 트랙 입력 세션이 거부되는 상태일 수 있습니다 — Whisper(로컬) 또는 SenseVoice(온프레미스) Provider로 전환하세요.'
      : '브라우저 음성 인식 서비스에 연결하지 못했습니다(network). 네트워크를 확인하거나 Whisper(로컬) Provider를 사용하세요.';
  }
  if (code === 'not-allowed' || code === 'service-not-allowed') {
    return `음성 인식이 허용되지 않았습니다(${code}). 마이크 권한과 사이트 설정을 확인하세요.`;
  }
  if (code === 'language-not-supported') {
    return '이 언어는 브라우저 음성 인식이 지원하지 않습니다 — Whisper 또는 SenseVoice를 사용하세요.';
  }
  if (code === 'audio-capture') {
    return '오디오를 캡처하지 못했습니다(audio-capture). 입력 장치를 확인하세요.';
  }
  return `SpeechRecognition error: ${code}`;
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
 *   - mic  : `start()` — 브라우저가 입력 장치를 직접 연다. **마이크 트랙을 넘기지 않는다**:
 *            실제 마이크 트랙을 start(track)에 주면 세션만 열리고 결과가 오지 않는다(에러도 없음).
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
    if (!SR) {
      this.#trackInput = false;
      return false;
    }
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
      this.#trackInput = false;
      return false;
    } catch (e) {
      const supportsTrackInput = e instanceof Error && e.name === 'TypeError';
      this.#trackInput = supportsTrackInput;
      return supportsTrackInput;
    }
  }

  #rec: SpeechRecognition | null = null;
  #track: MediaStreamTrack | null = null;
  /** 온디바이스 모델 확인 결과 — prepare()에서 미리 정해두고 start()에서는 쓰기만 한다 */
  #offline: boolean | null = null;
  /** 온디바이스 거부 후 온라인으로 되돌린 적이 있는가 — 재시도는 세션당 1회 */
  #onlineRetried = false;

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
    this.#onlineRetried = false; // 세션마다 온라인 폴백 기회를 새로 준다
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
      // 온디바이스로 시작했다가 즉시 거부되면 온라인으로 한 번 되돌린다.
      // `available` 보고를 믿을 수 없기 때문이다 — 실측으로 구버전 언어팩이 available로
      // 보고되면서 그 언어의 인식이 전부 network로 실패했다. 가용성 조회 대신 실제 시작을
      // 검증으로 삼는다. 재시도는 1회뿐(무한 루프 방지).
      const REDIRECTABLE = ['network', 'language-not-supported', 'service-not-allowed'];
      if (rec.processLocally && !this.#onlineRetried && REDIRECTABLE.includes(event.error)) {
        this.#onlineRetried = true;
        this.#offline = false;
        rec.processLocally = false;
        this._sink?.system(SystemEvent.STATUS, {
          message: `온디바이스 인식이 거부됐습니다(${event.error}) → 온라인으로 다시 시도합니다`,
          level: 'warn',
        });
        try {
          if (this.#track) rec.start(this.#track);
          else rec.start();
          return;
        } catch {
          /* 아래 공통 처리로 내려간다 */
        }
      }
      // 치명적 에러는 재시작하면 무한 루프 → 중단
      const FATAL = ['not-allowed', 'service-not-allowed', 'language-not-supported', 'audio-capture', 'network'];
      if (FATAL.includes(event.error)) {
        fatal = true;
        this._active = false;
      }
      this._sink?.error(new Error(describeError(event.error, this.#track != null)));
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
    /**
     * **트랙 입력은 파일 모드에서만 쓴다.**
     *
     * 파일은 재생 트랙을 디지털로 넣어야 하니 `start(track)`이 필요하지만, 마이크는 브라우저가
     * 직접 열게 하는 것이 원래 경로다. 실제 마이크 트랙(getUserMedia)을 `start(track)`에 넘기면
     * 세션은 열리는데 결과가 오지 않고 **에러도 없다**(조용한 실패). 사용자 보고로 발견했다 —
     * 마이크 모드만 클라우드·온디바이스 양쪽에서 안 되고 파일 모드는 정상이었다.
     *
     * QA가 이걸 놓친 이유: 하네스의 마이크 모드는 `<audio>`의 captureStream 트랙을 주입하는
     * 가짜 마이크라(`src/qa/harness.ts`) 실제로는 **파일 트랙 경로를 다시 테스트**하고 있었다.
     * 그래서 이 줄을 고치면 `webspeech-mic` 측정이 오히려 100%로 뒤집힌다 — 그 측정은 실제
     * 마이크 경로를 대변하지 못한다(features.mjs에서 게이트 제외한 근거).
     * **이 분기는 사람이 물리 마이크로 확인해야 한다** — 이 수정도 그렇게 검증했다.
     */
    this.#track = isFile && canTrack ? track : null;
    this._active = true;

    if (this.#track) rec.start(this.#track);
    else rec.start(); // 마이크 — 브라우저가 입력 장치를 직접 연다
  }

  /**
   * 온디바이스 인식 모델(SODA 언어팩) 가용성 확인.
   *
   * **설치(SR.install)를 자동으로 부르지 않는다.** 자동 설치는 브라우저 전역 상태를 바꾸는데,
   * 실측으로 그 부작용이 컸다: 구버전·불완전한 ko-KR 언어팩(30파일/53MB, v1.3073 — 같은
   * Chrome의 en-US는 185파일/194MB, v1.5075)이 install 후 `available`로 보고되기 시작했고,
   * 그 뒤로 한국어는 `processLocally=false`로 명시해도, 클라우드를 골라도 전부 즉시 `network`로
   * 실패했다(영어는 정상). 즉 설치가 그 언어의 인식을 통째로 못 쓰게 만들 수 있다.
   * 언어팩 설치는 브라우저·OS 설정에 맡기고, 우리는 이미 준비된 것만 쓴다.
   *
   * @returns false=사용 불가(온라인으로 진행), true/undefined=온디바이스 시도 가능
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

    if (status === 'available') return true;

    this._sink?.system(SystemEvent.STATUS, {
      message:
        status === 'unavailable'
          ? `이 환경은 ${lang} 온디바이스 인식 미지원 → 온라인으로 진행`
          : `${lang} 온디바이스 모델이 아직 준비되지 않았습니다(${status}) → 온라인으로 진행. ` +
            `온디바이스로 쓰려면 브라우저·OS 설정에서 음성 인식 언어를 먼저 설치하세요`,
      level: 'warn',
    });
    return false;
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
