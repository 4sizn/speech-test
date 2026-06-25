# SPEECH·LAB — Provider 주입형 실시간 STT 콘솔

업로드한 오디오 또는 마이크 입력을 **실시간으로 음성→텍스트(STT)** 변환해 출력하는 단일 페이지.
STT 백엔드는 **Provider(어댑터)** 로 추상화되어 있고, **모드별로 주입**되어 동일한 출력 파이프로 흘러나온다.

ws-network의 `WebSocketClientAdapter` + facade 패턴과 RVS SDK의 `MessageBus`(system/feature 이벤트 분리)를
STT 도메인에 적용한 골자다.

## 실행

> ⚠️ 마이크/음성인식(`getUserMedia`, `SpeechRecognition`)은 **https 또는 localhost(보안 컨텍스트)** 에서만 동작한다.
> 파일을 직접 더블클릭(`file://`)하면 ES 모듈/마이크가 막히므로 반드시 로컬 서버로 연다.

```bash
# 아무거나 하나
python3 -m http.server 5173      # → http://localhost:5173
bunx --bun serve -l 5173 .
npx serve -l 5173 .
```

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
   (app.js)         │  useProvider() · setMode() · loadFile() · start()    │
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
WebSpeech    Whisper       Streaming        Qwen3
(mic/루프백) (로컬WASM/GPU) (클라우드WS)    (클라우드HTTP)
                └──────┬───────┘
        core/AudioPcmTap (+ worklets/pcm-processor)
        MediaStream → 16kHz PCM 공통 캡처 (Whisper/Streaming 공유)
```

### 키워드 → 코드 매핑

| 키워드 | 구현 위치 |
|---|---|
| **RxJS** | `js/core/EventBus.js` — `Subject` + 필터된 파생 스트림(`system`/`feature`/`on`) |
| **OOP** | `SttProvider`(abstract) → WebSpeech/Whisper/Streaming/Qwen3 4종 상속 |
| **adapter** | `SttProvider` 베이스가 STT 백엔드 차이를 단일 인터페이스로 흡수 |
| **facade** | `SttEngine` — UI는 이 하나만 알면 됨 |
| **기능 기반 설계** | `js/providers/<provider>` 단위로 캡슐화, `js/core`는 도메인 무관 |
| **시스템 이벤트 호출** | `SystemEvent.*` (`bus.system(...)`) — 연결/생명주기/상태 |
| **기능 이벤트 호출** | `FeatureEvent.*` (`bus.feature(...)`) — 인식 결과(partial/final) |
| **모드별 주입** | `ProviderRegistry`(DI) + `engine.useProvider(id, config)` |

### Provider별 지원 모드

| Provider | 마이크 | 파일 | 방식 / 비고 |
|---|---|---|---|
| **WebSpeech** | ✅ 네이티브 실시간 | ✅ 디지털 트랙 입력 | `start(MediaStreamTrack)` (Chrome ~M133+). captureStream 트랙을 직접 인식 → 노이즈/볼륨 무관 |
| **Whisper** | ✅ 근실시간 | ✅ 근실시간 | 로컬 WASM/WebGPU(transformers.js). 키 불필요, 최초 모델 다운로드 |
| **Streaming** | ✅ 실시간 | ✅ 실시간 | 클라우드 WebSocket(PCM 청크 전송). 엔드포인트/키 필요 (골자) |
| **Qwen3** | ✅ 청크(골자) | ✅ 파일 전송 | 클라우드 HTTP 업로드. endpoint/model/apiKey 필요 (골자) |

> **파일 audiotrack 실시간 STT 파이프라인** (루프백 없이):
> `<audio> 재생 → audio.captureStream() → audio MediaStreamTrack → Provider`
> 모든 Provider가 이 디지털 트랙을 받는다(WebSpeech는 `start(track)`, Whisper/Streaming은 `AudioPcmTap`으로 16kHz PCM 변환).
> 음향(스피커→마이크)을 안 거치므로 주변 소음/볼륨과 무관하다.

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

이 앱에선 `js/providers/WebSpeechProvider.js`가 이 방식으로 동작한다(엔진이 `captureStream` 트랙을 주입).

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

```js
// 1) SttProvider 상속
export class WhisperProvider extends SttProvider {
  static id = 'whisper';
  static label = 'Whisper';
  static capabilities = [Mode.FILE];
  async start(input) { /* ... this._sink.final(text) ... */ }
}
// 2) 합성 루트(app.js)에서 등록만 하면 끝 — UI/엔진 수정 불필요
registry.register(WhisperProvider);
```

## 알려진 제약 / TODO

- **WebSpeech 파일 인식**: `start(MediaStreamTrack)`(Chrome ~M133+)으로 captureStream 트랙을 직접 인식 → 가능·노이즈/볼륨 무관(검증됨). Chromium 데스크톱 전용, 미지원 시 Whisper 폴백.
- **Whisper(로컬)**: transformers.js를 CDN에서 동적 import(네트워크 필요), 모델 최초 다운로드(수십~수백MB). `Xenova/whisper-tiny`는 가볍지만 정확도 낮음 → 한국어는 `whisper-base`+ 권장. 청크 단위 인식이라 청크 경계 지연 있음.
- **Streaming(클라우드)**: 벤더별 핸드셰이크/오디오 포맷/응답 스키마가 달라 `#onOpen`/`#send`/`#onMessage`를 실제 스펙에 맞춰야 함(코드 내 `TODO`).
- **Qwen3(클라우드 HTTP)**: 요청/응답 스키마·모델 id는 제공자 문서에 맞춰 `#transcribeFile`/`#streamMic` 조정 필요.
- `qwen3-tts`는 TTS(텍스트→음성)이고, 이 페이지 목적인 STT에는 ASR 모델이 맞다.
