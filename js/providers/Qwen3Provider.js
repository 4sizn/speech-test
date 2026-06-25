import { SttProvider } from '../core/SttProvider.js';
import { SystemEvent, Mode } from '../core/events.js';

/**
 * Qwen3 (클라우드 ASR) Provider — 스캐폴드.
 *
 * Web Speech API와 달리 *파일*을 직접 인식할 수 있는 정석 경로.
 * 서버/클라우드 ASR 엔드포인트로 오디오를 보내고 결과를 받는다.
 *
 * config:
 *   - endpoint : ASR HTTP 엔드포인트 (예: DashScope 호환 transcription URL)
 *   - model    : 모델 id (예: 'qwen3-asr-flash' 등 — 정확한 id는 콘솔에서 확인 필요)
 *   - apiKey   : Bearer 토큰
 *   - lang     : 인식 언어 힌트
 *
 * ⚠️ 실제 API 요청/응답 스키마는 제공자 문서에 맞춰 #transcribeFile/#streamMic을
 *    조정해야 한다(현재는 일반적인 multipart 형태의 골자). TODO 표시 참고.
 */
export class Qwen3Provider extends SttProvider {
  static id = 'qwen3';
  static label = 'Qwen3 ASR (cloud, 파일전송)';
  static capabilities = [Mode.FILE, Mode.MIC];
  static fileInputKind = 'upload'; // 원본 File을 그대로 업로드
  static configSchema = [
    { key: 'endpoint', label: 'Endpoint URL', type: 'url', placeholder: 'https://...' },
    { key: 'model', label: 'Model', default: 'qwen3-asr-flash', placeholder: 'qwen3-asr-flash' },
    { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'Bearer 토큰' },
  ];

  static isSupported() {
    return typeof fetch !== 'undefined';
  }

  /** @type {MediaRecorder|null} */
  #recorder = null;
  #abort = null;

  #isConfigured() {
    return Boolean(this.config.endpoint && this.config.apiKey);
  }

  async start(input) {
    if (!this.#isConfigured()) {
      this._sink?.system(SystemEvent.STATUS, {
        message: 'Qwen3 미설정 — 설정 패널에서 endpoint / apiKey 입력 필요',
        level: 'warn',
      });
      this._sink?.error(new Error('Qwen3 Provider가 설정되지 않았습니다'));
      return;
    }

    this._active = true;
    if (input.mode === Mode.FILE) return this.#transcribeFile(input.file, input.lang);
    if (input.mode === Mode.MIC) return this.#streamMic(input.stream, input.lang);
  }

  async stop() {
    this._active = false;
    try {
      this.#recorder?.state !== 'inactive' && this.#recorder?.stop();
    } catch {
      /* noop */
    }
    this.#recorder = null;
    this.#abort?.abort();
    this.#abort = null;
  }

  // ── 파일 전송 인식 (정석) ───────────────────────────────────────────
  async #transcribeFile(file, lang) {
    if (!file) {
      this._sink?.error(new Error('전송할 파일이 없습니다'));
      return;
    }
    this._sink?.system(SystemEvent.STATUS, { message: `Qwen3로 파일 전송 중… (${file.name})` });
    this.#abort = new AbortController();

    // TODO: 실제 Qwen3 ASR API 스펙에 맞게 form 필드/헤더/응답 파싱 조정.
    const form = new FormData();
    form.append('model', this.config.model || 'qwen3-asr-flash');
    form.append('file', file);
    if (lang) form.append('language', lang);

    try {
      const res = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        body: form,
        signal: this.#abort.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const data = await res.json().catch(() => ({}));

      // TODO: 응답 스키마에 맞게 텍스트 추출 경로 수정.
      const text =
        data.text ??
        data.output?.text ??
        data.result?.transcript ??
        data.transcript ??
        '';
      if (text) this._sink?.final(String(text).trim());
      else this._sink?.system(SystemEvent.STATUS, { message: '응답에서 텍스트를 찾지 못함 — 스키마 확인 필요', level: 'warn' });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      this._sink?.error(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this._active = false;
      this._sink?.system(SystemEvent.RECOGNITION_STOPPED, {});
    }
  }

  // ── 마이크 청크 스트리밍 (골자) ─────────────────────────────────────
  async #streamMic(stream, lang) {
    if (!stream) {
      this._sink?.error(new Error('마이크 스트림이 없습니다'));
      return;
    }
    this._sink?.system(SystemEvent.STATUS, { message: 'Qwen3 마이크 청크 전송 중…' });

    // TODO: 진정한 실시간 스트리밍 ASR은 WebSocket 양방향 연결을 권장.
    //       여기서는 MediaRecorder로 일정 간격 청크를 떠서 #sendChunk로 보내는 골자만 둔다.
    try {
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0 && this._active) {
          void this.#sendChunk(e.data, lang);
        }
      };
      recorder.start(1000); // 1초 간격 청크
      this.#recorder = recorder;
    } catch (err) {
      this._sink?.error(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async #sendChunk(blob, lang) {
    // TODO: 스트리밍 엔드포인트에 청크 전송 후 partial/final emit.
    //       데모에서는 호출 흔적만 남긴다.
    this._sink?.partial(`[chunk ${blob.size}B 전송 — 스트리밍 엔드포인트 연결 필요]`);
  }
}
