import { DatasetAdapter } from '../DatasetAdapter.js';

/**
 * AI Hub 「상황별음성(상담 음성)」 데이터셋 어댑터.
 *
 * 폴더 규격:
 *   라벨링데이터/KtelSpeech_train_D60_label_0/J91/S00007805/S00007805.json  ← 세션 메타(dialogs 순서·화자)
 *   라벨링데이터/.../S00007805/0001.txt                                     ← 발화별 전사(UTF-8)
 *   원천데이터/KtelSpeech_train_D60_wav_0/J91/S00007805/0001.wav            ← 발화별 오디오(8kHz mono)
 *
 * JSON의 audioPath("KtelSpeech/D60/...")는 실제 폴더 배치와 다르므로 경로를 믿지 않고,
 * "세션ID/파일명" 접미(suffix)로 실제 wav를 역매핑한다 — 배치가 바뀌어도 동작.
 *
 * 전사 표기 규칙(정규화 근거 — 데이터 전수 스캔으로 확인):
 *   (표기)/(발음)  이중 전사        → 표기 채택 (예: "(1번)/(한 번)" → "1번")
 *   n/ u/ b/ o/    잡음·불명확 태그 → 제거
 *   아/ 어/        간투어 표기      → 슬래시만 제거
 *   단어+          더듬/수정 발화   → '+'만 제거
 *   @이름          개인정보 가명    → '@'만 제거
 */
export class AihubCallCenterAdapter extends DatasetAdapter {
  static id = 'aihub-call-center';
  static label = 'AI Hub 상담 음성 (KtelSpeech)';

  static #SESSION_RE = /(?:^|\/)라벨링데이터\/.*\/(S\d+)\/\1\.json$/;

  static detect(index) {
    return index.paths.some((p) => AihubCallCenterAdapter.#SESSION_RE.test(p));
  }

  /** @type {Map<string, {jsonPath:string, dir:string}>|null} sessionId → 라벨 위치 */
  #sessions = null;
  /** @type {Map<string, string>|null} "세션ID/파일명.wav" → 실제 경로 */
  #wavBySuffix = null;

  #scan() {
    if (this.#sessions) return;
    this.#sessions = new Map();
    this.#wavBySuffix = new Map();
    for (const p of this.index.paths) {
      const m = p.match(AihubCallCenterAdapter.#SESSION_RE);
      if (m) {
        this.#sessions.set(m[1], { jsonPath: p, dir: p.slice(0, p.lastIndexOf('/')) });
        continue;
      }
      if (p.endsWith('.wav') && /(?:^|\/)원천데이터\//.test(p)) {
        const seg = p.split('/');
        if (seg.length >= 2) this.#wavBySuffix.set(seg.slice(-2).join('/'), p);
      }
    }
  }

  async listSessions() {
    this.#scan();
    return [...this.#sessions.entries()]
      .map(([id, { dir }]) => {
        const prefix = `${dir}/`;
        const count = this.index.paths.filter((p) => p.startsWith(prefix) && p.endsWith('.txt')).length;
        return { id, label: `${id} · 발화 ${count}`, utteranceCount: count };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async loadSession(sessionId) {
    this.#scan();
    const loc = this.#sessions.get(sessionId);
    if (!loc) throw new Error(`세션을 찾을 수 없습니다: ${sessionId}`);

    const json = await this.index.readJson(loc.jsonPath);
    const info = json?.dataSet?.typeInfo ?? {};
    const dialogs = json?.dataSet?.dialogs ?? [];

    const speakers = new Map(
      (info.speakers ?? []).map((s) => [
        s.id,
        { id: s.id, role: s.type || '화자', detail: [s.gender, s.age, s.residence].filter(Boolean).join('·') },
      ]),
    );

    let missing = 0;
    const utterances = await Promise.all(
      dialogs.map(async (d, i) => {
        const base = (d.audioPath || '').split('/').pop(); // '0001.wav'
        const uttId = base.replace(/\.wav$/i, '');
        const wavPath = this.#wavBySuffix.get(`${sessionId}/${base}`);
        const txtPath = `${loc.dir}/${uttId}.txt`;
        if (!wavPath || !this.index.has(txtPath)) {
          missing++;
          return null;
        }
        const textRaw = (await this.index.readText(txtPath)).trim();
        return {
          id: uttId,
          order: i + 1,
          speaker: speakers.get(d.speaker) ?? { id: d.speaker, role: '화자', detail: '' },
          text: normalizeAihubText(textRaw),
          textRaw,
          file: async () => {
            const f = await this.index.file(wavPath);
            // 플레이어/자막 태그에 세션 맥락이 보이도록 이름을 재지정
            return new File([f], `${sessionId}_${base}`, { type: 'audio/wav' });
          },
        };
      }),
    );
    if (missing) console.warn(`[${this.id}] ${sessionId}: 오디오/전사 누락 발화 ${missing}건 제외`);

    const speakerLine = [...speakers.values()].map((s) => `${s.role}(${s.detail})`).join(' ↔ ');
    return {
      id: sessionId,
      meta: {
        title: `${info.category ?? ''}${info.subcategory && info.subcategory !== info.category ? `/${info.subcategory}` : ''}`,
        lines: [speakerLine, `입력: ${info.inputType ?? '?'} · 수집일: ${json?.dataSet?.date ?? '?'}`].filter(Boolean),
      },
      utterances: utterances.filter(Boolean),
    };
  }
}

/** 전사 원문 → 표시/평가용 문장(철자 표기 기준). */
export function normalizeAihubText(raw) {
  return (raw || '')
    .replace(/\(([^)]*)\)\/\(([^)]*)\)/g, '$1') // 이중 전사 → 철자 표기
    .replace(/(^|\s)[a-z]+\//g, '$1') // n/ u/ b/ o/ 등 태그 제거
    .replace(/([가-힣])\//g, '$1') // 간투어 '아/' → '아'
    .replace(/[@+]/g, '') // 가명 마커·더듬 마커 제거
    .replace(/\s+/g, ' ')
    .trim();
}
