# SPEECH·LAB 작업 규칙

## STT 동작을 바꿨으면 커밋·푸시 전에 QA를 돌린다

대상: `src/providers/**`, `src/core/**`, `src/qa/**`, `server/realtime_asr_server.py`,
`vite.config.ts`, `package.json` — 하나라도 바꿨으면 아래를 먼저 실행한다.

```bash
npm run qa:stt          # 전 기능 자동 측정 → stt-e2e/<날짜>/ 결과지 + 판정
```

- FAIL이면 non-zero exit이고, `pre-push` 훅이 푸시를 막는다. **회귀를 고치고 다시 측정**한다.
- 측정 후에 코드를 더 고치면 훅이 "소스 해시 불일치"로 막는다. 순서는 항상 **수정 → 측정 → 푸시**.
- 정확도가 의도적으로 바뀌었다면(모델 교체 등) 결과지를 확인한 뒤
  `npm run qa:stt -- --update-baseline`으로 기준선을 올리고, **근거를 커밋 메시지에 남긴다**.
- 문서·결과지만 바꾼 푸시는 훅이 그냥 통과시킨다(게이트 목적은 동작 회귀 차단).

빠른 확인이 필요하면 범위를 좁힌다: `npm run qa:stt -- --features whisper-base-file --samples 3`

## 정확도를 주장할 때는 측정값을 붙인다

"개선했다"는 말은 CER 수치 없이는 쓰지 않는다. 기준 데이터는 AI Hub 상담 음성(정답 전사 보유)이고
측정 경로는 `npm run qa:stt`다. 수동 확인(브라우저에서 한 파일 재생)은 보조 근거일 뿐이다.

## 마이크 경로를 바꿨으면 `npm run qa:stt`만으로 통과했다고 하지 않는다

하네스의 마이크 모드는 `getUserMedia`를 오버라이드해 `<audio>`의 `captureStream()` 트랙을 준다.
**트랙을 인식 API에 그대로 넘기는 Provider는 그 측정에서 파일 트랙 경로를 다시 타게 된다** —
WebSpeech에서 마이크 트랙만 실패하는 결함이 CER 5.0%로 통과한 전례가 있다(사용자가 발견했다).

- `src/providers/WebSpeechProvider.ts`의 트랙 분기, `AudioPcmTap` 사용부, `SttEngine`의 마이크
  스트림 생성을 건드렸으면 **`npm run qa:mic`**(진짜 장치 트랙에 음성 주입)을 함께 돌린다.
- 그래도 **WebSpeech 마이크는 자동 검증이 불가능하다**(가짜 파일 캡처가 인식 오디오 스택에 닿지
  않는다). 그 경로를 바꿨으면 사람에게 물리 마이크 확인을 요청하고, **확인 전에는 "고쳤다"고
  단정하지 않는다.**

## "외부 서비스 탓"으로 결론내기 전에 우리 코드가 환경을 바꿨는지 본다

WebSpeech가 CER 100%로 찍힌 것을 "브라우저 인식 서비스가 거부하는 상태(쿼터/정책), 코드로
우회 불가"로 판정하고 `gateOptional`로 넘긴 적이 있다. **오진이었다.** 실제 원인은 환경 상태였고
**우리가 만들었다** — ko-KR 온디바이스 모델이 `available`로 보고되면 한국어 인식이 온라인
경로까지 전부 `network`로 실패하는데, 그 상태로 전이시킨 것이 우리 Provider의
`SpeechRecognition.install()` 자동 호출이었다. QA에서 `--disable-component-update`로 변수를
없애자 CER이 100%에서 7.8%로 돌아왔다.
(팩이 디렉터리에 있는 것 자체는 무해하다 — `downloadable`인 동안은 온라인 인식이 정상이다.
"환경 탓"과 "우리가 환경을 바꿨다"를 가르는 지점이 여기였다.)

판정 순서를 지킨다:

1. **우리 코드 없이 원시 API로 재현**해 본다(브라우저 콘솔에서 `SpeechRecognition` 직접 호출).
   원시가 되면 우리 코드 문제다 — 외부 탓으로 넘기지 않는다.
2. 다른 언어·다른 Provider와 **비교**한다. 하나만 깨졌으면 환경 전역 문제가 아니다.
3. 우리 코드가 **브라우저·OS 상태를 바꾸는 호출**(설치·권한·저장소)을 하는지 확인한다.
4. 그래도 외부 요인이라면, 그 근거를 결과지·주석에 남기고 `gateOptional`을 쓴다.

가용성 조회(`available()`)를 신뢰하지 않는다. 실제 시작이 유일한 검증이다.

## 결과지에 데이터셋 원문을 넣지 않는다

이 저장소는 GitHub public이고 AI Hub 데이터는 이용 승인 기반(재배포 제약)이다.
커밋되는 결과지에는 오류 수치만 담고, 정답 전사·인식 결과 원문은 `stt-e2e/.local/`(gitignore)에
둔다. 새 결과 파일을 추가할 때 이 경계를 지킨다.

## Provider를 추가할 때

`src/providers/registerAll.ts`에 한 줄 등록하면 앱과 QA 하네스에 동시에 반영된다.
등록을 두 곳에 나누지 않는다 — QA가 앱과 다른 Provider 집합을 테스트하면서 "전부 테스트했다"고
보고하는 상황을 막기 위한 구조다. 새 기능의 측정 항목은 `scripts/qa/lib/features.mjs`에 추가한다.
