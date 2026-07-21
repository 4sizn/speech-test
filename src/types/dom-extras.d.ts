/**
 * lib.dom에 아직 없는(또는 브라우저별 프리픽스인) API 선언 모음.
 *
 * - SpeechRecognition: lib.dom 미포함 + 2025~ 신규 확장
 *   (start(MediaStreamTrack) 오버로드, processLocally, static available/install)
 * - webkitAudioContext / captureStream / mozCaptureStream: 프리픽스·비표준
 * - showDirectoryPicker / FileSystemDirectoryHandle.values(): File System Access API
 */

interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechRecognitionAlternative | undefined;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  readonly [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}

interface SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  /** 온디바이스(SODA) 인식 요청 — Chrome ~M139+ */
  processLocally?: boolean;
  onstart: ((this: SpeechRecognition, ev: Event) => void) | null;
  onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void) | null;
  onend: ((this: SpeechRecognition, ev: Event) => void) | null;
  /** 인자 없이 = 마이크. MediaStreamTrack 오버로드(Chrome ~M133+) = 디지털 트랙 직접 입력. */
  start(audioTrack?: MediaStreamTrack | object): void;
  stop(): void;
  abort(): void;
}

interface SpeechRecognitionStatic {
  new (): SpeechRecognition;
  /** 온디바이스 모델 가용성 질의 — Chrome ~M139+ */
  available?(options: { langs: string[]; processLocally?: boolean }): Promise<
    'available' | 'downloadable' | 'downloading' | 'unavailable'
  >;
  /** 온디바이스 모델 설치 — Chrome ~M139+ */
  install?(options: { langs: string[]; processLocally?: boolean }): Promise<unknown>;
}

interface Window {
  SpeechRecognition?: SpeechRecognitionStatic;
  webkitSpeechRecognition?: SpeechRecognitionStatic;
  webkitAudioContext?: typeof AudioContext;
  showDirectoryPicker?(options?: { mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>;
  /** 디버그/테스트 시드 (app.ts에서 노출) */
  __speechLab?: {
    engine: unknown;
    datasetPanel: { openFromEntries(entries: Array<{ path: string; file: File }>, name?: string): Promise<void> };
  };
}

interface HTMLMediaElement {
  captureStream?(): MediaStream;
  mozCaptureStream?(): MediaStream;
}

interface FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle>;
  queryPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}
