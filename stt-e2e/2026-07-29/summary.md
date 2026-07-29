# STT E2E 결과지 — 2026-07-29 13:24 (profile: quick)

환경: :8765 started · :8766 started · :8767 started · 샘플 7
커밋: 771919d (dirty)
마이크 모드는 파일 주입 가짜 마이크(getUserMedia 오버라이드)로 측정 — 물리 마이크·잡음은 검증 범위 밖.

| 기능 | 샘플 | CER 평균 | 중앙값 | 최악 | 평균 지연 | 기준선 | 직전 | 판정 |
|---|---|---|---|---|---|---|---|---|
| whisper-base-file | 7 | 27.7% | 26.4% | 61.1% | 13.0s | 27.4% | 28.3% | PASS (+0.3%p / 허용 5%p) |
| whisper-base-mic | 6 | 25.6% | 19.8% | 50.0% | 7.2s | 25.9% | 28.9% | PASS (-0.4%p / 허용 5%p) |
| whisper-base-partial-file | 6 | 27.3% | 19.1% | 57.9% | 7.2s | 29.1% | 26.9% | PASS (-1.8%p / 허용 5%p) |
| whisper-base-partial-mic | 6 | 25.6% | 19.8% | 50.0% | 6.9s | 27.2% | 25.6% | PASS (-1.6%p / 허용 5%p) |
| streaming-file | 7 | 29.3% | 27.8% | 58.3% | 11.5s | 28.4% | 29.0% | PASS (+0.8%p / 허용 5%p) |
| streaming-mic | 6 | 24.6% | 19.1% | 61.1% | 6.2s | 23.7% | 24.1% | PASS (+0.9%p / 허용 5%p) |
| sensevoice-file | 7 | 15.4% | 13.9% | 36.5% | 11.1s | 16.7% | 16.0% | PASS (-1.3%p / 허용 5%p) |
| sensevoice-mic | 6 | 11.3% | 12.2% | 22.2% | 6.8s | 10.4% | 10.4% | PASS (+0.9%p / 허용 5%p) |
| funasr-file | 7 | 99.2% | 100.0% | 100.0% | 11.2s | 99.5% | 99.5% | PASS (-0.3%p / 허용 5%p) |
| webspeech-file | 6 | 8.7% | 7.9% | 22.2% | 5.8s | 8.7% | 7.8% | PASS (+0.0%p / 허용 7%p) |
| webspeech-mic | 6 | 5.0% | 1.5% | 15.8% | 5.8s | 5.0% | 5.0% | PASS (+0.0%p / 허용 7%p) |
| qwen3-file | — | — | — | — | — | — | — | SKIP (Qwen3 미설정 — 설정 패널에서 endpoint / apiKey 입력 필요) |

전체: **PASS** — 모든 기능이 기준선 이하

## 비고
- whisper-base-partial-file: 중간 결과(주기 재인식)를 켠 실사용 경로 — 확정 정확도가 그 부하에 흔들리지 않는지 감시
- whisper-base-partial-mic: 중간 결과를 켠 마이크 경로 — 재인식 부하가 마이크 캡처에도 번지는지 감시. 다만 이 마이크도 파일 재생 주입이라 물리 마이크(디코딩 없음)보다 부하에 취약할 수 있다
- funasr-file: 중국어 전용 모델 — 절대 CER 무의미, 회귀 감지용
- webspeech-file: 클라우드 인식 — 실행마다 흔들린다
- webspeech-mic: 클라우드 인식 · 파일 주입 가짜 마이크
- qwen3-file: 자격 미설정이면 SKIP

발화별 오류값은 같은 폴더의 `<기능>.json`(runs[].items) 참조.
인식 결과·정답 원문 대조는 `stt-e2e/.local/<날짜>/<기능>.detail.json`(커밋 제외).
