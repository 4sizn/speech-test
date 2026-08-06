# ADR: 실시간 대화 STT의 Engine Profile 분리

- 날짜: 2026-08-06
- 상태: 승인됨 — 사용자 승인: “니 권고대로 진행해”

## 문제

`Provider`가 PCM/WebSocket transport와 ASR 모델 선택을 동시에 나타낸다. 같은 WebSocket transport를 쓰는 FunASR·SenseVoice는 전용 Provider인 반면 faster-whisper·whisper-streaming은 `StreamingAsrProvider` 내부 endpoint selector로 묶여 있다. 이 구조는 모든 실시간 대화 엔진의 partial transcript 요구와 FunASR streaming/offline 지원을 일관되게 표현하지 못한다.

## 결정

- **Provider**는 transport/runtime integration으로 제한한다.
- **Engine Profile**은 모델·엔드포인트·언어·입력 모드·partial 전략과 실시간 대화 적합성을 선언한다.
- `Mode`는 입력 소스(`mic`/`file`)로, `RuntimeLocation`은 실행 위치로 유지한다.
- `funasr-streaming`과 `funasr-offline`은 별도 Engine Profile이다.
- 대화용 UI는 `conversation: true` profile만 선택 후보로 노출한다. offline profile은 파일 전사/정확도 우선 경로에서만 노출한다.
- partial은 `none | snapshot | incremental | stable-incremental` 전략을 명시하고, placeholder text를 대화 partial로 표기하지 않는다.

## 초기 범위

1. speech-test 내부 catalog 및 Provider 선택 UI를 profile 중심으로 전환한다.
2. 기존 WebSocket PCM transport와 rvs-stt-kit streaming public API는 유지한다.
3. 서버는 `funasr-streaming`과 `funasr-offline` engine identifier를 구분한다.
4. QA는 profile별 first-partial latency, partial count, final receipt를 기록한다.

## 비범위

- rvs-stt-kit public export/contract revision 변경
- Fun-ASR-Nano/vLLM deployment 추가
- 실시간 대화 SLA를 offline profile에 약속하는 것
- AI Hub 원문/전사문을 결과지에 추가하는 것

## 위험과 완화

- offline 재전사 profile은 진짜 token streaming이 아니다. UI에 snapshot/final-only 특성을 표시하고 대화 후보에서 제외한다.
- CPU 단일 추론 워커는 여러 서버 동시 실행에서 경합한다. QA는 server를 순차 기동한다.
- 기존 provider localStorage 값은 profile migration map으로 읽는다.

## 검토

- Codex / gpt-5.4: Provider transport와 EngineProfile 모델 분리를 권고.
- Claude Code / sonnet: 최소 변경 Provider 추가안을 제시했으나, 공통 대화 partial 요구에는 EngineProfile 모델이 더 적합함을 확인.
