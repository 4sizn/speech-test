import { FileTreeIndex, type FileEntry } from '../datasets/FileTreeIndex';
import { saveHandle, loadHandle, ensurePermission } from '../datasets/handleStore';
import { SystemEvent, FeatureEvent, Mode } from '../core/events';
import { cer, type CerResult } from '../core/cer';
import type { SttEngine } from '../core/SttEngine';
import type { DatasetRegistry } from '../datasets/DatasetRegistry';
import type { DatasetAdapter, DatasetSession, Utterance } from '../datasets/DatasetAdapter';

const HANDLE_KEY = 'last-dataset';

export interface DatasetPanelDeps {
  engine: SttEngine;
  registry: DatasetRegistry;
  setStatus: (text: string, kind?: string) => void;
  /** 자막 콘솔에 라인 추가 */
  appendLine: (tag: string, text: string, className?: string) => void;
}

export interface DatasetPanelApi {
  /** 테스트/외부 주입 시드: [{path, file}] 배열로 데이터셋을 연다. */
  openFromEntries(entries: FileEntry[], name?: string): Promise<void>;
}

/**
 * DATASET 패널 UI.
 *
 * 폴더 인입(FS Access API / webkitdirectory / entries 주입) → 레지스트리에서 어댑터
 * 자동 감지 → 정규화된 세션·발화 모델 렌더. 발화를 고르면 기존 파일 파이프라인
 * (engine.loadFile)을 그대로 타고, 참조 문장을 표시하며 인식 종료 시 CER을 계산한다.
 */
export function mountDatasetPanel({ engine, registry, setStatus, appendLine }: DatasetPanelDeps): DatasetPanelApi {
  const $ = <T extends HTMLElement>(id: string): T => {
    const node = document.getElementById(id);
    if (!node) throw new Error(`#${id} 엘리먼트가 없습니다`);
    return node as T;
  };
  const el = {
    panel: $<HTMLElement>('dataset-panel'),
    open: $<HTMLButtonElement>('ds-open'),
    reopen: $<HTMLButtonElement>('ds-reopen'),
    dirInput: $<HTMLInputElement>('ds-dir-input'),
    info: $<HTMLParagraphElement>('ds-info'),
    sessionField: $<HTMLLabelElement>('ds-session-field'),
    session: $<HTMLSelectElement>('ds-session'),
    meta: $<HTMLParagraphElement>('ds-meta'),
    nav: $<HTMLDivElement>('ds-nav'),
    prev: $<HTMLButtonElement>('ds-prev'),
    next: $<HTMLButtonElement>('ds-next'),
    list: $<HTMLUListElement>('ds-utterances'),
    reference: $<HTMLDivElement>('reference'),
    refSpeaker: $<HTMLSpanElement>('ref-speaker'),
    refText: $<HTMLParagraphElement>('ref-text'),
  };

  let adapter: DatasetAdapter | null = null;
  let session: DatasetSession | null = null;
  let activeIdx = -1;

  // 데이터셋 발화는 파일 모드 전용 입력 — 파일 계열 모드에서만 패널/REF를 노출한다.
  const isFileMode = (): boolean => engine.mode === Mode.FILE || engine.mode === Mode.FILE_LOOPBACK;

  function updateVisibility(): void {
    const visible = isFileMode();
    el.panel.hidden = !visible;
    // 파일 모드 복귀 시 선택 중이던 발화의 REF도 복원
    const utt = session?.utterances[activeIdx];
    el.reference.hidden = !visible || !utt;
    if (visible && utt) showReference(utt);
  }

  // CER: 인식 시작~중지 사이의 final을 모아 참조 문장과 비교.
  // WebSpeech는 final이 RECOGNITION_STOPPED 뒤에 늦게 도착하기도 하므로
  // 중지 후 유예 시간 동안 늦은 final까지 수집한 뒤 리포트한다.
  const GRACE_MS = 1500;
  let collecting = false;
  let finals: string[] = [];
  let refUtt: Utterance | null = null; // 인식 시작 시점의 발화 스냅샷(유예 중 발화를 바꿔도 참조 유지)
  let graceTimer: ReturnType<typeof setTimeout> | 0 = 0;

  function finishRun(): void {
    clearTimeout(graceTimer);
    graceTimer = 0;
    if (!collecting) return;
    collecting = false;
    reportCer();
  }

  engine.bus.system((m) => {
    if (m.type === SystemEvent.RECOGNITION_STARTED) {
      finishRun(); // 유예 대기 중이던 직전 실행분 먼저 정산
      finals = [];
      refUtt = session?.utterances[activeIdx] ?? null;
      // 마이크 등 비파일 모드의 인식은 데이터셋 발화와 무관 → CER 수집 안 함
      collecting = Boolean(refUtt) && isFileMode();
    } else if (m.type === SystemEvent.RECOGNITION_STOPPED && collecting) {
      graceTimer = setTimeout(finishRun, GRACE_MS);
    } else if (m.type === SystemEvent.MODE_CHANGED || m.type === SystemEvent.PROVIDER_CHANGED) {
      updateVisibility();
    }
  });
  engine.bus.feature((m) => {
    if (m.type === FeatureEvent.TRANSCRIPT_FINAL && collecting) finals.push(m.payload.text);
  });

  function reportCer(): void {
    if (!refUtt || !finals.length) return;
    // WebSpeech 재시작 루프는 같은 내용을 누적 중복 final로 내보내기도 한다.
    // 개별 final과 전체 join을 모두 후보로 두고 가장 낮은 CER을 채택한다.
    const candidates = [...finals, finals.join(' ')];
    let best: CerResult | null = null;
    let bestHyp = '';
    for (const hyp of candidates) {
      const r = cer(refUtt.text, hyp);
      if (r && (!best || r.rate < best.rate)) {
        best = r;
        bestHyp = hyp;
      }
    }
    if (!best) return;
    appendLine(
      'CER',
      `${(best.rate * 100).toFixed(1)}% (편집거리 ${best.distance}/${best.refLength}) · 인식: ${bestHyp} · 참조: ${refUtt.text}`,
      best.rate <= 0.1 ? 'cer good' : best.rate <= 0.3 ? 'cer' : 'cer bad',
    );
  }

  // ── 폴더 인입 3경로 → 공통 useIndex ─────────────────────────────────
  async function useIndex(index: FileTreeIndex): Promise<void> {
    adapter = registry.detect(index);
    if (!adapter) {
      const known = registry.list().map((a) => a.label).join(', ');
      el.info.textContent = `이 폴더를 해석할 어댑터가 없습니다. 등록된 어댑터: ${known}`;
      setStatus('데이터셋 형식 인식 실패', 'error');
      return;
    }
    const sessions = await adapter.listSessions();
    el.info.textContent = `${adapter.label} — ${index.sourceName} · 세션 ${sessions.length}개 · 파일 ${index.size.toLocaleString()}개`;
    el.session.innerHTML = '';
    for (const s of sessions) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.label;
      el.session.appendChild(opt);
    }
    el.sessionField.hidden = sessions.length === 0;
    setStatus(`데이터셋 로드됨: ${adapter.label}`, 'ok');
    if (sessions.length) await selectSession(sessions[0].id);
  }

  async function openViaPicker(): Promise<void> {
    if (!window.showDirectoryPicker) {
      el.dirInput.click(); // 폴백: webkitdirectory
      return;
    }
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await window.showDirectoryPicker({ mode: 'read' });
    } catch {
      return; // 사용자 취소
    }
    await saveHandle(HANDLE_KEY, handle).catch(() => {});
    await scanHandle(handle);
  }

  async function scanHandle(handle: FileSystemDirectoryHandle): Promise<void> {
    setStatus('폴더 스캔 중…', 'warn');
    try {
      await useIndex(await FileTreeIndex.fromDirectoryHandle(handle));
      el.reopen.hidden = true;
    } catch (err) {
      setStatus(`폴더 스캔 실패: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  async function reopenRecent(): Promise<void> {
    const handle = await loadHandle(HANDLE_KEY).catch(() => undefined);
    if (!handle) return;
    if (!(await ensurePermission(handle))) {
      setStatus('폴더 접근 권한이 거부되었습니다', 'warn');
      return;
    }
    await scanHandle(handle);
  }

  // ── 세션/발화 렌더 ───────────────────────────────────────────────────
  async function selectSession(id: string): Promise<void> {
    if (!adapter) return;
    setStatus(`세션 로딩 중… (${id})`, 'warn');
    try {
      session = await adapter.loadSession(id);
    } catch (err) {
      setStatus(`세션 로드 실패: ${err instanceof Error ? err.message : String(err)}`, 'error');
      return;
    }
    el.session.value = id;
    el.meta.textContent = [session.meta.title, ...session.meta.lines].filter(Boolean).join(' · ');
    el.meta.hidden = false;
    el.nav.hidden = false;
    activeIdx = -1;
    hideReference();
    renderUtterances();
    setStatus(`세션 ${id} · 발화 ${session.utterances.length}개`, 'ok');
  }

  function renderUtterances(): void {
    el.list.innerHTML = '';
    if (!session) return;
    session.utterances.forEach((u, i) => {
      const li = document.createElement('li');
      li.className = 'utt-item';
      li.dataset.role = u.speaker.role;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'utt-pick';
      btn.title = u.textRaw;
      const head = document.createElement('span');
      head.className = 'utt-head';
      head.textContent = `#${String(u.order).padStart(3, '0')} ${u.speaker.role}`;
      const txt = document.createElement('span');
      txt.className = 'utt-text';
      txt.textContent = u.text;
      btn.append(head, txt);
      btn.addEventListener('click', () => void selectUtterance(i));
      li.appendChild(btn);
      el.list.appendChild(li);
    });
  }

  async function selectUtterance(i: number): Promise<void> {
    if (engine.isActive) {
      setStatus('인식 중에는 발화를 바꿀 수 없습니다 — 먼저 중지하세요', 'warn');
      return;
    }
    const utt = session?.utterances[i];
    if (!utt || !session) return;
    finishRun(); // 유예 대기 중이던 CER 먼저 정산(참조 스냅샷 기준)
    let file: File;
    try {
      file = await utt.file();
    } catch (err) {
      setStatus(`오디오 로드 실패: ${err instanceof Error ? err.message : String(err)}`, 'error');
      return;
    }
    activeIdx = i;
    engine.loadFile(file);
    if (engine.mode === Mode.MIC && (engine.provider?.capabilities || []).includes(Mode.FILE)) {
      try {
        engine.setMode(Mode.FILE);
      } catch {
        /* noop */
      }
    }
    for (const [j, li] of [...el.list.children].entries()) li.classList.toggle('active', j === i);
    el.list.children[i]?.scrollIntoView({ block: 'nearest' });
    showReference(utt);
  }

  function showReference(utt: Utterance): void {
    if (!session) return;
    el.refSpeaker.textContent = `${session.id} · #${String(utt.order).padStart(3, '0')} ${utt.speaker.role}${utt.speaker.detail ? ` (${utt.speaker.detail})` : ''}`;
    el.refText.textContent = utt.text;
    el.reference.hidden = false;
  }

  function hideReference(): void {
    el.reference.hidden = true;
  }

  // ── 이벤트 바인딩 ─────────────────────────────────────────────────────
  el.open.addEventListener('click', () => void openViaPicker());
  el.reopen.addEventListener('click', () => void reopenRecent());
  el.dirInput.addEventListener('change', () => {
    void (async () => {
      if (el.dirInput.files?.length) await useIndex(FileTreeIndex.fromFileList(el.dirInput.files));
      el.dirInput.value = '';
    })();
  });
  el.session.addEventListener('change', () => void selectSession(el.session.value));
  el.prev.addEventListener('click', () => void selectUtterance(Math.max(0, activeIdx - 1)));
  el.next.addEventListener('click', () =>
    void selectUtterance(activeIdx < 0 ? 0 : Math.min((session?.utterances.length ?? 1) - 1, activeIdx + 1)),
  );

  updateVisibility(); // 초기 모드 반영 (마이크 모드면 숨김)

  // 재방문: 저장된 핸들이 있으면 "최근 데이터셋" 버튼 노출
  loadHandle(HANDLE_KEY)
    .then((h) => {
      if (h) {
        el.reopen.hidden = false;
        el.reopen.textContent = `↻ 최근 데이터셋 (${h.name})`;
      }
    })
    .catch(() => {});

  return {
    openFromEntries: (entries, name) => useIndex(FileTreeIndex.fromEntries(entries, name)),
  };
}
