# STT E2E 결과지 — 2026-07-29 06:48 (profile: full)

환경: :8765 reused · :8766 reused · :8767 reused · 샘플 7
커밋: 1385b1b
마이크 모드는 파일 주입 가짜 마이크(getUserMedia 오버라이드)로 측정 — 물리 마이크·잡음은 검증 범위 밖.

| 기능 | 샘플 | CER 평균 | 중앙값 | 최악 | 평균 지연 | 기준선 | 직전 | 판정 |
|---|---|---|---|---|---|---|---|---|
| whisper-base-file | 7 | 30.4% | 27.8% | 57.9% | 13.1s | 27.5% | 29.2% | PASS (+3.0%p / 허용 5%p) |
| whisper-base-mic | 6 | 25.9% | 19.8% | 57.9% | 7.2s | 25.4% | 26.3% | PASS (+0.5%p / 허용 5%p) |
| streaming-file | 7 | 31.6% | 28.1% | 58.3% | 10.7s | 32.0% | 27.1% | PASS (-0.4%p / 허용 5%p) |
| streaming-mic | 6 | 27.8% | 22.5% | 57.9% | 6.3s | 28.6% | 29.5% | PASS (-0.9%p / 허용 5%p) |
| sensevoice-file | 7 | 15.6% | 15.8% | 35.3% | 11.7s | 16.1% | 16.7% | PASS (-0.4%p / 허용 5%p) |
| sensevoice-mic | 6 | 10.4% | 12.2% | 22.2% | 6.8s | 10.9% | 10.9% | PASS (-0.5%p / 허용 5%p) |
| funasr-file | 7 | 99.5% | 100.0% | 100.0% | 11.1s | 99.5% | 99.4% | PASS (+0.0%p / 허용 5%p) |
| webspeech-file | 6 | 100.0% | 100.0% | 100.0% | 6.1s | 8.7% | 100.0% | WARN (+91.3%p / 허용 7%p) |
| webspeech-mic | 6 | 100.0% | 100.0% | 100.0% | 6.1s | 5.0% | 100.0% | WARN (+95.0%p / 허용 7%p) |
| qwen3-file | — | — | — | — | — | — | — | SKIP (Qwen3 미설정 — 설정 패널에서 endpoint / apiKey 입력 필요) |
| whisper-tiny-file | 7 | 48.2% | 44.4% | 75.0% | 13.0s | — | 45.4% | NEW (기준선 없음) |
| whisper-small-file | 7 | 17.8% | 21.1% | 33.3% | 28.3s | — | 17.4% | NEW (기준선 없음) |
| webspeech-local-file | 6 | 100.0% | 100.0% | 100.0% | 6.3s | — | 100.0% | NEW (기준선 없음) |

전체: **PASS** — 모든 기능이 기준선 이하

## 비고
- funasr-file: 중국어 전용 모델 — 절대 CER 무의미, 회귀 감지용
- webspeech-file: 클라우드 인식 — 실행마다 흔들린다
- webspeech-mic: 클라우드 인식 · 파일 주입 가짜 마이크
- qwen3-file: 자격 미설정이면 SKIP
- whisper-tiny-file: 한국어 비권장 — 회귀 감시용으로만 측정
- webspeech-local-file: 온디바이스(SODA) — 모델 미지원 환경이면 온라인으로 폴백하며 경고

발화별 오류값은 같은 폴더의 `<기능>.json`(runs[].items) 참조.
인식 결과·정답 원문 대조는 `stt-e2e/.local/<날짜>/<기능>.detail.json`(커밋 제외).
