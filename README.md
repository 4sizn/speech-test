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
| **Whisper** | ✅ 근실시간 | ✅ 근실시간 | 클라이언트 WASM/WebGPU(transformers.js 번들). 키·외부 도메인 불필요 — 자산은 `npm run assets`로 자체 서빙 |
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
- **Whisper(local-client)**: 코드/모델/WASM 런타임 전부 same-origin 자산 — 최초 1회 `npm run assets` 필요(미준비 시 안내 에러). 멀티스레드 WASM은 COOP/COEP(`credentialless`) 헤더 필요 — vite dev/preview에는 설정돼 있고, 미적용 호스팅에서는 단일 스레드로 폴백. WebGPU는 fp32 가중치(`npm run assets -- --webgpu`)가 있을 때만 시도. `Xenova/whisper-tiny`는 가볍지만 정확도 낮음 → 한국어는 `whisper-base`+ 권장. 청크 단위 인식이라 청크 경계 지연 있음.
- **Streaming**: 동봉된 온프레미스 서버(`server/realtime_asr_server.py`)의 프로토콜이 기본값. 외부 클라우드 벤더에 붙이려면 `#onOpen`/`#send`/`#onMessage`를 해당 스펙에 맞춰 조정.
- **FunASR**: 기본 모델(paraformer-zh-streaming)이 중국어 전용 — 한국어 실시간은 SenseVoice 또는 Streaming(faster-whisper)을 사용. 공식 브라우저(WASM) 런타임이 없어 실행 위치는 온프레미스만.
- **SenseVoice**: 다국어(ko/ja/en/zh/yue)지만 offline 모델이라 FunASR paraformer 같은 증분 스트리밍은 아니다(무음 경계 확정 + 주기 재전사 partial). 모델 ≈936MB 최초 다운로드 필요. 공식 브라우저 런타임 미사용 — 실행 위치는 온프레미스만.
- **Qwen3(클라우드 HTTP)**: 요청/응답 스키마·모델 id는 제공자 문서에 맞춰 `#transcribeFile`/`#streamMic` 조정 필요.
- `qwen3-tts`는 TTS(텍스트→음성)이고, 이 페이지 목적인 STT에는 ASR 모델이 맞다.
