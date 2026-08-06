/**
 * 합성 루트(Composition Root) + UI 와이어링.
 *
 * 여기서만 구체 Provider를 알고, 레지스트리에 등록(주입)한 뒤 엔진을 만든다.
 * 그 외 모든 코드는 추상화(SttProvider/SttEngine/EventBus)에만 의존한다.
 * Provider 설정 폼은 각 Provider의 static configSchema를 보고 자동 렌더한다(하드코딩 없음).
 */
import { SttService } from '@rsupport/rvs-stt-kit';
import { SttEngine } from './core/SttEngine';
import { SystemEvent, FeatureEvent, Mode } from './core/events';
import type { ConfigField, ProviderConfig, RuntimeLocation } from './core/SttProvider';
import { createProviderRegistry } from './providers/registerAll';
import { ENGINE_PROFILES, getEngineProfile, resolveEngineProfile, supportsLanguage, type EngineProfile } from './profiles/engineProfiles';
import { BootstrapProfileResolver } from './composition/BootstrapProfileResolver';
import { createEngineBackedSttServiceRuntime } from './composition/SttServiceRuntime';
import { DatasetRegistry } from './datasets/DatasetRegistry';
import { AihubCallCenterAdapter } from './datasets/adapters/AihubCallCenterAdapter';
import { mountDatasetPanel } from './ui/DatasetPanel';
import { showToast } from './ui/toast';

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} 엘리먼트가 없습니다`);
  return node as T;
};
const cfgKey = (id: string) => `speech-test.cfg.${id}`;

// ── 1) 합성: Provider/Dataset 어댑터 등록 → 엔진 생성 ─────────────────
// Provider 등록 목록은 QA 하네스와 공유한다(src/providers/registerAll.ts)
const registry = createProviderRegistry();

// 독립 샘플(데이터셋)도 Provider와 같은 주입형 — 새 샘플은 어댑터 register 한 줄
const datasetRegistry = new DatasetRegistry().register(AihubCallCenterAdapter);

const engine = new SttEngine(registry);
const profileResolver = new BootstrapProfileResolver(() => ({
  profile: selectedProfile,
  mode: engine.mode,
  file: engine.file,
}));
const sttService = new SttService({
  runtime: createEngineBackedSttServiceRuntime({ engine, resolver: profileResolver }),
});

// id → 메타(configSchema 포함) 조회용
const META = new Map(registry.list().map((m) => [m.id, m]));
const LEGACY_PROFILE_BY_PROVIDER: Record<string, string> = {
  streaming: 'faster-whisper-live',
  funasr: 'funasr-streaming',
  sensevoice: 'sensevoice-snapshot',
};
let selectedProfile: EngineProfile | null = null;

// ── DOM ────────────────────────────────────────────────────────────────
const el = {
  providerSelect: $<HTMLSelectElement>('provider-select'),
  capabilityHint: $<HTMLParagraphElement>('capability-hint'),
  modeButtons: [...document.querySelectorAll<HTMLButtonElement>('[data-mode]')],
  locationButtons: [...document.querySelectorAll<HTMLButtonElement>('[data-location]')],
  locationHint: $<HTMLParagraphElement>('location-hint'),
  langSelect: $<HTMLSelectElement>('lang-select'),
  settings: $<HTMLFormElement>('provider-settings'),
  routing: $<HTMLDivElement>('routing'),
  sinkSelect: $<HTMLSelectElement>('sink-select'),
  sinkRefresh: $<HTMLButtonElement>('btn-sink-refresh'),
  uploadField: $<HTMLDivElement>('upload-field'),
  dropzone: $<HTMLDivElement>('dropzone'),
  fileInput: $<HTMLInputElement>('file-input'),
  fileList: $<HTMLUListElement>('file-list'),
  audio: $<HTMLAudioElement>('audio'),
  btnStart: $<HTMLButtonElement>('btn-start'),
  btnStop: $<HTMLButtonElement>('btn-stop'),
  btnClear: $<HTMLButtonElement>('btn-clear'),
  transcript: $<HTMLDivElement>('transcript'),
  interim: $<HTMLDivElement>('interim'),
  statusText: $<HTMLSpanElement>('status-text'),
  signal: $<HTMLSpanElement>('signal'),
  meter: $<HTMLDivElement>('level-meter'),
  secureBanner: $<HTMLDivElement>('secure-banner'),
};

// 레벨 미터 막대
const bars: HTMLSpanElement[] = [];
for (let i = 0; i < 28; i++) {
  const b = document.createElement('span');
  b.className = 'bar';
  el.meter.appendChild(b);
  bars.push(b);
}

// 파일 목록 상태
let fileSeq = 0;
let activeFileId: string | null = null;
const files = new Map<string, File>();

// ── 2) Provider 설정 영속화(localStorage) ─────────────────────────────
function defaultsFor(schema: readonly ConfigField[] = []): ProviderConfig {
  const d: ProviderConfig = {};
  for (const f of schema) if (f.default !== undefined) d[f.key] = f.default;
  return d;
}
function loadCfg(id: string, schema: readonly ConfigField[] = META.get(id)?.configSchema || []): ProviderConfig {
  let saved: ProviderConfig = {};
  try {
    saved = JSON.parse(localStorage.getItem(cfgKey(id)) || '{}');
  } catch {
    saved = {};
  }
  return { ...defaultsFor(schema), ...saved };
}
function loadProfileCfg(profile: EngineProfile): ProviderConfig {
  const schema = META.get(profile.providerId)?.configSchema || [];
  const saved = loadCfg(profile.id, schema);
  // Provider 단위로 저장됐던 기존 설정을 잃지 않되 profile 고유 값이 우선한다.
  const legacy = LEGACY_PROFILE_BY_PROVIDER[profile.providerId] === profile.id
    ? loadCfg(profile.providerId, schema)
    : {};
  return { ...legacy, ...saved };
}
function saveCfg(id: string, obj: ProviderConfig): void {
  localStorage.setItem(cfgKey(id), JSON.stringify(obj));
}

function isServiceManagedProfile(): boolean {
  return profileResolver.isServiceProfile();
}

// ── 3) 시스템 이벤트 → 상태 UI ────────────────────────────────────────
engine.bus.system((m) => {
  switch (m.type) {
    case SystemEvent.ENGINE_READY:
      populateProfiles();
      break;
    case SystemEvent.PROVIDER_CHANGED:
      reflectProvider(m.payload);
      break;
    case SystemEvent.MODE_CHANGED:
      setActiveMode(m.payload.mode);
      break;
    case SystemEvent.MODEL_LOADING: {
      // 모델 로딩 중에는 인식이 불가능 → 문제될 컨트롤 비활성화 + 토스트 안내
      setBusy(true);
      const what = m.payload.model ?? m.payload.message ?? '';
      setStatus(`모델 로딩 중… ${what ? `(${what})` : ''}`, 'warn');
      showToast(`모델 로딩 중${what ? ` — ${what}` : ''}\n완료 전까지 인식을 시작할 수 없습니다`, {
        kind: 'warn',
        duration: 5000,
      });
      break;
    }
    case SystemEvent.MODEL_READY:
      setBusy(false);
      setStatus(`모델 준비 완료 (${m.payload.model ?? ''})`, 'ok');
      showToast('모델 준비 완료 — 인식을 진행합니다', { kind: 'ok' });
      break;
    case SystemEvent.RECOGNITION_STARTED:
      if (isServiceManagedProfile()) break;
      lastErrorAt = 0;
      setRunning(true);
      setStatus(`인식 시작 · ${m.payload.provider} / ${modeLabel(m.payload.mode)}`, 'ok');
      break;
    case SystemEvent.RECOGNITION_STOPPED:
      if (isServiceManagedProfile()) break;
      setRunning(false);
      setBusy(false); // 로딩 중 중지(탈출구)로 끝난 경우도 컨트롤 복구
      // 에러 직후의 중지는 정상 종료가 아니다 — 방금 띄운 에러를 '대기 중'으로 덮지 않는다
      if (performance.now() - lastErrorAt > 3000) setStatus('대기 중', 'idle');
      break;
    case SystemEvent.RECOGNITION_ERROR:
      if (isServiceManagedProfile()) break;
      lastErrorAt = performance.now();
      // 토스트는 busy(모델 로딩) 때만이 아니라 **항상** 띄운다 — status는 다음 이벤트에
      // 덮일 수 있고, 시작 실패는 대부분 사용자가 다음 행동을 골라야 하는 상황이다
      showToast(`${busy ? '모델 로딩 실패' : '인식 실패'}: ${m.payload.message}`, {
        kind: 'error',
        duration: 9000,
      });
      setBusy(false);
      setStatus(`에러: ${m.payload.message}`, 'error');
      break;
    case SystemEvent.AUDIO_LOADED:
      setStatus(`로드됨: ${m.payload.name}`, 'idle');
      break;
    case SystemEvent.AUDIO_LEVEL:
      renderLevel(m.payload.level);
      break;
    case SystemEvent.STATUS:
      setStatus(m.payload.message, m.payload.level === 'warn' ? 'warn' : 'idle');
      break;
    default:
      break;
  }
});

// ── 4) 기능 이벤트 → 자막 콘솔 ────────────────────────────────────────
engine.bus.feature((m) => {
  if (isServiceManagedProfile()) return;
  if (m.type === FeatureEvent.TRANSCRIPT_PARTIAL) {
    setInterim(m.payload.text);
  } else if (m.type === FeatureEvent.TRANSCRIPT_FINAL) {
    appendFinal(m.payload.text, m.payload);
    setInterim('');
  } else if (m.type === FeatureEvent.TRANSCRIPT_RESET) {
    el.transcript.innerHTML = '';
    setInterim('');
  }
});

sttService.subscribe((event) => {
  switch (event.type) {
    case 'state':
      if (event.state === 'starting') {
        setBusy(true);
        setStatus(`인식 준비 중 · ${selectedProfile?.label ?? 'Streaming ASR'}`, 'ok');
      } else if (event.state === 'listening') {
        lastErrorAt = 0;
        setBusy(false);
        setRunning(true);
        setStatus(`인식 시작 · ${selectedProfile?.providerId ?? engine.provider?.id ?? 'streaming'} / ${modeLabel(engine.mode)}`, 'ok');
      } else if (event.state === 'stopping') {
        setBusy(true);
      } else {
        setRunning(false);
        setBusy(false);
        if (performance.now() - lastErrorAt > 3000) setStatus('대기 중', 'idle');
      }
      break;
    case 'transcript':
      if (event.phase === 'partial') {
        setInterim(event.text);
      } else {
        appendFinal(event.text, {
          provider: selectedProfile?.providerId ?? engine.provider?.id,
          mode: engine.mode,
        });
        setInterim('');
      }
      break;
    case 'error':
      lastErrorAt = performance.now();
      showToast(`인식 실패: ${event.error.message}`, {
        kind: 'error',
        duration: 9000,
      });
      setBusy(false);
      setStatus(`에러: ${event.error.message}`, 'error');
      break;
    default:
      break;
  }
});

// ── 렌더 헬퍼 ────────────────────────────────────────────────────────
function populateProfiles(): void {
  const selected = selectedProfile?.id || el.providerSelect.value;
  el.providerSelect.innerHTML = '';
  for (const profile of ENGINE_PROFILES) {
    const transport = META.get(profile.providerId);
    const languageSupported = supportsLanguage(profile, el.langSelect.value);
    const opt = document.createElement('option');
    opt.value = profile.id;
    opt.textContent = `${profile.label} — ${profile.description}`;
    opt.disabled = !transport?.supported || !languageSupported;
    el.providerSelect.appendChild(opt);
  }
  if (selected && [...el.providerSelect.options].some((opt) => opt.value === selected && !opt.disabled)) {
    el.providerSelect.value = selected;
  }
}

async function useProfile(id: string): Promise<void> {
  if (sttService.state !== 'idle') await sttService.stop();
  const resolution = resolveEngineProfile(id, loadProfileCfg(getEngineProfile(id)));
  selectedProfile = resolution.profile;
  await engine.useProvider(resolution.providerId, resolution.config);
  if (!resolution.profile.modes.includes(engine.mode)) {
    engine.setMode(resolution.profile.modes[0]!);
  }
}

interface ProviderChangedPayload {
  provider: string;
  label: string;
  capabilities: readonly Mode[];
  configSchema: readonly ConfigField[];
  fileInputKind: string;
  locations: readonly RuntimeLocation[];
  location: RuntimeLocation;
  mode: Mode;
}

function reflectProvider({ provider, label, capabilities, configSchema, fileInputKind, locations, location, mode }: ProviderChangedPayload): void {
  const profile = selectedProfile;
  el.providerSelect.value = profile?.id ?? provider;
  applyControls();
  setActiveMode(mode);
  const partial = profile ? ` · partial: ${profile.partialStrategy}` : '';
  const profileCapabilities = profile ? capabilities.filter((mode) => profile.modes.includes(mode)) : capabilities;
  el.capabilityHint.textContent = `${profile?.conversation ? '실시간 대화 후보' : '파일/정확도 우선'}${partial} · 지원 모드: ${profileCapabilities.map((c) => modeLabel(c)).join(' · ')}`;
  renderLocations(locations, location);
  // 엔진 endpoint는 profile contract가 고정한다. transport의 범용 selector를 다시 노출하지 않는다.
  renderSettings(profile?.id ?? provider, profile?.label ?? label, configSchema.filter((field) => field.key !== 'wsEndpoint'));
  // WebSpeech처럼 파일을 음향 루프백으로만 받는 Provider는 디지털 라우팅 UI 노출
  el.routing.hidden = fileInputKind !== 'loopback';
  if (!el.routing.hidden) void populateSinks();
}

const LOCATION_LABEL: Record<RuntimeLocation, string> = {
  'local-client': '로컬(클라이언트) · 자체 CPU/GPU 처리',
  'remote-onpremise': '온프레미스 (사내 서버)',
  'remote-cloud': '클라우드',
};

/** Provider가 지원하는 실행 위치만 활성화하고 현재 선택을 반영한다. */
function renderLocations(locations: readonly RuntimeLocation[], active: RuntimeLocation): void {
  for (const btn of el.locationButtons) {
    const loc = btn.dataset.location as RuntimeLocation;
    const supported = locations.includes(loc);
    btn.disabled = !supported;
    btn.classList.toggle('unavailable', !supported);
    btn.classList.toggle('active', supported && loc === active);
    btn.title = supported ? LOCATION_LABEL[loc] : `${LOCATION_LABEL[loc]} — 이 Provider는 지원하지 않음`;
  }
  el.locationHint.textContent = `현재: ${LOCATION_LABEL[active]}`;
}

/** 출력 장치 목록을 채운다(가상장치 선택용). */
async function populateSinks(): Promise<void> {
  let devices: MediaDeviceInfo[] = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    /* noop */
  }
  const outs = devices.filter((d) => d.kind === 'audiooutput');
  const prev = el.sinkSelect.value;
  el.sinkSelect.innerHTML = '';
  for (const d of outs) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `장치 ${d.deviceId.slice(0, 8)}…`;
    el.sinkSelect.appendChild(opt);
  }
  if (prev) el.sinkSelect.value = prev;
}

function makeFieldHint(text: string): HTMLSpanElement {
  const hint = document.createElement('span');
  hint.className = 'field-hint';
  hint.textContent = text;
  return hint;
}

function renderSettings(providerId: string, label: string, schema: readonly ConfigField[] = []): void {
  el.settings.innerHTML = '';
  if (!schema.length) {
    el.settings.hidden = true;
    return;
  }
  el.settings.hidden = false;
  const cfg = loadCfg(providerId);

  const legend = document.createElement('div');
  legend.className = 'settings-legend';
  legend.textContent = `${label} 설정`;
  el.settings.appendChild(legend);

  // location 등 폼 밖에서 관리되는 키를 지우지 않도록 저장분과 병합해 수집한다
  const collect = (): ProviderConfig => {
    const values: ProviderConfig = { ...loadCfg(providerId) };
    for (const f of schema) {
      const node = $<HTMLInputElement | HTMLSelectElement>(`cfg-${f.key}`);
      values[f.key] = f.type === 'checkbox' ? (node as HTMLInputElement).checked : node.value.trim();
    }
    return values;
  };

  for (const f of schema) {
    if (f.type === 'select') {
      const wrap = document.createElement('label');
      wrap.className = 'field mini';
      const name = document.createElement('span');
      name.className = 'field-label';
      name.textContent = f.label;
      const select = document.createElement('select');
      select.className = 'select';
      select.id = `cfg-${f.key}`;
      for (const o of f.options ?? []) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        select.appendChild(opt);
      }
      select.value = String(cfg[f.key] ?? f.default ?? '');
      // 선택 즉시 적용(체크박스와 동일 UX) — 실제 모델 로드는 다음 인식 시작 시점
      select.addEventListener('change', () => {
        const values = collect();
        saveCfg(providerId, values);
        engine.configureProvider(values);
        setStatus(`${f.label} → ${select.selectedOptions[0]?.textContent ?? select.value}`, 'ok');
      });
      wrap.append(name, select);
      if (f.hint) wrap.appendChild(makeFieldHint(f.hint));
      el.settings.appendChild(wrap);
      continue;
    }
    if (f.type === 'checkbox') {
      const row = document.createElement('label');
      row.className = 'check-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = `cfg-${f.key}`;
      cb.checked = Boolean(cfg[f.key]);
      const span = document.createElement('span');
      span.textContent = f.label;
      // 토글 즉시 적용(저장 버튼 없이)
      cb.addEventListener('change', () => {
        const values = collect();
        saveCfg(providerId, values);
        engine.configureProvider(values);
        setStatus(`${f.label} ${cb.checked ? 'ON' : 'OFF'}`, cb.checked ? 'ok' : 'idle');
      });
      row.append(cb, span);
      el.settings.appendChild(row);
      continue;
    }
    const wrap = document.createElement('label');
    wrap.className = 'field mini';
    const name = document.createElement('span');
    name.className = 'field-label';
    name.textContent = f.label;
    const input = document.createElement('input');
    input.className = 'input';
    input.id = `cfg-${f.key}`;
    input.type = f.type || 'text';
    input.placeholder = f.placeholder || '';
    input.value = String(cfg[f.key] ?? '');
    if (f.type === 'password') input.autocomplete = 'new-password';
    wrap.append(name, input);
    if (f.hint) wrap.appendChild(makeFieldHint(f.hint));
    el.settings.appendChild(wrap);
  }

  // 텍스트 필드가 있을 때만 저장 버튼(체크박스/셀렉트는 즉시 적용)
  if (schema.some((f) => f.type !== 'checkbox' && f.type !== 'select')) {
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn ghost';
    save.textContent = '설정 저장';
    save.addEventListener('click', () => {
      const values = collect();
      saveCfg(providerId, values);
      engine.configureProvider(values);
      setStatus(`${label} 설정 저장됨`, 'ok');
    });
    el.settings.appendChild(save);
  }

  const note = document.createElement('p');
  note.className = 'micro';
  note.textContent = '설정은 이 브라우저 localStorage에만 저장됩니다.';
  el.settings.appendChild(note);
}

function modeLabel(mode: Mode | string): string {
  return { [Mode.MIC]: '마이크', [Mode.FILE]: '파일', [Mode.FILE_LOOPBACK]: '파일(루프백)' }[mode] || mode;
}

function setActiveMode(mode: Mode): void {
  for (const btn of el.modeButtons) btn.classList.toggle('active', btn.dataset.mode === mode);
  // 오디오 업로드(드롭존·파일 목록)는 파일 계열 모드 전용 — 마이크 모드에선 숨긴다
  const fileish = mode === Mode.FILE || mode === Mode.FILE_LOOPBACK;
  el.uploadField.hidden = !fileish;
  el.fileList.hidden = !fileish;
}

// 컨트롤 잠금 상태: running(인식 중) + busy(모델 로딩 등 준비 중)
let running = false;
let busy = false;
/**
 * 마지막 인식 에러 시각(ms) — 에러 직후 도착하는 중지 이벤트가 에러 메시지를 덮지 않게 쓴다.
 * 실측: WebSpeech 시작 실패에서 118ms에 뜬 에러가 119ms에 '대기 중'으로 덮여, 사용자에게는
 * 아무 안내 없이 "그냥 안 됨"으로 보였다.
 */
let lastErrorAt = 0;

/** running/busy/Provider capabilities를 종합해 컨트롤 활성 상태를 일괄 반영한다. */
function applyControls(): void {
  el.btnStart.disabled = running || busy;
  el.btnStop.disabled = !(running || busy); // busy 중에도 중지는 탈출구로 열어둔다
  el.dropzone.classList.toggle('locked', running || busy);
  el.providerSelect.disabled = busy;
  el.langSelect.disabled = busy;
  for (const btn of el.modeButtons) {
    const supported = (engine.provider?.capabilities ?? []).includes(btn.dataset.mode as Mode) &&
      (selectedProfile?.modes ?? []).includes(btn.dataset.mode as Mode);
    btn.disabled = busy || !supported;
    btn.classList.toggle('unavailable', !supported);
  }
  for (const btn of el.locationButtons) {
    const supported = (engine.provider?.locations ?? []).includes(btn.dataset.location as RuntimeLocation) &&
      (selectedProfile?.locations ?? []).includes(btn.dataset.location as RuntimeLocation);
    btn.disabled = busy || !supported;
    btn.classList.toggle('unavailable', !supported);
  }
}

function setRunning(next: boolean): void {
  running = next;
  el.signal.classList.toggle('live', next);
  applyControls();
}

function setBusy(next: boolean): void {
  if (busy === next) return;
  busy = next;
  applyControls();
}

function setStatus(text: string, kind = 'idle'): void {
  el.statusText.textContent = text;
  el.statusText.dataset.kind = kind;
}

function setInterim(text: string): void {
  el.interim.textContent = text;
  el.interim.classList.toggle('show', Boolean(text));
}

function appendLine(tagText: string, text: string, className = ''): void {
  if (!text) return;
  const line = document.createElement('div');
  line.className = className ? `line ${className}` : 'line';
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = tagText;
  const span = document.createElement('span');
  span.className = 'txt';
  span.textContent = text;
  line.append(tag, span);
  el.transcript.appendChild(line);
  el.transcript.scrollTop = el.transcript.scrollHeight;
}

function appendFinal(text: string, meta: { provider?: string; mode?: Mode }): void {
  appendLine(`${meta.provider}·${modeLabel(meta.mode ?? '')}`, text);
}

function renderLevel(level: number): void {
  const n = bars.length;
  for (let i = 0; i < n; i++) {
    const dist = Math.abs(i - (n - 1) / 2) / (n / 2);
    const h = Math.max(0.06, level * (1 - dist * 0.7) * (0.6 + Math.random() * 0.4));
    bars[i].style.transform = `scaleY(${h.toFixed(3)})`;
  }
}

// ── 파일 업로드 / 목록 ───────────────────────────────────────────────
function addFiles(fileListLike: Iterable<File>): void {
  for (const f of fileListLike) {
    if (!f.type.startsWith('audio/')) continue;
    const id = `f${++fileSeq}`;
    files.set(id, f);
    renderFileItem(id, f);
  }
}

function renderFileItem(id: string, file: File): void {
  const item = document.createElement('li');
  item.className = 'file-item';
  item.dataset.id = id;
  item.innerHTML = `
    <button class="file-pick" type="button">
      <span class="file-name"></span>
      <span class="file-meta"></span>
    </button>
    <button class="file-del" type="button" title="삭제">✕</button>`;
  item.querySelector<HTMLSpanElement>('.file-name')!.textContent = file.name;
  item.querySelector<HTMLSpanElement>('.file-meta')!.textContent =
    `${(file.size / 1024).toFixed(0)} KB · ${file.type || 'audio'}`;
  item.querySelector<HTMLButtonElement>('.file-pick')!.addEventListener('click', () => selectFile(id));
  item.querySelector<HTMLButtonElement>('.file-del')!.addEventListener('click', () => removeFile(id));
  el.fileList.appendChild(item);
  if (!activeFileId) selectFile(id);
}

function selectFile(id: string): void {
  const file = files.get(id);
  if (!file) return;
  activeFileId = id;
  engine.loadFile(file);
  for (const li of el.fileList.children) {
    (li as HTMLElement).classList.toggle('active', (li as HTMLElement).dataset.id === id);
  }
  // 파일을 고르면 파일 모드로 자동 전환(모든 Provider가 file 지원)
  if (engine.mode === Mode.MIC && (engine.provider?.capabilities || []).includes(Mode.FILE)) {
    safeSetMode(Mode.FILE);
  }
}

function removeFile(id: string): void {
  files.delete(id);
  [...el.fileList.children].find((c) => (c as HTMLElement).dataset.id === id)?.remove();
  if (activeFileId === id) {
    activeFileId = null;
    const first = el.fileList.firstElementChild as HTMLElement | null;
    if (first?.dataset.id) selectFile(first.dataset.id);
  }
}

function safeSetMode(mode: Mode): void {
  try {
    if (selectedProfile && !selectedProfile.modes.includes(mode)) {
      throw new Error(`[${selectedProfile.label}]은 ${modeLabel(mode)} 모드를 지원하지 않습니다`);
    }
    engine.setMode(mode);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), 'warn');
  }
}

// ── 이벤트 바인딩 ─────────────────────────────────────────────────────
el.providerSelect.addEventListener('change', async () => {
  try {
    await useProfile(el.providerSelect.value);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), 'error');
  }
});

for (const btn of el.modeButtons) {
  btn.addEventListener('click', () => safeSetMode(btn.dataset.mode as Mode));
}

// 실행 위치 선택 — Provider별로 저장하고 즉시 적용 (미지원 버튼은 disabled라 진입 불가)
for (const btn of el.locationButtons) {
  btn.addEventListener('click', () => {
    const location = btn.dataset.location as RuntimeLocation;
    const profileId = selectedProfile?.id ?? el.providerSelect.value;
    const cfg = { ...loadCfg(profileId), location };
    saveCfg(profileId, cfg);
    engine.configureProvider({ location });
    renderLocations(engine.provider?.locations ?? [], location);
    setStatus(`실행 위치 → ${LOCATION_LABEL[location]}`, 'ok');
  });
}

el.langSelect.addEventListener('change', async () => {
  engine.setLang(el.langSelect.value);
  populateProfiles();
  if (selectedProfile && !supportsLanguage(selectedProfile, el.langSelect.value)) {
    const next = ENGINE_PROFILES.find((profile) =>
      supportsLanguage(profile, el.langSelect.value) && META.get(profile.providerId)?.supported,
    );
    if (next) await useProfile(next.id);
  }
});

el.sinkRefresh.addEventListener('click', () => void populateSinks());
el.sinkSelect.addEventListener('change', async () => {
  try {
    await engine.setOutputSink(el.sinkSelect.value);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), 'error');
  }
});
el.fileInput.addEventListener('change', () => addFiles(el.fileInput.files ?? []));

for (const ev of ['dragenter', 'dragover'] as const) {
  el.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    el.dropzone.classList.add('drag');
  });
}
for (const ev of ['dragleave', 'drop'] as const) {
  el.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    el.dropzone.classList.remove('drag');
  });
}
el.dropzone.addEventListener('drop', (e) => addFiles(e.dataTransfer?.files ?? []));
el.dropzone.addEventListener('click', () => el.fileInput.click());

el.btnStart.addEventListener('click', async () => {
  try {
    if (isServiceManagedProfile()) {
      await sttService.start(profileResolver.resolve().input);
    } else {
      await engine.start();
    }
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), 'error');
  }
});
el.btnStop.addEventListener('click', () => {
  if (isServiceManagedProfile()) {
    void sttService.stop();
  } else {
    void engine.stop();
  }
});
el.btnClear.addEventListener('click', () => {
  el.transcript.innerHTML = '';
  setInterim('');
});

// ── 데이터셋 패널 마운트 ──────────────────────────────────────────────
const datasetPanel = mountDatasetPanel({ engine, registry: datasetRegistry, setStatus, appendLine });
// 디버그/테스트 시드(콘솔에서 entries 주입 가능)
window.__speechLab = { engine, datasetPanel };

// ── 부트스트랩 ───────────────────────────────────────────────────────
async function boot(): Promise<void> {
  if (!window.isSecureContext) el.secureBanner.hidden = false;
  engine.attachAudioElement(el.audio);
  engine.ready();

  const first = ENGINE_PROFILES.find((profile) =>
    META.get(profile.providerId)?.supported && supportsLanguage(profile, engine.lang),
  );
  if (first) {
    await useProfile(first.id);
  } else {
    setStatus('사용 가능한 Provider가 없습니다', 'error');
    return;
  }
  setStatus('대기 중 — 마이크는 시작을, 파일은 업로드 후 시작을 누르세요', 'idle');
}

void boot();
