/**
 * CER(문자 오류율) 계산 유틸.
 *
 * 한국어 STT 평가 관례에 따라 공백·문장부호를 제거한 문자열에 대해
 * 편집 거리(Levenshtein)를 구한다. 참조(ref) 길이 대비 비율이 CER.
 */

export interface CerResult {
  distance: number;
  refLength: number;
  rate: number;
}

/** 평가용 정규화: 소문자화 후 한글/영문/숫자만 남긴다(공백·문장부호 제거). */
export function normalizeForCer(s: string | null | undefined): string {
  return (s || '').toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
}

/** 두 문자열의 편집 거리(삽입/삭제/치환 각 1). */
export function editDistance(a: string, b: string): number {
  const r = [...a];
  const h = [...b];
  if (!r.length) return h.length;
  if (!h.length) return r.length;
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  const cur = new Array<number>(h.length + 1);
  for (let i = 1; i <= r.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= h.length; j++) {
      const cost = r[i - 1] === h[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= h.length; j++) prev[j] = cur[j];
  }
  return prev[h.length];
}

/**
 * CER 계산.
 * @param refText 참조(정답) 문장 — 원문 그대로 넣으면 내부에서 정규화
 * @param hypText 인식 결과 문장
 * @returns ref가 비면 null
 */
export function cer(refText: string, hypText: string): CerResult | null {
  const ref = normalizeForCer(refText);
  const hyp = normalizeForCer(hypText);
  if (!ref.length) return null;
  const distance = editDistance(ref, hyp);
  return { distance, refLength: [...ref].length, rate: distance / [...ref].length };
}
