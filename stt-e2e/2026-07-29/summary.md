# STT E2E 결과지 — 2026-07-29 17:03 (profile: quick)

환경: :8765 reused · :8766 reused · :8767 reused · 샘플 10
커밋: 33be282 (dirty)
마이크 모드는 파일 주입 가짜 마이크(getUserMedia 오버라이드)로 측정 — 물리 마이크·잡음은 검증 범위 밖.

| 기능 | 샘플 | CER 평균 | 중앙값 | 최악 | 평균 지연 | 기준선 | 직전 | 판정 |
|---|---|---|---|---|---|---|---|---|
| whisper-base-file | 10 | 30.6% | 27.2% | 61.1% | 15.4s | — | — | NEW (기준선 없음) |
| whisper-base-mic | 8 | 25.8% | 18.8% | 58.3% | 7.6s | — | — | NEW (기준선 없음) |
| streaming-file | 10 | 25.5% | 23.9% | 63.9% | 13.6s | — | — | NEW (기준선 없음) |
| streaming-mic | 8 | 27.8% | 18.8% | 72.2% | 6.5s | — | — | NEW (기준선 없음) |
| sensevoice-file | 10 | 16.2% | 15.6% | 39.5% | 13.7s | — | — | NEW (기준선 없음) |
| sensevoice-mic | 8 | 10.8% | 11.9% | 22.2% | 7.1s | — | — | NEW (기준선 없음) |
| funasr-file | 10 | 99.6% | 100.0% | 100.0% | 13.5s | — | — | NEW (기준선 없음) |
| webspeech-file | 8 | 6.2% | 7.4% | 11.1% | 6.2s | — | — | NEW (기준선 없음) |
| webspeech-mic | 8 | 5.4% | 3.2% | 15.8% | 6.2s | — | — | NEW (기준선 없음) |
| qwen3-file | — | — | — | — | — | — | — | SKIP (Qwen3 미설정 — 설정 패널에서 endpoint / apiKey 입력 필요) |

전체: **PASS** — 모든 기능이 기준선 이하

## 비고
- funasr-file: 중국어 전용 모델 — 절대 CER 무의미, 회귀 감지용
- webspeech-file: 클라우드 인식 — 실행마다 흔들린다
- webspeech-mic: 클라우드 인식 · 파일 주입 가짜 마이크
- qwen3-file: 자격 미설정이면 SKIP

발화별 오류값은 같은 폴더의 `<기능>.json`(runs[].items) 참조.
인식 결과·정답 원문 대조는 `stt-e2e/.local/<날짜>/<기능>.detail.json`(커밋 제외).
