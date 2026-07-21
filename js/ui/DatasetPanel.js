import { FileTreeIndex } from '../datasets/FileTreeIndex.js';
import { saveHandle, loadHandle, ensurePermission } from '../datasets/handleStore.js';
import { SystemEvent, FeatureEvent, Mode } from '../core/events.js';
import { cer } from '../core/cer.js';

const HANDLE_KEY = 'last-dataset';

/**
 * DATASET 패널 UI.
 *
 * 폴더 인입(FS Access API / webkitdirectory / entries 주입) → 레지스트리에서 어댑터
 * 자동 감지 → 정규화된 세션·발화 모델 렌더. 발화를 고르면 기존 파일 파이프라인
 * (engine.loadFile)을 그대로 타고, 참조 문장을 표시하며 인식 종료 시 CER을 계산한다.
 *
 * @param {object} deps
 * @param {import('../core/SttEngine.js').SttEngine} deps.engine
 * @param {import('../datasets/DatasetRegistry.js').DatasetRegistry} deps.registry
 * @param {(text:string, kind?:string)=>void} deps.setStatus
 * @param {(tag:string, text:string, className?:string)=>void} deps.appendLine 자막 콘솔에 라인 추가
 * @returns {{ openFromEntries(entries:Array<{path:string,file:File}>, name?:string): Promise<void> }}
 */
export function mountDatasetPanel({ engine, registry, setStatus, appendLine }) {
  const $ = (id) => document.getElementById(id);
  const el = {
    open: $('ds-open'),
    reopen: $('ds-reopen'),
    dirInput: $('ds-dir-input'),
    info: $('ds-info'),
    sessionField: $('ds-session-field'),
    session: $('ds-session'),
    meta: $('ds-meta'),
    nav: $('ds-nav'),
    prev: $('ds-prev'),
    next: $('ds-next'),
    list: $('ds-utterances'),
    reference: $('reference'),
    refSpeaker: $('ref-speaker'),
    refText: $('ref-text'),
  };

  /** @type {import('../datasets/DatasetAdapter.js').DatasetAdapter|null} */
  let adapter = null;
  let session = null;
  let activeIdx = -1;

  // CER: 인식 시작~중지 사이의 final을 모아 참조 문장과 비교.
  // WebSpeech는 final이 RECOGNITION_STOPPED 뒤에 늦게 도착하기도 하므로
  // 중지 후 유예 시간 동안 늦은 final까지 수집한 뒤 리포트한다.
  const GRACE_MS = 1500;
  let collecting = false;
  let finals = [];
  let refUtt = null; // 인식 시작 시점의 발화 스냅샷(유예 중 발화를 바꿔도 참조 유지)
  let graceTimer = 0;

  function finishRun() {
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
      collecting = Boolean(refUtt);
    } else if (m.type === SystemEvent.RECOGNITION_STOPPED && collecting) {
      graceTimer = setTimeout(finishRun, GRACE_MS);
    }
  });
  engine.bus.feature((m) => {
    if (m.type === FeatureEvent.TRANSCRIPT_FINAL && collecting) finals.push(m.payload.text);
  });

  function reportCer() {
    if (!refUtt || !finals.length) return;
    // WebSpeech 재시작 루프는 같은 내용을 누적 중복 final로 내보내기도 한다.
    // 개별 final과 전체 join을 모두 후보로 두고 가장 낮은 CER을 채택한다.
    const candidates = [...finals, finals.join(' ')];
    let best = null;
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
  async function useIndex(index) {
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

  async function openViaPicker() {
    if (!window.showDirectoryPicker) {
      el.dirInput.click(); // 폴백: webkitdirectory
      return;
    }
    let handle;
    try {
      handle = await window.showDirectoryPicker({ mode: 'read' });
    } catch {
      return; // 사용자 취소
    }
    await saveHandle(HANDLE_KEY, handle).catch(() => {});
    await scanHandle(handle);
  }

  async function scanHandle(handle) {
    setStatus('폴더 스캔 중…', 'warn');
    try {
      await useIndex(await FileTreeIndex.fromDirectoryHandle(handle));
      el.reopen.hidden = true;
    } catch (err) {
      setStatus(`폴더 스캔 실패: ${err.message}`, 'error');
    }
  }

  async function reopenRecent() {
    const handle = await loadHandle(HANDLE_KEY).catch(() => null);
    if (!handle) return;
    if (!(await ensurePermission(handle))) {
      setStatus('폴더 접근 권한이 거부되었습니다', 'warn');
      return;
    }
    await scanHandle(handle);
  }

  // ── 세션/발화 렌더 ───────────────────────────────────────────────────
  async function selectSession(id) {
    setStatus(`세션 로딩 중… (${id})`, 'warn');
    try {
      session = await adapter.loadSession(id);
    } catch (err) {
      setStatus(`세션 로드 실패: ${err.message}`, 'error');
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

  function renderUtterances() {
    el.list.innerHTML = '';
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
      btn.addEventListener('click', () => selectUtterance(i));
      li.appendChild(btn);
      el.list.appendChild(li);
    });
  }

  async function selectUtterance(i) {
    if (engine.isActive) {
      setStatus('인식 중에는 발화를 바꿀 수 없습니다 — 먼저 중지하세요', 'warn');
      return;
    }
    const utt = session?.utterances[i];
    if (!utt) return;
    finishRun(); // 유예 대기 중이던 CER 먼저 정산(참조 스냅샷 기준)
    let file;
    try {
      file = await utt.file();
    } catch (err) {
      setStatus(`오디오 로드 실패: ${err.message}`, 'error');
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

  function showReference(utt) {
    el.refSpeaker.textContent = `${session.id} · #${String(utt.order).padStart(3, '0')} ${utt.speaker.role}${utt.speaker.detail ? ` (${utt.speaker.detail})` : ''}`;
    el.refText.textContent = utt.text;
    el.reference.hidden = false;
  }

  function hideReference() {
    el.reference.hidden = true;
  }

  // ── 이벤트 바인딩 ─────────────────────────────────────────────────────
  el.open.addEventListener('click', openViaPicker);
  el.reopen.addEventListener('click', reopenRecent);
  el.dirInput.addEventListener('change', async () => {
    if (el.dirInput.files?.length) await useIndex(FileTreeIndex.fromFileList(el.dirInput.files));
    el.dirInput.value = '';
  });
  el.session.addEventListener('change', () => selectSession(el.session.value));
  el.prev.addEventListener('click', () => selectUtterance(Math.max(0, activeIdx - 1)));
  el.next.addEventListener('click', () =>
    selectUtterance(activeIdx < 0 ? 0 : Math.min((session?.utterances.length ?? 1) - 1, activeIdx + 1)),
  );

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
    /** 테스트/외부 주입 시드: [{path, file}] 배열로 데이터셋을 연다. */
    openFromEntries: (entries, name) => useIndex(FileTreeIndex.fromEntries(entries, name)),
  };
}
