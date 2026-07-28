import { defineConfig } from 'vite';

// COOP/COEP(cross-origin isolation)는 SharedArrayBuffer(멀티스레드 WASM Whisper)를 위해
// 필요하지만, Chrome SpeechRecognition(WebSpeech) 서비스 연결을 깨뜨린다(즉시 network 에러).
// → 기본 OFF. Whisper 멀티스레드 벤치가 필요할 때만 `ISOLATE=1 npm run dev`로 옵트인.
//   OFF여도 Whisper는 단일 스레드로 자동 폴백해 동작한다(WhisperWasmProvider의
//   crossOriginIsolated 가드).
const isolate = process.env.ISOLATE === '1';
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  // require-corp는 ORT의 blob: 워커 생성까지 막으므로 옵트인 시에도 credentialless 사용
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig({
  server: { port: 5173, headers: isolate ? isolationHeaders : undefined },
  preview: { headers: isolate ? isolationHeaders : undefined },
  // transformers.js는 esbuild 사전번들에서 제외 — 인라인된 ONNX 런타임이 import.meta.url로
  // 자신의 dist 안 WASM을 찾는 구조라, 사전번들하면 경로가 깨진다
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
});
