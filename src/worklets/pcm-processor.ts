/**
 * PCM 추출용 AudioWorkletProcessor.
 *
 * 오디오 그래프에서 흘러오는 프레임(128 샘플 단위)을 모아
 * 지정 크기(frameSize)마다 메인 스레드로 Float32 PCM을 postMessage 한다.
 * 마이크/파일 캡처 스트림 어느 쪽이든 동일하게 동작한다.
 *
 * 이 파일은 AudioWorkletGlobalScope에서 실행되므로 lib.dom에 없는
 * 전역(AudioWorkletProcessor/registerProcessor)을 아래에 직접 선언한다.
 */

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: { processorOptions?: Record<string, unknown> });
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: { processorOptions?: Record<string, unknown> }) => AudioWorkletProcessor,
): void;

interface PcmProcessorOptions {
  processorOptions?: { frameSize?: number };
}

class PCMProcessor extends AudioWorkletProcessor {
  private _frameSize: number;
  private _buf: Float32Array;
  private _idx = 0;

  constructor(options?: PcmProcessorOptions) {
    super();
    this._frameSize = options?.processorOptions?.frameSize || 4096;
    this._buf = new Float32Array(this._frameSize);
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const ch = input && input[0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this._buf[this._idx++] = ch[i];
        if (this._idx >= this._frameSize) {
          // 복사본을 전송(전송 후 버퍼 재사용)
          this.port.postMessage(this._buf.slice(0, this._idx));
          this._idx = 0;
        }
      }
    }
    return true; // 노드 유지
  }
}

registerProcessor('pcm-processor', PCMProcessor);

// 모듈 스코프 유지용(전역 선언과의 충돌 방지)
export {};
