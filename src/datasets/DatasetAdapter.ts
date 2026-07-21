import type { FileTreeIndex } from './FileTreeIndex';

/** 정규화된 화자 정보. role은 '상담원'|'고객' 등 자유 문자열. */
export interface SpeakerInfo {
  id: string;
  role: string;
  detail: string;
}

/** 정규화된 발화 1건. */
export interface Utterance {
  /** 세션 내 유일 (예: '0001') */
  id: string;
  /** 1부터 */
  order: number;
  speaker: SpeakerInfo;
  /** 표시/평가용 정규화 전사 */
  text: string;
  /** 원문 전사(태그 포함) */
  textRaw: string;
  /** 오디오 지연 로드 */
  file: () => Promise<File>;
}

/** 패널에 그대로 뿌릴 세션 요약 정보. */
export interface SessionMeta {
  title: string;
  lines: string[];
}

/** 정규화된 세션. */
export interface DatasetSession {
  id: string;
  meta: SessionMeta;
  utterances: Utterance[];
}

export interface SessionSummary {
  id: string;
  label: string;
  utteranceCount: number;
}

/** 레지스트리가 다루는 어댑터 클래스(정적 측) 계약. */
export interface DatasetAdapterClass {
  readonly id: string;
  readonly label: string;
  /** 이 어댑터가 인덱스(폴더 트리)를 해석할 수 있는지 검사한다. */
  detect(index: FileTreeIndex): boolean;
  new (index: FileTreeIndex): DatasetAdapter;
}

/**
 * 데이터셋 어댑터 추상 계약.
 *
 * "독립 샘플" 1개(폴더 구조·라벨 포맷이 제각각인 데이터셋 하나)당 어댑터 1개를 만든다.
 * SttProvider와 같은 주입형 패턴: 구체 어댑터는 합성 루트(app.ts)에서만 등록하고,
 * UI(DatasetPanel)는 이 추상 계약과 정규화된 세션/발화 모델에만 의존한다.
 */
export abstract class DatasetAdapter {
  /** 어댑터 식별자/표시명 — 서브클래스에서 재정의 */
  static readonly id: string = 'abstract';
  static readonly label: string = 'Abstract Dataset';

  static detect(_index: FileTreeIndex): boolean {
    return false;
  }

  readonly index: FileTreeIndex;

  constructor(index: FileTreeIndex) {
    this.index = index;
  }

  get id(): string {
    return (this.constructor as DatasetAdapterClass).id;
  }

  get label(): string {
    return (this.constructor as DatasetAdapterClass).label;
  }

  abstract listSessions(): Promise<SessionSummary[]>;

  abstract loadSession(sessionId: string): Promise<DatasetSession>;
}
