import './styles.css';
import { FeatureExtractor, LevelGate, type AudioFrame } from './audio/features';
import { startMic, type MicHandle } from './audio/mic';
import { ScoreFollower } from './follow/tracker';
import * as lib from './score/library';
import { ScoreView, type LoadedScore } from './score/view';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const el = {
  app: $('app'),
  library: $('library'),
  libraryToggle: $<HTMLButtonElement>('libraryToggle'),
  scrim: $('scrim'),
  drop: $('drop'),
  fileInput: $<HTMLInputElement>('fileInput'),
  userList: $<HTMLUListElement>('userList'),
  userEmpty: $('userEmpty'),
  sampleList: $<HTMLUListElement>('sampleList'),
  storageNote: $('storageNote'),
  stage: $('stage'),
  score: $('score'),
  paperWrap: $('paperWrap'),
  emptyState: $('emptyState'),
  loading: $('loading'),
  nowTitle: $('nowTitle'),
  micBtn: $<HTMLButtonElement>('micBtn'),
  micLabel: $('micLabel'),
  status: $('status'),
  levelFill: $('levelFill'),
  levelGate: $('levelGate'),
  chroma: $('chroma'),
  measureNow: $('measureNow'),
  measureTotal: $('measureTotal'),
  tempo: $('tempo'),
  toStart: $<HTMLButtonElement>('toStart'),
  stepBack: $<HTMLButtonElement>('stepBack'),
  stepFwd: $<HTMLButtonElement>('stepFwd'),
  zoomIn: $<HTMLButtonElement>('zoomIn'),
  zoomOut: $<HTMLButtonElement>('zoomOut'),
  settingsToggle: $<HTMLButtonElement>('settingsToggle'),
  settings: $('settings'),
  sensitivity: $<HTMLInputElement>('sensitivity'),
  sensitivityVal: $('sensitivityVal'),
  strictness: $<HTMLInputElement>('strictness'),
  strictnessVal: $('strictnessVal'),
  bpm: $<HTMLInputElement>('bpm'),
  autoScroll: $<HTMLInputElement>('autoScroll'),
  toast: $('toast'),
};

// ---------- 전역 설정 (브라우저에만 저장되는 편의 설정) ----------
interface GlobalPrefs {
  zoom: number;
  sensitivity: number;
  strictness: number;
  autoScroll: boolean;
  lastScore: string | null;
}
const prefs: GlobalPrefs = lib.loadPrefs<GlobalPrefs>('global', {
  zoom: window.innerWidth < 700 ? 0.7 : 1,
  sensitivity: 0.5,
  strictness: 9,
  autoScroll: true,
  lastScore: null,
});
const savePrefs = () => lib.savePrefs('global', prefs);

// ---------- 상태 ----------
interface SampleInfo {
  id: string;
  title: string;
  composer: string;
  file: string;
}
let samples: SampleInfo[] = [];
const view = new ScoreView(el.score, prefs.zoom);
let loaded: LoadedScore | null = null;
let currentId: string | null = null;
let follower: ScoreFollower | null = null;
let fx: FeatureExtractor | null = null;
const gate = new LevelGate();
gate.sensitivity = prefs.sensitivity;
let mic: MicHandle | null = null;
let micStarting = false;
let position = -1;
let lastFrame: AudioFrame | null = null;
let lastVoiced = false;
let lastVoicedAt = 0;
let confidence = 1;
let userScrolledAt = 0;
let wakeLock: { release(): Promise<void> } | null = null;
let loadToken = 0;

// ---------- 악보 목록 ----------
async function loadSampleIndex(): Promise<void> {
  try {
    const res = await fetch('samples/index.json');
    samples = await res.json();
  } catch {
    samples = [];
  }
}

function itemNode(entry: lib.ScoreEntry, onDelete?: () => void): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'lib-item';
  li.dataset.id = entry.id;
  if (entry.id === currentId) li.classList.add('active');
  const open = document.createElement('button');
  open.className = 'lib-open';
  open.type = 'button';
  const t = document.createElement('span');
  t.className = 'lib-title';
  t.textContent = entry.title;
  const sub = document.createElement('span');
  sub.className = 'lib-sub';
  sub.textContent = entry.subtitle;
  open.append(t, sub);
  open.addEventListener('click', () => {
    closeLibrary();
    void openScore(entry.id);
  });
  li.append(open);
  if (onDelete) {
    const del = document.createElement('button');
    del.className = 'lib-del';
    del.type = 'button';
    del.setAttribute('aria-label', `${entry.title} 삭제`);
    del.title = '삭제';
    del.textContent = '×';
    del.addEventListener('click', onDelete);
    li.append(del);
  }
  return li;
}

async function renderLibrary(): Promise<void> {
  const users = await lib.listScores();
  el.userList.replaceChildren(
    ...users.map((s) =>
      itemNode(
        { id: s.id, title: s.title, subtitle: `${s.fileName} · ${new Date(s.addedAt).toLocaleDateString('ko-KR')}`, builtin: false },
        () => void removeScore(s.id, s.title),
      ),
    ),
  );
  el.userEmpty.hidden = users.length > 0;
  el.sampleList.replaceChildren(
    ...samples.map((s) => itemNode({ id: `sample:${s.id}`, title: s.title, subtitle: s.composer, builtin: true })),
  );
  el.storageNote.hidden = await lib.isPersistent();
}

function markActive(): void {
  document.querySelectorAll<HTMLLIElement>('.lib-item').forEach((li) => {
    li.classList.toggle('active', li.dataset.id === currentId);
  });
}

async function removeScore(id: string, title: string): Promise<void> {
  if (!confirm(`'${title}' 악보를 목록에서 지울까요?`)) return;
  await lib.deleteScore(id);
  if (id === currentId) {
    currentId = null;
    loaded = null;
    follower = null;
    view.clear();
    el.paperWrap.classList.remove('has-score');
    el.emptyState.hidden = false;
    el.nowTitle.textContent = '악보를 골라 주세요';
    el.micBtn.disabled = true;
    stopListening();
    updateDock();
  }
  await renderLibrary();
}

async function addFiles(files: FileList | File[]): Promise<void> {
  let last: lib.StoredScore | null = null;
  for (const f of Array.from(files)) {
    try {
      last = await lib.addScoreFile(f);
    } catch (e) {
      toast((e as Error).message);
    }
  }
  await renderLibrary();
  if (last) {
    closeLibrary();
    await openScore(last.id);
  }
}

// ---------- 악보 열기 ----------
async function openScore(id: string): Promise<void> {
  const token = ++loadToken;
  el.loading.hidden = false;
  el.emptyState.hidden = true;
  try {
    let content: string | Blob;
    let title: string;
    let stored: lib.StoredScore | undefined;
    if (id.startsWith('sample:')) {
      const s = samples.find((x) => `sample:${x.id}` === id);
      if (!s) throw new Error('예제 악보를 찾을 수 없습니다.');
      const res = await fetch(`samples/${s.file}`);
      if (!res.ok) throw new Error('예제 악보를 불러오지 못했습니다.');
      content = await res.text();
      title = s.title;
    } else {
      stored = await lib.getScore(id);
      if (!stored) throw new Error('저장된 악보를 찾을 수 없습니다.');
      title = stored.title;
      content = /\.mxl$/i.test(stored.fileName) ? stored.data : await stored.data.text();
    }
    if (token !== loadToken) return;
    const result = await view.load(content, title);
    if (token !== loadToken) return;
    // 압축(.mxl) 파일은 열어 봐야 제목을 알 수 있으므로 목록의 이름을 고쳐 둔다
    if (stored && result.title && result.title !== stored.title && stored.title === stored.fileName.replace(/\.[^.]+$/, '')) {
      stored.title = result.title;
      await lib.putScore(stored);
      void renderLibrary();
    }
    loaded = result;
    currentId = id;
    prefs.lastScore = id;
    savePrefs();
    const scorePrefs = lib.loadPrefs(id, { bpm: Math.round(result.bpm) });
    el.bpm.value = String(scorePrefs.bpm);
    el.nowTitle.textContent = result.title;
    el.paperWrap.classList.add('has-score');
    el.measureTotal.textContent = ` / ${lastMeasure()}`;
    el.micBtn.disabled = false;
    position = -1;
    createFollower();
    view.showEvent(-1);
    el.stage.scrollTo({ top: 0, behavior: 'auto' });
    markActive();
    updateDock();
  } catch (e) {
    console.error(e);
    if (token === loadToken) {
      toast(`악보를 열 수 없어요: ${(e as Error).message}`);
      if (!loaded) el.emptyState.hidden = false;
    }
  } finally {
    if (token === loadToken) el.loading.hidden = true;
  }
}

function lastMeasure(): number {
  if (!loaded) return 0;
  return loaded.events.reduce((m, e) => Math.max(m, e.measure), 0);
}

function currentBpm(): number {
  const v = Number(el.bpm.value);
  return Number.isFinite(v) && v >= 20 && v <= 320 ? v : (loaded?.bpm ?? 100);
}

/** 추적기를 (다시) 만든다. 마이크 샘플레이트가 정해지면 그에 맞춘다. */
function createFollower(): void {
  if (!loaded) return;
  const sampleRate = mic?.sampleRate ?? 48000;
  fx = new FeatureExtractor(sampleRate);
  follower = new ScoreFollower(loaded.events, { hopSec: fx.hopSec, bpm: currentBpm(), sharpness: prefs.strictness });
  if (position >= 0) follower.setPosition(position);
}

// ---------- 위치 ----------
function setPosition(index: number, fromUser: boolean): void {
  if (!loaded) return;
  const n = loaded.events.length;
  position = Math.max(-1, Math.min(n - 1, index));
  if (fromUser && follower) {
    if (position < 0) follower.reset();
    else follower.setPosition(position);
  }
  view.showEvent(position);
  if (fromUser) userScrolledAt = 0;
  followScroll(fromUser);
  updateDock();
}

function followScroll(force: boolean): void {
  if (!el.autoScroll.checked && !force) return;
  if (!force && performance.now() - userScrolledAt < 4000) return;
  const r = view.cursorRect();
  if (!r) return;
  const stageRect = el.stage.getBoundingClientRect();
  const top = r.top - stageRect.top;
  const bottom = r.bottom - stageRect.top;
  const h = stageRect.height;
  // 커서가 화면의 위 1/3 근처에 오도록. 이미 적당한 곳에 있으면 움직이지 않는다.
  if (top < h * 0.08 || bottom > h * 0.8) {
    el.stage.scrollTo({ top: el.stage.scrollTop + top - h * 0.22, behavior: 'smooth' });
  }
}

// ---------- 마이크 ----------
async function startListening(): Promise<void> {
  if (mic || micStarting || !loaded) return;
  micStarting = true;
  el.micBtn.disabled = true;
  try {
    mic = await startMic(onSamples);
    gate.reset();
    createFollower();
    el.micBtn.setAttribute('aria-pressed', 'true');
    el.micLabel.textContent = '멈춤';
    lastVoicedAt = performance.now();
    requestWakeLock();
  } catch (e) {
    const err = e as DOMException;
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
      toast('마이크 권한이 필요해요. 주소창의 권한 설정에서 마이크를 허용해 주세요.');
    } else if (err.name === 'NotFoundError') {
      toast('사용할 수 있는 마이크가 없어요.');
    } else {
      toast(`마이크를 켤 수 없어요: ${err.message}`);
    }
  } finally {
    micStarting = false;
    el.micBtn.disabled = !loaded;
    updateDock();
  }
}

function stopListening(): void {
  mic?.stop();
  mic = null;
  lastFrame = null;
  lastVoiced = false;
  el.micBtn.setAttribute('aria-pressed', 'false');
  el.micLabel.textContent = '듣기 시작';
  void wakeLock?.release().catch(() => undefined);
  wakeLock = null;
  updateDock();
}

function onSamples(block: Float32Array): void {
  if (!fx || !follower) return;
  for (const f of fx.push(block)) {
    const voiced = gate.update(f.rms, f.flatness);
    const st = follower.update(f, voiced);
    lastFrame = f;
    lastVoiced = voiced;
    if (voiced) {
      lastVoicedAt = performance.now();
      confidence = st.confidence;
    }
    if (st.index !== position) setPosition(st.index, false);
  }
}

function requestWakeLock(): void {
  const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };
  nav.wakeLock
    ?.request('screen')
    .then((l) => (wakeLock = l))
    .catch(() => undefined);
}

// ---------- 하단 표시 ----------
const PITCH_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const chromaBars: HTMLElement[] = PITCH_NAMES.map((name) => {
  const s = document.createElement('span');
  s.title = name;
  const i = document.createElement('i');
  s.append(i);
  el.chroma.append(s);
  return i;
});

function updateDock(): void {
  if (!loaded) {
    el.measureNow.textContent = '·';
    el.measureTotal.textContent = '';
    el.tempo.textContent = '♩ –';
    setStatus('악보를 고르면 시작할 수 있어요');
    return;
  }
  const ev = position >= 0 ? loaded.events[position] : null;
  el.measureNow.textContent = ev ? String(ev.measure) : '·';
  el.tempo.textContent = `♩ ${Math.round(follower?.tempo ?? currentBpm())}`;
  if (!mic) {
    setStatus(position < 0 ? '듣기를 누르고 첫 음부터 연주하세요' : '듣기를 누르면 이 위치부터 따라갑니다');
    return;
  }
  const quiet = performance.now() - lastVoicedAt > 1200;
  if (position >= loaded.events.length - 1) setStatus('마지막 음이에요 · 잘했어요!');
  else if (quiet) setStatus(position < 0 ? '첫 음을 연주하세요 · 듣는 중' : '기다리는 중 · 이어서 연주하세요');
  else if (confidence < 0.35) setStatus('위치를 찾는 중…', true);
  else setStatus('따라가는 중');
}

function setStatus(text: string, warn = false): void {
  if (el.status.textContent !== text) el.status.textContent = text;
  el.status.classList.toggle('warn', warn);
}

function drawMeters(): void {
  const f = lastFrame;
  if (f && mic) {
    const db = 20 * Math.log10(f.rms + 1e-9);
    const pct = Math.max(0, Math.min(100, ((db + 70) / 70) * 100));
    el.levelFill.style.width = `${pct}%`;
    el.levelFill.classList.toggle('voiced', lastVoiced);
    const ratio = Math.pow(10, (20 - 14 * gate.sensitivity) / 20);
    const gdb = 20 * Math.log10(gate.noiseFloor * ratio + 1e-9);
    el.levelGate.style.left = `${Math.max(0, Math.min(100, ((gdb + 70) / 70) * 100))}%`;
    chromaBars.forEach((b, i) => {
      b.style.height = lastVoiced ? `${Math.round(Math.max(0, f.chroma[i]) * 100)}%` : '0%';
    });
  } else {
    el.levelFill.style.width = '0%';
    chromaBars.forEach((b) => (b.style.height = '0%'));
  }
  updateDock();
  requestAnimationFrame(drawMeters);
}

// ---------- 알림 ----------
let toastTimer = 0;
function toast(msg: string): void {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.toast.hidden = true), 4500);
}

// ---------- 목록 서랍 (좁은 화면) ----------
function openLibrary(): void {
  el.library.classList.add('open');
  el.scrim.hidden = false;
  el.libraryToggle.setAttribute('aria-expanded', 'true');
}
function closeLibrary(): void {
  el.library.classList.remove('open');
  el.scrim.hidden = true;
  el.libraryToggle.setAttribute('aria-expanded', 'false');
}

// ---------- 이벤트 연결 ----------
el.libraryToggle.addEventListener('click', () => (el.library.classList.contains('open') ? closeLibrary() : openLibrary()));
el.scrim.addEventListener('click', closeLibrary);

el.fileInput.addEventListener('change', () => {
  if (el.fileInput.files?.length) void addFiles(el.fileInput.files);
  el.fileInput.value = '';
});
for (const target of [el.drop, document.body]) {
  target.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    el.drop.classList.add('dragging');
  });
  target.addEventListener('dragleave', () => el.drop.classList.remove('dragging'));
  target.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    e.stopPropagation();
    el.drop.classList.remove('dragging');
    void addFiles(e.dataTransfer.files);
  });
}

el.micBtn.addEventListener('click', () => (mic ? stopListening() : void startListening()));
el.toStart.addEventListener('click', () => setPosition(-1, true));
el.stepBack.addEventListener('click', () => setPosition(position - 1, true));
el.stepFwd.addEventListener('click', () => setPosition(position + 1, true));

el.score.addEventListener('click', (e) => {
  if (!view.loaded) return;
  const idx = view.eventAtClient(e.clientX, e.clientY);
  if (idx >= 0) setPosition(idx, true);
});

const markScrolled = () => (userScrolledAt = performance.now());
el.stage.addEventListener('wheel', markScrolled, { passive: true });
el.stage.addEventListener('touchmove', markScrolled, { passive: true });

function applyZoom(z: number): void {
  prefs.zoom = Math.round(Math.max(0.4, Math.min(2.2, z)) * 100) / 100;
  savePrefs();
  view.setZoom(prefs.zoom);
  followScroll(true);
}
el.zoomIn.addEventListener('click', () => applyZoom(prefs.zoom + 0.1));
el.zoomOut.addEventListener('click', () => applyZoom(prefs.zoom - 0.1));

let lastWidth = el.stage.clientWidth;
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    const w = el.stage.clientWidth;
    if (Math.abs(w - lastWidth) < 8) return;
    lastWidth = w;
    view.setZoom(prefs.zoom);
    followScroll(true);
  }, 250);
});

el.settingsToggle.addEventListener('click', () => {
  el.settings.hidden = !el.settings.hidden;
  el.settingsToggle.setAttribute('aria-expanded', String(!el.settings.hidden));
});
document.addEventListener('click', (e) => {
  const t = e.target as Node;
  if (!el.settings.hidden && !el.settings.contains(t) && !el.settingsToggle.contains(t)) {
    el.settings.hidden = true;
    el.settingsToggle.setAttribute('aria-expanded', 'false');
  }
});

function describe(v: number, labels: [string, string, string]): string {
  return v < 0.34 ? labels[0] : v < 0.67 ? labels[1] : labels[2];
}
function syncSettingLabels(): void {
  el.sensitivityVal.textContent = describe(Number(el.sensitivity.value), ['둔감 · 큰 소리만', '보통', '예민 · 작은 소리도']);
  const st = (Number(el.strictness.value) - 5) / 9;
  el.strictnessVal.textContent = describe(st, ['너그럽게', '보통', '엄격하게']);
}
el.sensitivity.value = String(prefs.sensitivity);
el.strictness.value = String(prefs.strictness);
el.autoScroll.checked = prefs.autoScroll;
syncSettingLabels();
el.sensitivity.addEventListener('input', () => {
  prefs.sensitivity = Number(el.sensitivity.value);
  gate.sensitivity = prefs.sensitivity;
  syncSettingLabels();
  savePrefs();
});
el.strictness.addEventListener('input', () => {
  prefs.strictness = Number(el.strictness.value);
  follower?.setSharpness(prefs.strictness);
  syncSettingLabels();
  savePrefs();
});
el.autoScroll.addEventListener('change', () => {
  prefs.autoScroll = el.autoScroll.checked;
  savePrefs();
});
el.bpm.addEventListener('change', () => {
  const bpm = currentBpm();
  el.bpm.value = String(Math.round(bpm));
  follower?.setScoreTempo(bpm);
  if (currentId) lib.savePrefs(currentId, { bpm: Math.round(bpm) });
  updateDock();
});

document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === ' ' && loaded) {
    e.preventDefault();
    if (mic) stopListening();
    else void startListening();
  } else if (e.key === 'ArrowRight' && loaded) {
    e.preventDefault();
    setPosition(position + 1, true);
  } else if (e.key === 'ArrowLeft' && loaded) {
    e.preventDefault();
    setPosition(position - 1, true);
  } else if (e.key === 'Home' && loaded) {
    e.preventDefault();
    setPosition(-1, true);
  } else if (e.key === 'Escape') {
    el.settings.hidden = true;
    closeLibrary();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && mic) requestWakeLock();
});

// ---------- 시작 ----------
async function init(): Promise<void> {
  await loadSampleIndex();
  await renderLibrary();
  const params = new URLSearchParams(location.search);
  const want = params.get('score') ?? prefs.lastScore;
  const users = await lib.listScores();
  const exists = (id: string) => users.some((u) => u.id === id) || samples.some((s) => `sample:${s.id}` === id);
  if (want && exists(want)) await openScore(want);
  else if (samples.length) await openScore(`sample:${samples[0].id}`);
  requestAnimationFrame(drawMeters);
}

void init();

// 테스트/디버깅용으로 상태 일부를 노출
(window as unknown as { __readClassic: object }).__readClassic = {
  get position() {
    return position;
  },
  get measure() {
    return position >= 0 && loaded ? loaded.events[position].measure : null;
  },
  get events() {
    return loaded?.events ?? [];
  },
  get listening() {
    return mic !== null;
  },
};
