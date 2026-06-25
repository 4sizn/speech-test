import { SttProvider } from '../core/SttProvider.js';
import { SystemEvent, Mode } from '../core/events.js';

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
export class WebSpeechProvider extends SttProvider {
  static id = 'webspeech';
  static label = 'Browser Web Speech API';
  static capabilities = [Mode.MIC, Mode.FILE];
  // 파일 트랙을 captureStream으로 디지털 캡처해 start(track)로 주입 (음향 루프백 폐기)
  static fileInputKind = 'stream';
  static configSchema = [
    {
      key: 'processLocally',
      label: '오프라인(온디바이스) 인식 — 서버 전송 없이 로컬 처리',
      type: 'checkbox',
      default: false,
    },
  ];

  static isSupported() {
    return typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  /** start(MediaStreamTrack) 오버로드 지원 여부(런타임 1회 탐지, 캐시). */
  static supportsAudioTrackInput() {
    if (this._trackInput !== undefined) return this._trackInput;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return (this._trackInput = false);
    try {
      // 오버로드가 있으면 {}→MediaStreamTrack 변환 실패로 TypeError(시작 안 됨).
      // 없으면 여분 인자 무시되어 마이크로 시작 → 즉시 abort.
      const rec = new SR();
      rec.start({});
      try { rec.abort(); } catch {}
      return (this._trackInput = false);
    } catch (e) {
      return (this._trackInput = e?.name === 'TypeError');
    }
  }

  /** @type {any} */
  #rec = null;
  /** @type {MediaStreamTrack|null} */
  #track = null;

  async start(input) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      this._sink?.error(new Error('이 브라우저는 Web Speech API를 지원하지 않습니다 (Chrome/Edge 권장)'));
      return;
    }

    // 입력 트랙 결정
    const track = input.stream?.getAudioTracks?.()[0] ?? null;
    const canTrack = WebSpeechProvider.supportsAudioTrackInput();
    const isFile = input.mode === Mode.FILE || input.mode === Mode.FILE_LOOPBACK;

    if (isFile && (!track || !canTrack)) {
      this._sink?.error(
        new Error(
          !canTrack
            ? '이 브라우저는 SpeechRecognition 오디오 트랙 입력을 지원하지 않습니다. Whisper Provider를 쓰거나 최신 Chrome을 사용하세요.'
            : '파일 오디오 트랙을 캡처하지 못했습니다.',
        ),
      );
      return;
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
          this.#track ? rec.start(this.#track) : rec.start();
        } catch {
          /* 이미 시작/트랙 종료 */
        }
      } else {
        this._sink?.system(SystemEvent.RECOGNITION_STOPPED, {});
      }
    };

    // 오프라인(온디바이스) 모드 — 모델 가용성 확인 후 필요시 설치, 불가하면 온라인 폴백
    let offline = !!this.config.processLocally;
    if (offline) {
      const ok = await this.#ensureLocalModel(rec.lang);
      if (ok === false) offline = false;
    }
    rec.processLocally = offline;

    this.#rec = rec;
    this.#track = canTrack ? track : null;
    this._active = true;

    // 트랙이 있고 지원되면 트랙 입력, 아니면(마이크) 기본 start()
    if (this.#track) rec.start(this.#track);
    else rec.start();
  }

  /**
   * 온디바이스 인식 모델(SODA 언어팩) 가용성 확인 + 필요시 설치.
   * @returns {Promise<boolean|undefined>} false=사용 불가(온라인 폴백), true/undefined=진행
   */
  async #ensureLocalModel(lang) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (typeof SR.available !== 'function') return undefined; // 구버전: 그대로 진행

    let status;
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
      } catch (e) {
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

  async stop() {
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
