# STT E2E 결과지 — 2026-08-07 15:34 (profile: full)

환경: vite http://127.0.0.1:59811 (managed-new) · :8765 reused · :8766 reused · :8767 reused · :8769 failed · 샘플 7
커밋: c473a63 (dirty)
마이크 모드는 파일 주입 가짜 마이크(getUserMedia 오버라이드)로 측정 — 물리 마이크·잡음은 검증 범위 밖.

| 기능 | 샘플 | final 미수신 | CER 평균 | 중앙값 | 최악 | 평균 지연 | 기준선 | 직전 | 판정 |
|---|---|---|---|---|---|---|---|---|---|
| whisper-base-file | 7 | 0/7 | 28.0% | 27.8% | 57.9% | 12.6s | 30.4% | 29.3% | PASS (-2.4%p / 허용 5%p) |
| whisper-base-mic | 6 | 0/6 | 26.2% | 19.1% | 63.2% | 7.5s | 25.9% | 25.4% | PASS (+0.4%p / 허용 5%p) |
| whisper-base-partial-file | 6 | 0/6 | 29.2% | 19.8% | 58.3% | 7.0s | 30.6% | 25.5% | PASS (-1.3%p / 허용 5%p) |
| whisper-base-partial-mic | 6 | 0/6 | 24.1% | 19.8% | 47.4% | 7.1s | 28.2% | 27.2% | PASS (-4.1%p / 허용 5%p) |
| streaming-file | 7 | 0/7 | 15.7% | 10.8% | 41.7% | 12.9s | 14.5% | 15.2% | PASS (+1.1%p / 허용 5%p) |
| streaming-mic | 6 | 0/6 | 11.5% | 10.8% | 25.0% | 7.0s | 10.4% | 16.8% | PASS (+1.0%p / 허용 5%p) |
| sensevoice-file | 7 | 0/7 | 15.3% | 13.9% | 40.7% | 11.5s | 16.4% | 18.0% | PASS (-1.2%p / 허용 5%p) |
| sensevoice-mic | 6 | 0/6 | 10.9% | 13.2% | 22.2% | 7.2s | 10.9% | 7.7% | PASS (+0.0%p / 허용 5%p) |
| funasr-streaming-file | 7 | 0/7 | 99.5% | 100.0% | 100.0% | 11.2s | — | 99.4% | NEW (기준선 없음) |
| funasr-offline-file | — | — | — | — | — | — | — | — | SKIP (Streaming 미설정 — WebSocket URL 필요) |
| webspeech-file | 6 | 0/6 | 8.7% | 7.9% | 22.2% | 5.7s | 8.7% | 6.9% | PASS (+0.0%p / 허용 5%p) |
| webspeech-mic | 6 | 6/6 | 100.0% | 100.0% | 100.0% | 5.6s | 5.0% | 100.0% | WARN (final 미수신 6/6건 (허용 0%)) |
| qwen3-file | — | — | — | — | — | — | — | — | SKIP (Qwen3 미설정 — 설정 패널에서 endpoint / apiKey 입력 필요) |
| whisper-tiny-file | 7 | 0/7 | 72.2% | 44.4% | 273.7% | 13.6s | 48.2% | 45.4% | FAIL (+24.0%p / 허용 5%p) |
| whisper-small-file | 7 | 0/7 | 19.6% | 22.2% | 33.3% | 30.2s | 17.8% | 20.3% | PASS (+1.8%p / 허용 5%p) |
| webspeech-local-file | 6 | 0/6 | 8.7% | 7.9% | 22.2% | 5.7s | — | 8.7% | NEW (기준선 없음) |

전체: **FAIL** — whisper-tiny-file 회귀 — 푸시 차단

## 비고
- whisper-base-partial-file: 중간 결과(주기 재인식)를 켠 실사용 경로 — 확정 정확도가 그 부하에 흔들리지 않는지 감시
- whisper-base-partial-mic: 중간 결과를 켠 마이크 경로 — 재인식 부하가 마이크 캡처에도 번지는지 감시. 다만 이 마이크도 파일 재생 주입이라 물리 마이크(디코딩 없음)보다 부하에 취약할 수 있다
- funasr-streaming-file: 중국어 전용 streaming 모델 — 절대 CER 무의미, 회귀 감지용
- funasr-offline-file: 중국어 offline paraformer · snapshot partial/final 정확도 회귀 감지용, 대화 SLA 비대상
- webspeech-file: 클라우드 인식 — 실행마다 흔들린다(허용 7%p)
- webspeech-mic: 파일 주입 가짜 마이크라 실제로는 파일 트랙 경로를 측정한다 — 마이크 경로는 사람이 확인
- qwen3-file: 자격 미설정이면 SKIP
- whisper-tiny-file: 한국어 비권장 — 회귀 감시용으로만 측정
- webspeech-local-file: 온디바이스(SODA) — 준비된 언어팩이 없으면 온라인으로 폴백하며 경고(설치는 하지 않는다)

발화별 오류값은 같은 폴더의 `<기능>.json`(runs[].items) 참조.
인식 결과·정답 원문 대조는 `stt-e2e/.local/<날짜>/<기능>.detail.json`(커밋 제외).
