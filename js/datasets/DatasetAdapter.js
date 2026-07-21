/**
 * 데이터셋 어댑터 추상 계약.
 *
 * "독립 샘플" 1개(폴더 구조·라벨 포맷이 제각각인 데이터셋 하나)당 어댑터 1개를 만든다.
 * SttProvider와 같은 주입형 패턴: 구체 어댑터는 합성 루트(app.js)에서만 등록하고,
 * UI(DatasetPanel)는 이 추상 계약과 정규화된 세션/발화 모델에만 의존한다.
 *
 * ── 정규화 모델 ──────────────────────────────────────────────────────
 * SessionSummary: { id, label, utteranceCount }
 * Session: {
 *   id,
 *   meta: { title, lines: string[] },        // 패널에 그대로 뿌릴 요약 정보
 *   utterances: Utterance[]
 * }
 * Utterance: {
 *   id,                                       // 세션 내 유일 (예: '0001')
 *   order,                                    // 1부터
 *   speaker: { id, role, detail },            // role: '상담원'|'고객'|기타 자유 문자열
 *   text,                                     // 표시/평가용 정규화 전사
 *   textRaw,                                  // 원문 전사(태그 포함)
 *   file: () => Promise<File>                 // 오디오 지연 로드
 * }
 */
export class DatasetAdapter {
  /** 어댑터 식별자/표시명 — 서브클래스에서 재정의 */
  static id = 'abstract';
  static label = 'Abstract Dataset';

  /**
   * 이 어댑터가 인덱스(폴더 트리)를 해석할 수 있는지 검사한다.
   * @param {import('./FileTreeIndex.js').FileTreeIndex} index
   * @returns {boolean}
   */
  // eslint-disable-next-line no-unused-vars
  static detect(index) {
    return false;
  }

  /** @param {import('./FileTreeIndex.js').FileTreeIndex} index */
  constructor(index) {
    this.index = index;
  }

  get id() {
    return this.constructor.id;
  }
  get label() {
    return this.constructor.label;
  }

  /** @returns {Promise<Array<{id:string,label:string,utteranceCount:number}>>} */
  async listSessions() {
    throw new Error(`[${this.id}] listSessions() 미구현`);
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<object>} 정규화된 Session
   */
  // eslint-disable-next-line no-unused-vars
  async loadSession(sessionId) {
    throw new Error(`[${this.id}] loadSession() 미구현`);
  }
}
