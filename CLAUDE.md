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

## 결과지에 데이터셋 원문을 넣지 않는다

이 저장소는 GitHub public이고 AI Hub 데이터는 이용 승인 기반(재배포 제약)이다.
커밋되는 결과지에는 오류 수치만 담고, 정답 전사·인식 결과 원문은 `stt-e2e/.local/`(gitignore)에
둔다. 새 결과 파일을 추가할 때 이 경계를 지킨다.

## Provider를 추가할 때

`src/providers/registerAll.ts`에 한 줄 등록하면 앱과 QA 하네스에 동시에 반영된다.
등록을 두 곳에 나누지 않는다 — QA가 앱과 다른 Provider 집합을 테스트하면서 "전부 테스트했다"고
보고하는 상황을 막기 위한 구조다. 새 기능의 측정 항목은 `scripts/qa/lib/features.mjs`에 추가한다.
