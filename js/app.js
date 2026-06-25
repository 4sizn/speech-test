/**
 * 합성 루트(Composition Root) + UI 와이어링.
 *
 * 여기서만 구체 Provider를 알고, 레지스트리에 등록(주입)한 뒤 엔진을 만든다.
 * 그 외 모든 코드는 추상화(SttProvider/SttEngine/EventBus)에만 의존한다.
 * Provider 설정 폼은 각 Provider의 static configSchema를 보고 자동 렌더한다(하드코딩 없음).
 */
import { ProviderRegistry } from './core/ProviderRegistry.js';
import { SttEngine } from './core/SttEngine.js';
import { SystemEvent, FeatureEvent, Mode } from './core/events.js';
import { WebSpeechProvider } from './providers/WebSpeechProvider.js';
import { WhisperWasmProvider } from './providers/WhisperWasmProvider.js';
import { StreamingAsrProvider } from './providers/StreamingAsrProvider.js';
import { Qwen3Provider } from './providers/Qwen3Provider.js';

const $ = (id) => document.getElementById(id);
const cfgKey = (id) => `speech-test.cfg.${id}`;

// ── 1) 합성: Provider 등록 → 엔진 생성 ────────────────────────────────
const registry = new ProviderRegistry()
  .register(WebSpeechProvider)
  .register(WhisperWasmProvider)
  .register(StreamingAsrProvider)
  .register(Qwen3Provider);

const engine = new SttEngine(registry);

// id → 메타(configSchema 포함) 조회용
const META = new Map(registry.list().map((m) => [m.id, m]));

// ── DOM ────────────────────────────────────────────────────────────────
const el = {
  providerSelect: $('provider-select'),
  capabilityHint: $('capability-hint'),
  modeButtons: [...document.querySelectorAll('[data-mode]')],
  langSelect: $('lang-select'),
  settings: $('provider-settings'),
  routing: $('routing'),
  sinkSelect: $('sink-select'),
  sinkRefresh: $('btn-sink-refresh'),
  dropzone: $('dropzone'),
  fileInput: $('file-input'),
  fileList: $('file-list'),
  audio: $('audio'),
  btnStart: $('btn-start'),
  btnStop: $('btn-stop'),
  btnClear: $('btn-clear'),
  transcript: $('transcript'),
  interim: $('interim'),
  statusText: $('status-text'),
  signal: $('signal'),
  meter: $('level-meter'),
  secureBanner: $('secure-banner'),
};

// 레벨 미터 막대
const bars = [];
for (let i = 0; i < 28; i++) {
  const b = document.createElement('span');
  b.className = 'bar';
  el.meter.appendChild(b);
  bars.push(b);
}

// 파일 목록 상태
let fileSeq = 0;
let activeFileId = null;
const files = new Map();

// ── 2) Provider 설정 영속화(localStorage) ─────────────────────────────
function defaultsFor(schema = []) {
  const d = {};
  for (const f of schema) if (f.default !== undefined) d[f.key] = f.default;
  return d;
}
function loadCfg(id) {
  const schema = META.get(id)?.configSchema || [];
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(cfgKey(id)) || '{}');
  } catch {
    saved = {};
  }
  return { ...defaultsFor(schema), ...saved };
}
function saveCfg(id, obj) {
  localStorage.setItem(cfgKey(id), JSON.stringify(obj));
}

// ── 3) 시스템 이벤트 → 상태 UI ────────────────────────────────────────
engine.bus.system((m) => {
  switch (m.type) {
    case SystemEvent.ENGINE_READY:
      populateProviders(m.payload.providers);
      break;
    case SystemEvent.PROVIDER_CHANGED:
      reflectProvider(m.payload);
      break;
    case SystemEvent.MODE_CHANGED:
      setActiveMode(m.payload.mode);
      break;
    case SystemEvent.MODEL_LOADING:
      setStatus(`모델 로딩 중… (${m.payload.model})`, 'warn');
      break;
    case SystemEvent.MODEL_READY:
      setStatus(`모델 준비 완료 (${m.payload.model})`, 'ok');
      break;
    case SystemEvent.RECOGNITION_STARTED:
      setRunning(true);
      setStatus(`인식 시작 · ${m.payload.provider} / ${modeLabel(m.payload.mode)}`, 'ok');
      break;
    case SystemEvent.RECOGNITION_STOPPED:
      setRunning(false);
      setStatus('대기 중', 'idle');
      break;
    case SystemEvent.RECOGNITION_ERROR:
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

// ── 렌더 헬퍼 ────────────────────────────────────────────────────────
function populateProviders(list) {
  el.providerSelect.innerHTML = '';
  for (const p of list) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.supported ? p.label : `${p.label} (미지원)`;
    opt.disabled = !p.supported;
    el.providerSelect.appendChild(opt);
  }
}

function reflectProvider({ provider, label, capabilities, configSchema, fileInputKind, mode }) {
  el.providerSelect.value = provider;
  for (const btn of el.modeButtons) {
    const supported = capabilities.includes(btn.dataset.mode);
    btn.disabled = !supported;
    btn.classList.toggle('unavailable', !supported);
  }
  setActiveMode(mode);
  el.capabilityHint.textContent = `지원 모드: ${capabilities.map(modeLabel).join(' · ')}`;
  renderSettings(provider, label, configSchema);
  // WebSpeech처럼 파일을 음향 루프백으로만 받는 Provider는 디지털 라우팅 UI 노출
  el.routing.hidden = fileInputKind !== 'loopback';
  if (!el.routing.hidden) void populateSinks();
}

/** 출력 장치 목록을 채운다(가상장치 선택용). */
async function populateSinks() {
  let devices = [];
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

function renderSettings(providerId, label, schema = []) {
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

  const collect = () => {
    const values = {};
    for (const f of schema) {
      const node = $(`cfg-${f.key}`);
      values[f.key] = f.type === 'checkbox' ? node.checked : node.value.trim();
    }
    return values;
  };

  for (const f of schema) {
    if (f.type === 'checkbox') {
      const row = document.createElement('label');
      row.className = 'check-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = `cfg-${f.key}`;
      cb.checked = !!cfg[f.key];
      const span = document.createElement('span');
      span.textContent = f.label;
      // 토글 즉시 적용(저장 버튼 없이)
      cb.addEventListener('change', () => {
        const values = collect();
        saveCfg(providerId, values);
        engine.configureProvider(values);
        setStatus(`오프라인 모드 ${cb.checked ? 'ON' : 'OFF'}`, cb.checked ? 'ok' : 'idle');
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
    input.value = cfg[f.key] ?? '';
    if (f.type === 'password') input.autocomplete = 'new-password';
    wrap.append(name, input);
    el.settings.appendChild(wrap);
  }

  // 텍스트 필드가 있을 때만 저장 버튼(체크박스 전용이면 즉시 적용)
  if (schema.some((f) => f.type !== 'checkbox')) {
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

function modeLabel(mode) {
  return { [Mode.MIC]: '마이크', [Mode.FILE]: '파일', [Mode.FILE_LOOPBACK]: '파일(루프백)' }[mode] || mode;
}

function setActiveMode(mode) {
  for (const btn of el.modeButtons) btn.classList.toggle('active', btn.dataset.mode === mode);
}

function setRunning(running) {
  el.signal.classList.toggle('live', running);
  el.btnStart.disabled = running;
  el.btnStop.disabled = !running;
  el.dropzone.classList.toggle('locked', running);
}

function setStatus(text, kind = 'idle') {
  el.statusText.textContent = text;
  el.statusText.dataset.kind = kind;
}

function setInterim(text) {
  el.interim.textContent = text;
  el.interim.classList.toggle('show', Boolean(text));
}

function appendFinal(text, meta) {
  if (!text) return;
  const line = document.createElement('div');
  line.className = 'line';
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = `${meta.provider}·${modeLabel(meta.mode)}`;
  const span = document.createElement('span');
  span.className = 'txt';
  span.textContent = text;
  line.append(tag, span);
  el.transcript.appendChild(line);
  el.transcript.scrollTop = el.transcript.scrollHeight;
}

function renderLevel(level) {
  const n = bars.length;
  for (let i = 0; i < n; i++) {
    const dist = Math.abs(i - (n - 1) / 2) / (n / 2);
    const h = Math.max(0.06, level * (1 - dist * 0.7) * (0.6 + Math.random() * 0.4));
    bars[i].style.transform = `scaleY(${h.toFixed(3)})`;
  }
}

// ── 파일 업로드 / 목록 ───────────────────────────────────────────────
function addFiles(fileListLike) {
  for (const f of fileListLike) {
    if (!f.type.startsWith('audio/')) continue;
    const id = `f${++fileSeq}`;
    files.set(id, f);
    renderFileItem(id, f);
  }
}

function renderFileItem(id, file) {
  const item = document.createElement('li');
  item.className = 'file-item';
  item.dataset.id = id;
  item.innerHTML = `
    <button class="file-pick" type="button">
      <span class="file-name"></span>
      <span class="file-meta"></span>
    </button>
    <button class="file-del" type="button" title="삭제">✕</button>`;
  item.querySelector('.file-name').textContent = file.name;
  item.querySelector('.file-meta').textContent = `${(file.size / 1024).toFixed(0)} KB · ${file.type || 'audio'}`;
  item.querySelector('.file-pick').addEventListener('click', () => selectFile(id));
  item.querySelector('.file-del').addEventListener('click', () => removeFile(id));
  el.fileList.appendChild(item);
  if (!activeFileId) selectFile(id);
}

function selectFile(id) {
  const file = files.get(id);
  if (!file) return;
  activeFileId = id;
  engine.loadFile(file);
  for (const li of el.fileList.children) li.classList.toggle('active', li.dataset.id === id);
  // 파일을 고르면 파일 모드로 자동 전환(모든 Provider가 file 지원)
  if (engine.mode === Mode.MIC && (engine.provider?.capabilities || []).includes(Mode.FILE)) {
    safeSetMode(Mode.FILE);
  }
}

function removeFile(id) {
  files.delete(id);
  [...el.fileList.children].find((c) => c.dataset.id === id)?.remove();
  if (activeFileId === id) {
    activeFileId = null;
    const first = el.fileList.firstElementChild;
    if (first) selectFile(first.dataset.id);
  }
}

function safeSetMode(mode) {
  try {
    engine.setMode(mode);
  } catch (err) {
    setStatus(err.message, 'warn');
  }
}

// ── 이벤트 바인딩 ─────────────────────────────────────────────────────
el.providerSelect.addEventListener('change', async () => {
  const id = el.providerSelect.value;
  try {
    await engine.useProvider(id, loadCfg(id));
  } catch (err) {
    setStatus(err.message, 'error');
  }
});

for (const btn of el.modeButtons) btn.addEventListener('click', () => safeSetMode(btn.dataset.mode));
el.langSelect.addEventListener('change', () => engine.setLang(el.langSelect.value));

el.sinkRefresh.addEventListener('click', () => populateSinks());
el.sinkSelect.addEventListener('change', async () => {
  try {
    await engine.setOutputSink(el.sinkSelect.value);
  } catch (err) {
    setStatus(err.message, 'error');
  }
});
el.fileInput.addEventListener('change', (e) => addFiles(e.target.files));

['dragenter', 'dragover'].forEach((ev) =>
  el.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    el.dropzone.classList.add('drag');
  }),
);
['dragleave', 'drop'].forEach((ev) =>
  el.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    el.dropzone.classList.remove('drag');
  }),
);
el.dropzone.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
el.dropzone.addEventListener('click', () => el.fileInput.click());

el.btnStart.addEventListener('click', async () => {
  try {
    await engine.start();
  } catch (err) {
    setStatus(err.message, 'error');
  }
});
el.btnStop.addEventListener('click', () => engine.stop());
el.btnClear.addEventListener('click', () => {
  el.transcript.innerHTML = '';
  setInterim('');
});

// ── 부트스트랩 ───────────────────────────────────────────────────────
async function boot() {
  if (!window.isSecureContext) el.secureBanner.hidden = false;
  engine.attachAudioElement(el.audio);
  engine.ready();

  const first = engine.listProviders().find((p) => p.supported);
  if (first) {
    await engine.useProvider(first.id, loadCfg(first.id));
  } else {
    setStatus('사용 가능한 Provider가 없습니다', 'error');
    return;
  }
  setStatus('대기 중 — 마이크는 시작을, 파일은 업로드 후 시작을 누르세요', 'idle');
}

boot();
