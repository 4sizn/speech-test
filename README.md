# SPEECH·LAB — Provider 주입형 실시간 STT 콘솔

업로드한 오디오 또는 마이크 입력을 **실시간으로 음성→텍스트(STT)** 변환해 출력하는 단일 페이지.
STT 백엔드는 **Provider(어댑터)** 로 추상화되어 있고, **모드별로 주입**되어 동일한 출력 파이프로 흘러나온다.

ws-network의 `WebSocketClientAdapter` + facade 패턴과 RVS SDK의 `MessageBus`(system/feature 이벤트 분리)를
STT 도메인에 적용한 골자다. 소스는 **strict TypeScript**(`src/`), 실행/빌드는 **Vite**.

## 실행

> ⚠️ 마이크/음성인식(`getUserMedia`, `SpeechRecognition`)은 **https 또는 localhost(보안 컨텍스트)** 에서만 동작한다.

```bash
bun install          # 또는 npm install
npm run assets       # local-client 자산 준비(Whisper 모델·ORT WASM·웹폰트 → public/) — 최초 1회
npm run dev          # Vite dev 서버 → http://localhost:5173
npm run typecheck    # tsc --noEmit
npm run build        # 타입체크 + 프로덕션 빌드 → dist/
npm run preview      # dist/ 미리보기
```

> `npm run assets`(`scripts/fetch-local-assets.mjs`)는 Whisper 모델 3종(tiny/base/small)을 받아
> `public/models`에 두고, ONNX WASM 런타임(`/ort`)과 웹폰트(`/fonts`)를 자체 서빙 경로로 복사한다.
> 이후 앱은 **외부 도메인 접근 없이(same-origin만)** 동작한다. 특정 모델만 받으려면 모델 ID를
> 인자로, WebGPU용 fp32 가중치까지 받으려면 `--webgpu`를 붙인다.

브라우저는 **Chrome / Edge** 권장(Web Speech API). Firefox는 SpeechRecognition 미지원.

## STT E2E QA — 전 기능 자동 측정과 푸시 게이트

Provider를 고칠 때마다 손으로 파일을 올리고 재생 버튼을 누르는 확인은 회귀를 놓친다(실제로
Whisper 기본값 tiny의 CER 458% 환각을 그 방식으로는 못 잡고 있었다). 그래서 **모든 기능
(Provider × 모드 × 실행 위치)을 정답 전사가 있는 데이터셋으로 자동 측정**하고, 그 결과지가
기준선보다 나빠지지 않았을 때만 푸시되게 한다.

```bash
npm run qa:samples   # 데이터셋에서 테스트 사운드 배열 선정 → stt-e2e/samples.json (최초 1회)
npm run qa:stt       # 전 기능 자동 순회 → 결과지 작성 → 기준선 대비 판정(FAIL이면 non-zero exit)
npm run qa:gate      # 측정 없이 최신 결과지만 재판정
npm run qa:gate -- --promote   # 최신 결과지를 기준선으로 승격(재측정 없이) — 의도된 변화 반영용
npm run qa:hooks     # pre-push 게이트 활성화(git config core.hooksPath .githooks) — 최초 1회
```

- 기준 데이터: AI Hub 「상황별음성 상담 음성」(8kHz 전화). 경로는 `STT_QA_DATASET`으로 지정,
  기본값은 저장소와 나란한 `../aihub_call_center_dataset`.
- 옵션: `--profile quick|full`, `--samples N`, `--features a,b`, `--update-baseline`,
  `--no-servers`(온프레미스 서버를 직접 띄우지 않음), `--keep-open`(브라우저 유지).
- 온프레미스 서버(8765/8766/8767)는 러너가 필요할 때 **직접 띄우고 종료**한다. 사람이 서버를
  안 띄웠다는 이유로 기능이 SKIP되어 게이트가 헐거워지지 않게.

### 결과지 — `stt-e2e/`

```
stt-e2e/samples.json              테스트 사운드 배열(데이터셋 상대경로 + 정답 해시)
stt-e2e/baseline.json             기능별 기준 오류값 — 이 값 이하여야 푸시 가능
stt-e2e/<yyyy-mm-dd>/
  <기능>.json                     기능별 오류값 결과지(같은 날 재실행은 runs[]에 누적)
  summary.md / summary.json       그날의 결과지(사람이 읽는 표 / 기계 판정용)
stt-e2e/.local/                   원문 상세·브라우저 프로필·이벤트 로그 (커밋 제외)
```

정답 전사와 인식 결과 **원문은 커밋하지 않는다** — 이 저장소는 public이고 데이터셋은 이용 승인
기반이라 재배포 제약이 있다. 커밋되는 결과지에는 CER·편집거리·길이·지연 등 수치만 담고, 원문
대조는 `stt-e2e/.local/<날짜>/<기능>.detail.json`에서 한다.

### 게이트 규칙

- 기능별로 `cerAvg <= 기준선 + 허용오차` — **허용오차는 측정 재현성에 맞춘 값이다.**
  같은 구성으로 두 번 돌린 실측 변동폭: whisper-file 0.9%p · whisper-mic 0.5%p ·
  streaming-mic 2.0%p · sensevoice-file 1.8%p · sensevoice-mic 3.6%p · webspeech-file 3.7%p.
  실시간 스트리밍은 재생 타이밍·서버 백로그에, 클라우드는 서비스 상태에 따라 흔들린다.
  → **파일 재전사 3%p · 실시간(mic/스트리밍) 5%p · 클라우드 7%p.**
  재현성보다 타이트한 임계는 회귀가 없어도 매번 FAIL을 내 게이트를 무력화한다.
- 샘플 구성이 바뀌면(예: `--samples`) CER 평균도 달라진다 → 기준선과 비교할 수 없으니
  구성을 바꿀 때는 기준선을 다시 세운다(`npm run qa:gate -- --promote`)
- 기준선에 있던 기능이 이번에 SKIP → **FAIL**(측정을 건너뛰어 통과하는 길을 막는다)
- 기준선 갱신은 `--update-baseline`으로만. 자동 승격하면 한 번 통과한 회귀가 새 기준이 된다
- `pre-push` 훅은 **측정을 다시 돌리지 않고**(quick도 20분대) 최신 결과지를 검사한다:
  판정이 PASS인지 + 그 결과지가 **지금 푸시하는 소스로** 측정된 것인지(감시 경로 해시 일치) +
  샘플 정답·정규화 규칙이 그대로인지. STT 소스가 안 바뀐 푸시(문서·결과지만)는 그냥 통과한다.

### 자동 순회가 되는 이유 (사람이 재생 버튼을 누르지 않는다)

- **파일 모드**: `engine.start()`가 재생을 시작하고, 재생이 끝나면 엔진이 스스로 인식을 종료한다
  (`SttEngine`의 audio `ended` → `stop()`). 하네스는 다음 샘플로 넘어가기만 한다.
- **마이크 모드**: 하네스가 `getUserMedia`를 오버라이드해 샘플을 재생한 `captureStream()`을
  돌려준다 → PCM 경로(`AudioPcmTap`)와 WebSpeech `start(track)` 경로가 실제로 검증된다.
  실제 물리 마이크가 아닌 **파일 주입 가짜 마이크**이고, 결과지에 매번 명시된다.
- 자동 재생은 두 겹으로 보장한다: 러너가 `--autoplay-policy=no-user-gesture-required`로 Chrome을
  띄우고, **하네스의 [순회 시작] 버튼을 실제로 클릭**해 user activation을 만든다. 하네스가 쓰는
  `<audio>`는 `muted`라 정책과 무관하게 재생되며, muted가 `captureStream` 오디오를 죽이지
  않는 것은 실측으로 확인했다.
- CER 채택 규칙은 앱의 `DatasetPanel`과 동일하다(중지 후 1.5초 유예 + 개별/합친 final 중 최소).
  WebSpeech는 final이 중지 뒤에 도착하고 재시작 루프가 중복 final을 내므로 이 규칙이 없으면
  부당하게 나쁘게 측정된다.

### QA로 검증되지 않는 것

- 물리 마이크·에코·주변 잡음(가짜 마이크라서)
- WebSpeech는 클라우드 인식이라 실행마다 흔들린다 → 허용 오차 5%p, 회귀는 추세로 판단
- FunASR은 한국어를 못 하는 게 정상이다(중국어 전용 모델) → 절대 CER이 아니라 변화만 의미 있다
- 마이크 모드는 캡처가 붙기 전 재생이 조금 진행되어 발화 앞부분이 잘릴 수 있다 —
  같은 조건이 매번 반복되므로 회귀 감지에는 문제가 없지만, 절대값은 파일 모드보다 나쁘게 나온다

## 아키텍처

```
                         ┌──────────────── index.html (UI) ────────────────┐
                         │  업로드/목록 · 모드 토글 · 플레이어 · 자막 콘솔   │
                         └───────────────┬──────────────────────▲──────────┘
                       명령(주입/시작/중지)│                      │구독
                                          ▼                      │
                    ┌─────────────────────────────────────────────────────┐
   composition root │                  SttEngine  (Facade)                │
   (app.ts)         │  useProvider() · setMode() · loadFile() · start()    │
                    │      └ 결과 sink 주입 → EventBus 로 정규화 발행        │
                    └───────┬───────────────────────────┬─────────────────┘
                  주입(DI)  │                            │ 발행
          ┌────────────────▼─────────┐        ┌──────────▼───────────────────┐
          │   ProviderRegistry       │        │        EventBus (RxJS식)      │
          │   register/create        │        │  system$  ◀── 시스템 이벤트   │
          └────────────────┬─────────┘        │  feature$ ◀── 기능 이벤트     │
                           │ 생성              └──────────────────────────────┘
        ┌──────────────────▼───────────────────┐
        │           SttProvider (abstract)      │   ← adapter
        │   id · capabilities · start()/stop()  │
        └───────┬───────────────────────┬───────┘
                │
   ┌────────────┬──────────┴───┬──────────────┐
   ▼            ▼              ▼              ▼
WebSpeech    Whisper          Streaming        Qwen3
(mic/루프백) (클라이언트WASM) (클라우드WS)    (클라우드HTTP)
                └──────┬───────┘
        core/AudioPcmTap (+ worklets/pcm-processor)
        MediaStream → 16kHz PCM 공통 캡처 (Whisper/Streaming 공유)
```

### 키워드 → 코드 매핑

| 키워드 | 구현 위치 |
|---|---|
| **RxJS** | `src/core/EventBus.ts` — `Subject` + 필터된 파생 스트림(`system`/`feature`/`on`) |
| **OOP** | `SttProvider`(abstract) → WebSpeech/Whisper/Streaming/Qwen3 4종 상속 |
| **adapter** | `SttProvider` 베이스가 STT 백엔드 차이를 단일 인터페이스로 흡수 |
| **facade** | `SttEngine` — UI는 이 하나만 알면 됨 |
| **기능 기반 설계** | `src/providers/<provider>` 단위로 캡슐화, `src/core`는 도메인 무관 |
| **시스템 이벤트 호출** | `SystemEvent.*` (`bus.system(...)`) — 연결/생명주기/상태 |
| **기능 이벤트 호출** | `FeatureEvent.*` (`bus.feature(...)`) — 인식 결과(partial/final) |
| **모드별 주입** | `ProviderRegistry`(DI) + `engine.useProvider(id, config)` |

### Provider별 지원 모드

| Provider | 마이크 | 파일 | 방식 / 비고 |
|---|---|---|---|
| **WebSpeech** | ✅ 네이티브 실시간 | ✅ 디지털 트랙 입력 | `start(MediaStreamTrack)` (Chrome ~M133+). captureStream 트랙을 직접 인식 → 노이즈/볼륨 무관 |
| **Whisper** | ✅ 근실시간 | ✅ 근실시간 | 클라이언트 WASM/WebGPU(transformers.js 번들). 키·외부 도메인 불필요 — 자산은 `npm run assets`로 자체 서빙. 무음 경계로 발화를 잘라 인식(기본 base) |
| **Streaming** | ✅ 실시간 | ✅ 실시간 | WebSocket(16k Int16 PCM 전송 → partial/final 수신). 온프레미스 백엔드 동봉: `server/realtime_asr_server.py --engine faster-whisper` |
| **FunASR** | ✅ 실시간 | ✅ 실시간 | paraformer-zh-streaming 증분 디코딩(중국어 전용). 백엔드: `server/… --engine funasr` — 공식 WASM 런타임이 없어 온프레미스만 |
| **SenseVoice** | ✅ 실시간 | ✅ 실시간 | SenseVoiceSmall 다국어(**ko**/ja/en/zh/yue). 백엔드: `server/… --engine sensevoice` — offline 모델이라 증분 대신 재전사 partial(CPU 기준 ≈1.2s 간격) |
| **Qwen3** | ✅ 청크(골자) | ✅ 파일 전송 | 클라우드 HTTP 업로드. endpoint/model/apiKey 필요 (골자) |

### 실행 위치(RuntimeLocation)

Provider는 인식이 실제로 일어나는 위치를 선언하고(`static locations`), UI는 미지원 위치를 비활성화한다.

- **`local-client`** — 클라이언트 자체 CPU/GPU로 처리해 결과를 낸다(서버 전송 없음). 코드/모델
  자산도 별도 도메인 없이 자체 출처(same-origin)에서 받아 관리한다. Whisper가 여기 해당:
  transformers.js는 npm 번들, 모델은 `/models`, ORT WASM은 `/ort`에서 로드.
- **`remote-onpremise`** — 사내(자체 구축) 서버로 전송해 처리 (Streaming · FunASR · SenseVoice)
- **`remote-cloud`** — 외부 클라우드 서비스로 전송해 처리 (WebSpeech 기본 · Streaming · Qwen3)

WebSpeech에서 `local-client` 선택 시 Chrome 온디바이스(SODA, `processLocally`) 인식을 쓴다.

### 온프레미스 실시간 STT 서버 (faster-whisper / FunASR / SenseVoice)

Streaming ASR · FunASR · SenseVoice Provider의 백엔드. 16kHz Int16 PCM을 WebSocket으로 받아
partial(`{"text","isFinal":false}`) / final(`isFinal:true`)을 실시간으로 흘려보낸다.
모델은 최초 1회 `server/models/`로 다운로드되어 자체 관리된다(이후 오프라인 동작).

```bash
cd server
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt            # faster-whisper 엔진
.venv/bin/pip install -r requirements-funasr.txt     # (선택) FunASR·SenseVoice 엔진 — torch 포함, 용량 큼

.venv/bin/python realtime_asr_server.py --engine faster-whisper --model base  # ws://localhost:8765 · ko/en/ja/zh…
.venv/bin/python realtime_asr_server.py --engine funasr                       # ws://localhost:8766 · 중국어 전용
.venv/bin/python realtime_asr_server.py --engine sensevoice                   # ws://localhost:8767 · ko/ja/en/zh/yue
```

- faster-whisper: 발화 버퍼를 0.6s 주기로 재전사해 partial, RMS 무음 0.9s에서 final.
- FunASR: paraformer 스트리밍의 600ms 청크 증분 디코딩(진짜 스트리밍) — 부분 결과가 누적된다.
  기본 모델은 non-large(CPU에서 rtf<1 실시간). large(`--model paraformer-zh-streaming`)는 정확도가
  높지만 CPU에서 rtf≈2로 백로그가 쌓여 실시간 불가 — GPU 서버에서만 권장.
  ⚠ 중국어 단일 언어 모델(vocab8404)이라 **한국어를 넣으면 중국어 음절로 강제 매핑**된다 → 한국어는 SenseVoice/faster-whisper.
- SenseVoice: `iic/SenseVoiceSmall`(≈936MB) — 한국어 공식 지원(모델 `lid_dict`에 `ko`). 스트리밍
  API가 없는 offline 모델이라 faster-whisper와 같은 재전사 방식으로 partial을 만든다.
  언어는 UI의 언어 선택값(`ko-KR`→`ko`)을 그대로 쓰고, 미지원 코드는 모델이 auto로 판별한다.
  비자기회귀라 오디오 길이에는 둔감한데 **호출 1회의 고정 비용이 크다** — 8코어 맥 CPU(ncpu=4)
  실측으로 입력 0.25s/0.75s/1.6s 모두 ≈1.0s. 그래서 partial 주기는 1.2s(faster-whisper는 0.6s)이고,
  자막 갱신 간격도 그만큼 길다. `--ncpu 8`은 효율코어까지 써서 1.7s로 **악화**됐다 → 기본 4.

추론은 엔진 종류와 무관하게 **단일 워커(`INFER_POOL`)에서 직렬 실행**한다. partial 재전사와
finalize를 동시에 돌리면 같은 torch 스레드 풀을 서로 빼앗아 호출당 1.0s → 3.2s로 악화됐다(실측).
같은 이유로 앞선 추론이 진행 중이면 그 주기의 partial은 건너뛴다 — 결과가 뒤로 밀리지 않게.

### Whisper(local-client) 한국어 정확도 — 실측과 대응

AI Hub 상담 음성(8kHz 전화, 정답 전사 포함)으로 CER을 재고 설정을 정했다.
짧은 발화 12개(2~10초)와 긴 연속 오디오 2개(35·39초, 발화 7개를 0.5s 무음으로 이어붙임) 기준.

| 설정 | 짧은 발화 CER | 긴 오디오 CER |
|---|---|---|
| tiny · 5초 고정 청크 (이전 기본값) | **458%** | — |
| base · 5초 고정 청크 | 27.6% | **175.8%** |
| base · 무음 경계 분할 | — | **26.5%** |
| base · 전체 + `chunk_length_s=30`/`stride=5` | 24.6% | 23.4% |
| small · 무음 경계 + 반복 축약 | — | 26.0% |

CER이 100%를 넘는 값은 오인식이 아니라 **환각**이다 — 참조보다 몇 배 긴 텍스트를 만들어낸다.
실제 사례: 5초 고정 청크가 발화 중간을 자르자 `"이 시각에서"`가 100회 이상 반복(CER 309%),
small에서는 이메일 스펠링 구간이 `"…-2-2-2-2-2…"`로 수백 자 이어졌다(CER 129%).

그래서 세 가지를 바꿨다.

1. **기본 모델 tiny → base.** tiny는 8kHz 전화 음성에서 사실상 사용 불가(458%). 선택지에는 남겨
   두되 라벨에 비권장을 표시했다. 깨끗한 16kHz 마이크 녹음에서는 tiny도 쓸 만하다.
2. **고정 5초 청크 → 무음 경계 분할**(RMS 0.008 · 무음 0.5s · 최소 1s · 최대 `maxChunkSec`).
   발화 중간을 자르지 않아 반복 환각이 사라지고, 발화 전 무음은 버려 없는 말을 만들지 않는다.
   온프레미스 서버(`realtime_asr_server.py`)와 같은 규칙이다.
3. **반복 환각 축약 후처리**(`collapseHallucinatedRepeats`). 어절 n-gram과 토큰 내부 문자 패턴의
   연속 반복을 2회로 줄인다. 환각 사례는 175.8%→41.1%, 129%→41% 로 잡히고 **정상 결과의 CER은
   변하지 않았다**(26.5%→26.5%, 23.4%→23.4%).

측정해 보고 **넣지 않은 것**: `no_repeat_ngram_size=3`은 정상 문장을 건드려 24.6%→25.4%로
악화됐고, `num_beams=3`은 CER 변화 없이 시간만 늘었다(둘 다 짧은 발화 12개 기준).

> `chunk_length_s=30`/`stride_length_s=5`는 발화가 `maxChunkSec`로 강제 확정될 때를 위한
> 안전장치로 인식 호출에 함께 넘긴다(Whisper 인식 창이 30s이므로 초과분은 5s 겹쳐 청킹).
> 긴 오디오를 한 번에 넣는 방식이 CER은 가장 낮았지만(23.4%), 재생과 동기된 실시간 자막이
> 이 페이지의 목적이라 기본 경로로는 쓰지 않는다.

> **파일 audiotrack 실시간 STT 파이프라인** (루프백 없이):
> `<audio> 재생 → audio.captureStream() → audio MediaStreamTrack → Provider`
> 모든 Provider가 이 디지털 트랙을 받는다(WebSpeech는 `start(track)`, Whisper/Streaming은 `AudioPcmTap`으로 16kHz PCM 변환).
> 음향(스피커→마이크)을 안 거치므로 주변 소음/볼륨과 무관하다.
> 엔진은 Provider의 `prepare()`(모델 로드 등 무거운 준비)가 끝난 **뒤에** 재생을 시작한다 — 준비 중 재생으로 파일 앞부분이 잘리지 않는다.

### WebSpeech로 파일을 노이즈/볼륨 없이 인식하기 (순수 JS — 1순위, 검증됨)

**2026 기준 결정판:** `SpeechRecognition.start()`에 `MediaStreamTrack` 오버로드가 추가되어
파일 재생 트랙을 *디지털로 직접* 인식시킬 수 있다. 마이크·스피커·가상장치·플래그 전부 불필요.
스펙상 audioTrack 경로는 마이크 권한을 요구하지 않는다(`requestMicrophonePermission=false`) → 노이즈/볼륨 무관이 스펙으로 보장.

```js
const audioEl = new Audio(URL.createObjectURL(file));
await audioEl.play();                              // 트랙이 'live' 상태가 됨(필수)
const track = audioEl.captureStream().getAudioTracks()[0];
const rec = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
rec.lang = 'ko-KR'; rec.continuous = true; rec.interimResults = true;
rec.onresult = (e) => { /* 실시간 자막 */ };
rec.start(track);                                  // ← 인자 있는 start(). 마이크 안 씀.
```

이 앱에선 `src/providers/WebSpeechProvider.ts`가 이 방식으로 동작한다(엔진이 `captureStream` 트랙을 주입).

**검증(이 환경 Chrome 145, 직접 실행):**
- `start({})` → `TypeError: parameter 1 is not of type 'MediaStreamTrack'` (오버로드 실재)
- `start(endedTrack)` → `InvalidStateError: ...not of state 'live'` (스펙대로)
- `start(liveTrack)` → throw 없음, `onstart`/`onaudiostart` 발생 (정상 인식 시작)

**제약 (정직하게):**
- Chromium 데스크톱(Chrome/Edge, ~M133+) 전용. Safari/Firefox/Android는 미지원 → Whisper Provider로 폴백.
- `start.length`로 기능 감지 불가(미해결 spec issue). 본 앱은 `start({})` TypeError 여부로 런타임 탐지 후, 미지원이면 안내한다.

> **폴백 (미지원 브라우저에서 굳이 WebSpeech를 써야 할 때):** 가상 오디오 장치 디지털 루프백.
> `brew install blackhole-2ch` → 앱에서 출력을 BlackHole로 라우팅(`setSinkId`) → macOS 사운드 입력을 BlackHole로 지정 → WebSpeech가 기본 입력으로 그 오디오를 읽음.
> (Windows=VB-CABLE, 유료 GUI=Loopback.) 단, 더 간단한 목적이면 **Whisper**가 가상장치 없이 `captureStream`으로 이미 디지털 인식한다.

## 새 Provider 추가하기

```ts
// 1) SttProvider 상속
export class WhisperProvider extends SttProvider {
  static override readonly id = 'whisper';
  static override readonly label = 'Whisper';
  static override readonly capabilities: readonly Mode[] = [Mode.FILE];
  async start(input: SttInput): Promise<void> { /* ... this._sink.final(text) ... */ }
}
// 2) 합성 루트(app.ts)에서 등록만 하면 끝 — UI/엔진 수정 불필요
registry.register(WhisperProvider);
```

## 데이터셋(독립 샘플) 붙이기 — DatasetAdapter

폴더 구조·라벨 포맷이 제각각인 로컬 데이터셋을 "독립 샘플" 단위로 붙인다.
Provider와 동일한 주입형 패턴: **데이터셋 1개 = 어댑터 1개**, UI는 정규화 모델만 안다.

```
DATASET 패널(src/ui/DatasetPanel.ts)
  → 폴더 인입: File System Access API(폴더 핸들, IndexedDB에 기억)
              / <input webkitdirectory> 폴백 / entries 주입(테스트 시드)
  → FileTreeIndex: 인입 경로 3종을 "상대경로→File" 인덱스로 통일 (NFC 정규화)
  → DatasetRegistry.detect(index): 등록된 어댑터 중 해석 가능한 것을 자동 감지
  → DatasetAdapter: listSessions() / loadSession() → 정규화 세션·발화 모델
  → 발화 클릭 → engine.loadFile() (기존 파일 파이프라인 그대로)
              + REF(정답 전사) 표시 + 인식 종료 시 CER(src/core/cer.ts) 리포트
```

정규화 모델(어댑터가 반환해야 하는 형태 — `src/datasets/DatasetAdapter.ts` 참고):

```js
Session   = { id, meta: { title, lines: string[] }, utterances: Utterance[] }
Utterance = { id, order, speaker: { id, role, detail },
              text /* 정규화 전사 */, textRaw, file: () => Promise<File> }
```

새 독립 샘플 추가 절차:

```ts
// 1) DatasetAdapter 상속 — detect()로 폴더 규격을 식별, loadSession()에서 정규화
export class MyDatasetAdapter extends DatasetAdapter {
  static override readonly id = 'my-dataset';
  static override readonly label = '내 데이터셋';
  static override detect(index: FileTreeIndex): boolean {
    return index.paths.some((p) => /* 규격 시그니처 */ false);
  }
  async listSessions(): Promise<SessionSummary[]> { /* ... */ }
  async loadSession(id: string): Promise<DatasetSession> { /* ... */ }
}
// 2) 합성 루트(app.ts)에서 등록만 하면 끝 — UI 수정 불필요
datasetRegistry.register(MyDatasetAdapter);
```

현재 등록: **AihubCallCenterAdapter** (`src/datasets/adapters/AihubCallCenterAdapter.ts`)
— AI Hub 「상황별음성 상담 음성」(KtelSpeech). `라벨링데이터/**/SXXXX/SXXXX.json`(세션 메타·발화 순서)
+ 발화별 `NNNN.txt`(UTF-8 전사) + `원천데이터/**/SXXXX/NNNN.wav`(8kHz mono).
JSON 내부 `audioPath`는 실제 배치와 달라 신뢰하지 않고 `세션ID/파일명` 접미로 wav를 역매핑한다.
전사 태그 정규화: `(표기)/(발음)`→표기, `n/ u/ b/ o/` 제거, `아/`→`아`, `+`·`@` 제거.

CER 산출 주의점(코드에 반영됨):
- WebSpeech는 final이 `RECOGNITION_STOPPED` **이후**에 도착하기도 함 → 중지 후 1.5s 유예 수집.
- WebSpeech 재시작 루프는 누적 중복 final을 내보냄 → 개별 final·전체 join을 후보로 최소 CER 채택.

## 알려진 제약 / TODO

- **WebSpeech 파일 인식**: `start(MediaStreamTrack)`(Chrome ~M133+)으로 captureStream 트랙을 직접 인식 → 가능·노이즈/볼륨 무관(검증됨). Chromium 데스크톱 전용, 미지원 시 Whisper 폴백.
- **Whisper(local-client)**: 코드/모델/WASM 런타임 전부 same-origin 자산 — 최초 1회 `npm run assets` 필요(미준비 시 안내 에러). 멀티스레드 WASM은 COOP/COEP(`credentialless`) 헤더 필요 — vite dev/preview에는 설정돼 있고, 미적용 호스팅에서는 단일 스레드로 폴백. WebGPU는 fp32 가중치(`npm run assets -- --webgpu`)가 있을 때만 시도. 한국어 기본은 `whisper-base`(tiny는 8kHz 전화 음성에서 CER 458% — 위 실측 참조). 발화 단위 인식이라 발화가 끝나고 무음 0.5s가 지난 뒤 자막이 뜬다(발화 도중 부분 결과는 없음).
- **Streaming**: 동봉된 온프레미스 서버(`server/realtime_asr_server.py`)의 프로토콜이 기본값. 외부 클라우드 벤더에 붙이려면 `#onOpen`/`#send`/`#onMessage`를 해당 스펙에 맞춰 조정.
- **FunASR**: 기본 모델(paraformer-zh-streaming)이 중국어 전용 — 한국어 실시간은 SenseVoice 또는 Streaming(faster-whisper)을 사용. 공식 브라우저(WASM) 런타임이 없어 실행 위치는 온프레미스만.
- **SenseVoice**: 다국어(ko/ja/en/zh/yue)지만 offline 모델이라 FunASR paraformer 같은 증분 스트리밍은 아니다(무음 경계 확정 + 주기 재전사 partial). 모델 ≈936MB 최초 다운로드 필요. 공식 브라우저 런타임 미사용 — 실행 위치는 온프레미스만.
- **Qwen3(클라우드 HTTP)**: 요청/응답 스키마·모델 id는 제공자 문서에 맞춰 `#transcribeFile`/`#streamMic` 조정 필요.
- `qwen3-tts`는 TTS(텍스트→음성)이고, 이 페이지 목적인 STT에는 ASR 모델이 맞다.
