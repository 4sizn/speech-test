import { defineConfig } from 'vite';

// COOP/COEP: 페이지를 cross-origin isolated로 만들어 SharedArrayBuffer(멀티스레드 WASM
// Whisper 추론)를 허용한다. 자산이 전부 same-origin이라(local-client 계약) 부작용 없음.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  // require-corp는 ORT의 blob: 워커 생성을 막아 멀티스레드 초기화가 멈춘다 → credentialless
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig({
  server: { port: 5173, headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  // transformers.js는 esbuild 사전번들에서 제외 — 인라인된 ONNX 런타임이 import.meta.url로
  // 자신의 dist 안 WASM을 찾는 구조라, 사전번들하면 경로가 깨진다
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
});
