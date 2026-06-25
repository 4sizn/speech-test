/**
 * MediaStream(마이크 or 파일 캡처) → 16kHz mono Float32 PCM 프레임 스트림.
 *
 * 캡처/리샘플 로직을 한 곳에 모아 PCM 기반 Provider(Whisper/Streaming)가 공유한다.
 * AudioWorklet으로 PCM을 뽑고, 메인 스레드에서 16kHz로 선형 리샘플 후 onFrame으로 흘려보낸다.
 *
 * @example
 * const tap = new AudioPcmTap(stream, { onFrame: (f32) => sendOrBuffer(f32) });
 * await tap.start();   // 이후 onFrame이 계속 호출됨
 * await tap.stop();
 */
export class AudioPcmTap {
  #stream;
  #targetRate;
  #frameMs;
  #onFrame;
  /** @type {AudioContext|null} */
  #ctx = null;
  #node = null;
  #source = null;
  #mute = null;

  /**
   * @param {MediaStream} stream
   * @param {{targetRate?: number, frameMs?: number, onFrame: (pcm: Float32Array) => void}} opts
   */
  constructor(stream, { targetRate = 16000, frameMs = 250, onFrame }) {
    this.#stream = stream;
    this.#targetRate = targetRate;
    this.#frameMs = frameMs;
    this.#onFrame = onFrame;
  }

  get sampleRate() {
    return this.#targetRate;
  }

  async start() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.#ctx = new Ctx();
    if (this.#ctx.state === 'suspended') await this.#ctx.resume();

    // 워클릿 등록 (정적 서버 경로)
    await this.#ctx.audioWorklet.addModule(new URL('../worklets/pcm-processor.js', import.meta.url));

    const frameSize = Math.max(256, Math.round((this.#ctx.sampleRate * this.#frameMs) / 1000));
    this.#source = this.#ctx.createMediaStreamSource(this.#stream);
    this.#node = new AudioWorkletNode(this.#ctx, 'pcm-processor', {
      processorOptions: { frameSize },
    });

    const fromRate = this.#ctx.sampleRate;
    this.#node.port.onmessage = (e) => {
      const pcm = resampleLinear(e.data, fromRate, this.#targetRate);
      this.#onFrame?.(pcm);
    };

    // node.process()가 호출되도록 그래프를 destination까지 잇되, gain 0으로 무음 처리
    this.#mute = this.#ctx.createGain();
    this.#mute.gain.value = 0;
    this.#source.connect(this.#node);
    this.#node.connect(this.#mute);
    this.#mute.connect(this.#ctx.destination);
  }

  async stop() {
    try {
      this.#source?.disconnect();
      this.#node?.disconnect();
      this.#mute?.disconnect();
      if (this.#node) this.#node.port.onmessage = null;
      await this.#ctx?.close();
    } catch {
      /* noop */
    }
    this.#ctx = this.#node = this.#source = this.#mute = null;
  }
}

/** 선형 보간 리샘플 (fromRate → toRate). */
function resampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    out[i] = input[i0] * (1 - (pos - i0)) + input[i1] * (pos - i0);
  }
  return out;
}

/** Float32(-1~1) → 16-bit PCM LE. 스트리밍 ASR 전송용. */
export function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}
