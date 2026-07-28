# STT E2E 결과지 — 2026-07-29 17:54 (profile: quick)

환경: :8765 started · :8766 started · :8767 started · 샘플 7
커밋: 5ed7999 (dirty)
마이크 모드는 파일 주입 가짜 마이크(getUserMedia 오버라이드)로 측정 — 물리 마이크·잡음은 검증 범위 밖.

| 기능 | 샘플 | CER 평균 | 중앙값 | 최악 | 평균 지연 | 기준선 | 직전 | 판정 |
|---|---|---|---|---|---|---|---|---|
| whisper-base-file | 7 | 29.1% | 27.8% | 57.9% | 11.6s | 29.1% | 30.0% | PASS (+0.0%p / 허용 2%p) |
| whisper-base-mic | 6 | 28.8% | 19.8% | 57.9% | 6.8s | 28.8% | 28.3% | PASS (+0.0%p / 허용 2%p) |
| streaming-file | 7 | 29.7% | 27.8% | 58.3% | 11.6s | 29.7% | 35.4% | PASS (+0.0%p / 허용 2%p) |
| streaming-mic | 6 | 29.1% | 19.8% | 63.2% | 6.1s | 29.1% | 31.1% | PASS (+0.0%p / 허용 2%p) |
| sensevoice-file | 7 | 15.1% | 10.5% | 39.5% | 11.0s | 15.1% | 16.9% | PASS (+0.0%p / 허용 2%p) |
| sensevoice-mic | 6 | 13.7% | 15.8% | 22.2% | 6.5s | 13.7% | 10.1% | PASS (+0.0%p / 허용 2%p) |
| funasr-file | 7 | 99.6% | 100.0% | 100.0% | 10.8s | 99.6% | 99.6% | PASS (+0.0%p / 허용 2%p) |
| webspeech-file | 6 | 8.7% | 7.9% | 22.2% | 5.6s | 8.7% | 5.0% | PASS (+0.0%p / 허용 5%p) |
| webspeech-mic | 6 | 5.0% | 1.5% | 15.8% | 5.6s | 5.0% | 5.0% | PASS (+0.0%p / 허용 5%p) |
| qwen3-file | — | — | — | — | — | — | — | SKIP (Qwen3 미설정 — 설정 패널에서 endpoint / apiKey 입력 필요) |

전체: **PASS** — 모든 기능이 기준선 이하

## 비고
- funasr-file: 중국어 전용 모델 — 절대 CER 무의미, 회귀 감지용
- webspeech-file: 클라우드 인식 — 실행마다 흔들린다
- webspeech-mic: 클라우드 인식 · 파일 주입 가짜 마이크
- qwen3-file: 자격 미설정이면 SKIP

발화별 오류값은 같은 폴더의 `<기능>.json`(runs[].items) 참조.
인식 결과·정답 원문 대조는 `stt-e2e/.local/<날짜>/<기능>.detail.json`(커밋 제외).
