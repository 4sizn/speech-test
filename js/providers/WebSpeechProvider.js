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
      this._sink?.system(SystemEvent.STATUS, {
        message: isFile
          ? '파일 인식 중 (오디오 트랙 직접 입력 · 노이즈/볼륨 무관)'
          : '마이크 인식 중',
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

    rec.onerror = (event) => {
      if (event.error === 'aborted') return;
      this._sink?.error(new Error(`SpeechRecognition error: ${event.error}`));
    };

    rec.onend = () => {
      // continuous 인식은 브라우저가 주기적으로 끊으므로, 활성 + 트랙이 살아있으면 자동 재시작
      if (this._active && (!this.#track || this.#track.readyState === 'live')) {
        try {
          this.#track ? rec.start(this.#track) : rec.start();
        } catch {
          /* 이미 시작/트랙 종료 */
        }
      } else if (!this._active) {
        this._sink?.system(SystemEvent.RECOGNITION_STOPPED, {});
      }
    };

    this.#rec = rec;
    this.#track = canTrack ? track : null;
    this._active = true;

    // 트랙이 있고 지원되면 트랙 입력, 아니면(마이크) 기본 start()
    if (this.#track) rec.start(this.#track);
    else rec.start();
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
