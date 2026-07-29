/// <reference lib="webworker" />
/**
 * Whisper 추론 워커 — 모델 로드와 인식을 **메인 스레드 밖에서** 수행한다.
 *
 * 메인 스레드에서 돌리면 UI가 멈춘다(실측: 3.3초 오디오 1건에 최대 1,123ms 프레임 갭,
 * 총 2.6초 정지). WebGPU 경로라도 자기회귀 디코딩 루프가 JS에서 돌기 때문에 마찬가지다.
 * 긴 파일이나 small 모델에서는 수십 초 멈춘 것처럼 보인다.
 *
 * local-client 계약은 워커 안에서도 유지한다 — 모델/런타임 자산을 same-origin에서만 받는다.
 */
import { pipeline, env } from '@huggingface/transformers';

type Transcriber = (
  audio: Float32Array,
  options: {
    language?: string;
    task: 'transcribe';
    chunk_length_s?: number;
    stride_length_s?: number;
  },
) => Promise<{ text?: string }>;

interface LoadMessage {
  type: 'load';
  model: string;
}
interface TranscribeMessage {
  type: 'transcribe';
  id: number;
  pcm: Float32Array;
  language?: string;
  chunkLengthSec: number;
  strideLengthSec: number;
}
type InMessage = LoadMessage | TranscribeMessage;

let transcriber: Transcriber | null = null;
let loadedModel = '';

/** same-origin 자산 실존 확인 — SPA 폴백(index.html 200)을 자산으로 오인하지 않도록 HEAD로 검사. */
async function assetExists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok && !(res.headers.get('content-type') ?? '').includes('text/html');
  } catch {
    return false;
  }
}

async function load(model: string): Promise<{ device: string }> {
  if (transcriber && loadedModel === model) return { device: 'cached' };
  transcriber = null;

  // 모델/런타임 자산 전부 same-origin (외부 도메인 차단)
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = '/models/';
  if (env.backends.onnx.wasm) {
    env.backends.onnx.wasm.wasmPaths = import.meta.env.DEV
      ? '/node_modules/@huggingface/transformers/dist/'
      : '/ort/';
    // COOP/COEP 미적용이면 SharedArrayBuffer가 없어 멀티스레드 초기화가 멈춘다 → 단일 스레드
    if (!crossOriginIsolated) env.backends.onnx.wasm.numThreads = 1;
  }

  if (!(await assetExists(`/models/${model}/onnx/encoder_model_quantized.onnx`))) {
    throw new Error(`모델 자산(/models/${model})이 없습니다`);
  }

  const create = (options?: { device?: 'webgpu' }): Promise<Transcriber> =>
    pipeline('automatic-speech-recognition', model, options) as unknown as Promise<Transcriber>;

  const tryWebgpu = 'gpu' in navigator && (await assetExists(`/models/${model}/onnx/encoder_model.onnx`));
  let device = 'wasm';
  try {
    transcriber = tryWebgpu ? await create({ device: 'webgpu' }) : await create();
    device = tryWebgpu ? 'webgpu' : 'wasm';
  } catch {
    transcriber = await create(); // WebGPU 세션 생성 실패 시 WASM(q8) 폴백
    device = 'wasm(fallback)';
  }
  loadedModel = model;
  return { device };
}

self.onmessage = async (event: MessageEvent<InMessage>): Promise<void> => {
  const msg = event.data;
  try {
    if (msg.type === 'load') {
      const { device } = await load(msg.model);
      self.postMessage({ type: 'loaded', model: msg.model, device });
      return;
    }
    if (msg.type === 'transcribe') {
      if (!transcriber) throw new Error('모델이 로드되지 않았습니다');
      const out = await transcriber(msg.pcm, {
        language: msg.language,
        task: 'transcribe',
        chunk_length_s: msg.chunkLengthSec,
        stride_length_s: msg.strideLengthSec,
      });
      self.postMessage({ type: 'result', id: msg.id, text: (out?.text ?? '').trim() });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({
      type: 'error',
      id: msg.type === 'transcribe' ? msg.id : undefined,
      message,
    });
  }
};
