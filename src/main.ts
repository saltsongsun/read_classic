import './styles.css';
import { FeatureExtractor, LevelGate, type AudioFrame } from './audio/features';
import { startMic, type MicHandle } from './audio/mic';
import { formatDuration, ProgressEstimator, type ProgressSnapshot } from './follow/progress';
import { ScoreFollower } from './follow/tracker';
import type { ScoreEvent } from './follow/types';
import { layoutEvents } from './score/imageLayout';
import { ImageScoreView, type PageImage } from './score/imageView';
import { checkServer, imageToPage, isImageOrPdf, isPdf, LAPTOP_APP, pdfToPages, recognizePage, type OmrPage } from './score/importImages';
import * as lib from './score/library';
import { combinePages, eventsFromSteps, parseMusicXML, toSteps } from './score/musicxml';
import { ScoreView } from './score/view';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const el = {
  library: $('library'),
  libraryToggle: $<HTMLButtonElement>('libraryToggle'),
  scrim: $('scrim'),
  drop: $('drop'),
  fileInput: $<HTMLInputElement>('fileInput'),
  cameraInput: $<HTMLInputElement>('cameraInput'),
  userList: $<HTMLUListElement>('userList'),
  userEmpty: $('userEmpty'),
  sampleList: $<HTMLUListElement>('sampleList'),
  storageNote: $('storageNote'),
  stage: $('stage'),
  score: $('score'),
  imageScore: $('imageScore'),
  paperWrap: $('paperWrap'),
  emptyState: $('emptyState'),
  loading: $('loading'),
  nowTitle: $('nowTitle'),
  dock: $('dock'),
  micBtn: $<HTMLButtonElement>('micBtn'),
  micLabel: $('micLabel'),
  status: $('status'),
  levelFill: $('levelFill'),
  levelGate: $('levelGate'),
  chroma: $('chroma'),
  measureNow: $('measureNow'),
  measureTotal: $('measureTotal'),
  tempo: $('tempo'),
  progressFill: $('progressFill'),
  remainLabel: $('remainLabel'),
  remain: $('remain'),
  elapsed: $('elapsed'),
  toStart: $<HTMLButtonElement>('toStart'),
  stepBack: $<HTMLButtonElement>('stepBack'),
  stepFwd: $<HTMLButtonElement>('stepFwd'),
  zoomIn: $<HTMLButtonElement>('zoomIn'),
  zoomOut: $<HTMLButtonElement>('zoomOut'),
  settingsToggle: $<HTMLButtonElement>('settingsToggle'),
  settings: $('settings'),
  expected: $<HTMLInputElement>('expected'),
  alertSec: $<HTMLInputElement>('alertSec'),
  sensitivity: $<HTMLInputElement>('sensitivity'),
  sensitivityVal: $('sensitivityVal'),
  strictness: $<HTMLInputElement>('strictness'),
  strictnessVal: $('strictnessVal'),
  bpm: $<HTMLInputElement>('bpm'),
  omrServer: $<HTMLInputElement>('omrServer'),
  omrServerStatus: $('omrServerStatus'),
  showTicks: $<HTMLInputElement>('showTicks'),
  autoScroll: $<HTMLInputElement>('autoScroll'),
  toast: $('toast'),
  getApp: $('getApp'),
  getAppWin: $<HTMLAnchorElement>('getAppWin'),
  getAppMac: $<HTMLAnchorElement>('getAppMac'),
  getAppPage: $<HTMLAnchorElement>('getAppPage'),
  quitRow: $('quitRow'),
  quitApp: $<HTMLButtonElement>('quitApp'),
  importDialog: $<HTMLDialogElement>('importDialog'),
  importTitle: $<HTMLInputElement>('importTitle'),
  importPages: $<HTMLOListElement>('importPages'),
  importCamera: $<HTMLInputElement>('importCamera'),
  importFiles: $<HTMLInputElement>('importFiles'),
  importServer: $('importServer'),
  importProgress: $('importProgress'),
  importCancel: $<HTMLButtonElement>('importCancel'),
  importStart: $<HTMLButtonElement>('importStart'),
};

// ---------- 설정 (이 브라우저에만 저장되는 편의 설정) ----------
interface GlobalPrefs {
  zoom: number;
  sensitivity: number;
  strictness: number;
  autoScroll: boolean;
  lastScore: string | null;
  alertSec: number;
  omrServer: string;
  showTicks: boolean;
  /** 사진 악보 확대 비율 (MusicXML 악보와 따로) */
  imageZoom: number;
}
const prefs: GlobalPrefs = lib.loadPrefs<GlobalPrefs>('global', {
  zoom: window.innerWidth < 700 ? 0.7 : 1,
  sensitivity: 0.5,
  strictness: 9,
  autoScroll: true,
  lastScore: null,
  alertSec: 30,
  omrServer: '',
  showTicks: false,
  imageZoom: 1,
});
const savePrefs = () => lib.savePrefs('global', prefs);

interface ScorePrefs {
  bpm: number;
  expectedSec?: number;
}

/** 두 가지 악보 화면(MusicXML 렌더링 / 원본 사진·PDF)이 함께 갖는 기능 */
interface Display {
  readonly loaded: boolean;
  showEvent(index: number): void;
  cursorRect(): DOMRect | null;
  eventAtClient(x: number, y: number): number;
  setZoom(z: number): void;
  clear(): void;
}

interface LoadedScore {
  title: string;
  events: ScoreEvent[];
  bpm: number;
  kind: 'xml' | 'image';
}

// ---------- 상태 ----------
interface SampleInfo {
  id: string;
  title: string;
  composer: string;
  file: string;
}
let samples: SampleInfo[] = [];
const xmlView = new ScoreView(el.score, prefs.zoom);
const imageView = new ImageScoreView(el.imageScore, 1);
let display: Display = xmlView;
let loaded: LoadedScore | null = null;
let currentId: string | null = null;
let scorePrefs: ScorePrefs = { bpm: 100 };
let follower: ScoreFollower | null = null;
let progress: ProgressEstimator | null = null;
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
let wasEnding = false;
let snap: ProgressSnapshot | null = null;

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
    ...users.map((s) => {
      const date = new Date(s.addedAt).toLocaleDateString('ko-KR');
      const sub = s.kind === 'image' ? `사진·PDF 악보 ${s.pages?.length ?? 0}쪽 · ${date}` : `${s.fileName} · ${date}`;
      return itemNode({ id: s.id, title: s.title, subtitle: sub, builtin: false }, () => void removeScore(s.id, s.title));
    }),
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
    progress = null;
    display.clear();
    el.paperWrap.classList.remove('has-score');
    el.imageScore.hidden = true;
    el.emptyState.hidden = false;
    el.nowTitle.textContent = '악보를 골라 주세요';
    el.micBtn.disabled = true;
    stopListening();
    updateDock();
  }
  await renderLibrary();
}

/** 목록에 끌어다 놓거나 고른 파일들: MusicXML 은 바로 저장, 사진·PDF 는 인식 창으로 */
async function addFiles(files: FileList | File[]): Promise<void> {
  const list = Array.from(files);
  const images = list.filter((f) => !lib.isScoreFile(f) && isImageOrPdf(f));
  const others = list.filter((f) => !images.includes(f));
  let last: lib.StoredScore | null = null;
  for (const f of others) {
    try {
      last = await lib.addScoreFile(f);
    } catch (e) {
      toast((e as Error).message);
    }
  }
  if (others.length) await renderLibrary();
  if (images.length) {
    closeLibrary();
    openImport(images);
  } else if (last) {
    closeLibrary();
    await openScore(last.id);
  }
}

// ---------- 사진·PDF 악보 만들기 ----------
let importList: PageImage[] = [];
let importThumbUrls: string[] = [];
let importAbort: AbortController | null = null;

function openImport(files: File[]): void {
  importList = [];
  renderThumbs();
  el.importTitle.value = files[0] ? files[0].name.replace(/\.[^.]+$/, '') : '';
  el.importProgress.hidden = true;
  el.importStart.disabled = false;
  if (!el.importDialog.open) el.importDialog.showModal();
  void refreshServerStatus(el.importServer);
  void addImportFiles(files);
}

async function addImportFiles(files: File[]): Promise<void> {
  for (const f of files) {
    try {
      if (isPdf(f)) {
        showImportProgress('PDF 를 쪽별로 나누는 중…');
        const pages = await pdfToPages(f, (d, n) => showImportProgress(`PDF 를 쪽별로 나누는 중… ${d}/${n}`));
        importList.push(...pages);
      } else {
        importList.push(await imageToPage(f));
      }
      if (!el.importTitle.value) el.importTitle.value = f.name.replace(/\.[^.]+$/, '');
    } catch (e) {
      toast(`${f.name}: ${(e as Error).message}`);
    }
    renderThumbs();
  }
  el.importProgress.hidden = true;
}

function showImportProgress(text: string): void {
  el.importProgress.hidden = false;
  el.importProgress.textContent = text;
}

function renderThumbs(): void {
  importThumbUrls.forEach((u) => URL.revokeObjectURL(u));
  importThumbUrls = [];
  el.importPages.replaceChildren(
    ...importList.map((p, i) => {
      const li = document.createElement('li');
      li.className = 'thumb';
      const img = document.createElement('img');
      const url = URL.createObjectURL(p.blob);
      importThumbUrls.push(url);
      img.src = url;
      img.alt = `${i + 1}쪽`;
      const tools = document.createElement('div');
      tools.className = 'thumb-tools';
      const label = document.createElement('span');
      label.textContent = `${i + 1}쪽`;
      const mk = (text: string, title: string, fn: () => void, disabled = false) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        b.title = title;
        b.setAttribute('aria-label', `${i + 1}쪽 ${title}`);
        b.disabled = disabled;
        b.addEventListener('click', () => {
          fn();
          renderThumbs();
        });
        return b;
      };
      const swap = (a: number, b: number) => ([importList[a], importList[b]] = [importList[b], importList[a]]);
      tools.append(
        label,
        mk('←', '앞으로', () => swap(i, i - 1), i === 0),
        mk('→', '뒤로', () => swap(i, i + 1), i === importList.length - 1),
        mk('×', '빼기', () => importList.splice(i, 1)),
      );
      li.append(img, tools);
      return li;
    }),
  );
}

async function refreshServerStatus(target: HTMLElement): Promise<boolean> {
  target.textContent = '악보 인식 서버 확인 중…';
  target.classList.remove('ok', 'bad');
  const st = await checkServer(prefs.omrServer);
  target.textContent = st.message;
  target.classList.toggle('ok', st.ok);
  target.classList.toggle('bad', !st.ok);
  return st.ok;
}

async function startImport(): Promise<void> {
  if (importList.length === 0) {
    toast('악보 사진이나 PDF 를 먼저 넣어 주세요.');
    return;
  }
  const title = el.importTitle.value.trim() || '사진 악보';
  if (!(await refreshServerStatus(el.importServer))) return;
  el.importStart.disabled = true;
  importAbort = new AbortController();
  const results: OmrPage[] = [];
  try {
    for (let i = 0; i < importList.length; i++) {
      showImportProgress(`${i + 1}/${importList.length}쪽 인식 중… (한 쪽에 10~40초 걸려요)`);
      results.push(await recognizePage(prefs.omrServer, importList[i], importAbort.signal));
    }
    const notes = results.reduce((a, r) => a + (r.musicxml.match(/<pitch>/g)?.length ?? 0), 0);
    if (notes === 0) throw new Error('음표를 하나도 찾지 못했어요. 더 밝고 반듯하게 찍어 보세요.');
    const stored = await lib.addImageScore(title, importList, results);
    el.importDialog.close();
    await renderLibrary();
    await openScore(stored.id);
    toast(`'${title}' 악보를 저장했어요 (음표 ${notes}개 인식).`);
  } catch (e) {
    if ((e as Error).name !== 'AbortError') showImportProgress(`인식하지 못했어요: ${(e as Error).message}`);
  } finally {
    el.importStart.disabled = false;
    importAbort = null;
  }
}

// ---------- 악보 열기 ----------
async function openScore(id: string): Promise<void> {
  const token = ++loadToken;
  el.loading.hidden = false;
  el.emptyState.hidden = true;
  try {
    let result: LoadedScore;
    let stored: lib.StoredScore | undefined;
    if (id.startsWith('sample:')) {
      const s = samples.find((x) => `sample:${x.id}` === id);
      if (!s) throw new Error('예제 악보를 찾을 수 없습니다.');
      const res = await fetch(`samples/${s.file}`);
      if (!res.ok) throw new Error('예제 악보를 불러오지 못했습니다.');
      result = await showXml(await res.text(), s.title);
    } else {
      stored = await lib.getScore(id);
      if (!stored) throw new Error('저장된 악보를 찾을 수 없습니다.');
      if (stored.kind === 'image') result = await showImages(stored);
      else {
        const content = /\.mxl$/i.test(stored.fileName) ? stored.data : await stored.data.text();
        result = await showXml(content, stored.title);
        // 압축(.mxl) 파일은 열어 봐야 제목을 알 수 있으므로 목록의 이름을 고쳐 둔다
        if (result.title !== stored.title && stored.title === stored.fileName.replace(/\.[^.]+$/, '')) {
          stored.title = result.title;
          await lib.putScore(stored);
          void renderLibrary();
        }
      }
    }
    if (token !== loadToken) return;
    loaded = result;
    currentId = id;
    prefs.lastScore = id;
    savePrefs();
    scorePrefs = lib.loadPrefs<ScorePrefs>(id, { bpm: Math.round(result.bpm) });
    el.bpm.value = String(scorePrefs.bpm);
    el.expected.value = scorePrefs.expectedSec ? formatDuration(scorePrefs.expectedSec) : '';
    el.nowTitle.textContent = result.title;
    el.measureTotal.textContent = ` / ${lastMeasure()}`;
    el.micBtn.disabled = false;
    position = -1;
    createFollower();
    display.showEvent(-1);
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

async function showXml(content: string | Blob, title: string): Promise<LoadedScore> {
  imageView.clear();
  el.imageScore.hidden = true;
  el.score.hidden = false;
  display = xmlView;
  const r = await xmlView.load(content, title);
  el.paperWrap.classList.add('has-score');
  return { title: r.title, events: r.events, bpm: r.bpm, kind: 'xml' };
}

async function showImages(stored: lib.StoredScore): Promise<LoadedScore> {
  const omr = stored.omr ?? [];
  const parser = new DOMParser();
  const score = combinePages(omr.map((p, i) => parseMusicXML(p.musicxml, parser, i)));
  const steps = toSteps(score);
  const events = eventsFromSteps(steps, score.totalBeats);
  if (events.length === 0) throw new Error('인식된 음표가 없어요.');
  const pages: PageImage[] = (stored.pages ?? []).map((blob, i) => ({ blob, ...(stored.pageSizes?.[i] ?? { width: 1, height: 1 }) }));
  const geo = layoutEvents(
    score,
    steps,
    events,
    pages.map((p, i) => ({ width: p.width, height: p.height, staffs: omr[i]?.staffs ?? [] })),
  );
  xmlView.clear();
  el.paperWrap.classList.remove('has-score');
  el.score.hidden = true;
  el.imageScore.hidden = false;
  display = imageView;
  imageView.setZoom(prefs.imageZoom);
  imageView.setShowRecognized(prefs.showTicks);
  await imageView.load(pages, geo);
  return { title: stored.title, events, bpm: score.bpm ?? 100, kind: 'image' };
}

function lastMeasure(): number {
  if (!loaded) return 0;
  return loaded.events.reduce((m, e) => Math.max(m, e.measure), 0);
}

function currentBpm(): number {
  const v = Number(el.bpm.value);
  return Number.isFinite(v) && v >= 20 && v <= 320 ? v : (loaded?.bpm ?? 100);
}

/** 추적기와 진행률 계산기를 (다시) 만든다. 마이크 샘플레이트가 정해지면 그에 맞춘다. */
function createFollower(): void {
  if (!loaded) return;
  const sampleRate = mic?.sampleRate ?? 48000;
  fx = new FeatureExtractor(sampleRate);
  follower = new ScoreFollower(loaded.events, { hopSec: fx.hopSec, bpm: currentBpm(), sharpness: prefs.strictness });
  if (position >= 0) follower.setPosition(position);
  progress = new ProgressEstimator(loaded.events, { scoreBpm: currentBpm(), expectedTotalSec: scorePrefs.expectedSec });
  if (position >= 0) progress.jumpTo(position);
  wasEnding = false;
}

// ---------- 위치 ----------
function setPosition(index: number, fromUser: boolean): void {
  if (!loaded) return;
  const n = loaded.events.length;
  position = Math.max(-1, Math.min(n - 1, index));
  if (fromUser) {
    if (position < 0) {
      follower?.reset();
      progress?.reset();
      wasEnding = false;
    } else {
      follower?.setPosition(position);
      progress?.jumpTo(position);
    }
  }
  display.showEvent(position);
  if (fromUser) userScrolledAt = 0;
  followScroll(fromUser);
  updateDock();
}

function followScroll(force: boolean): void {
  if (!el.autoScroll.checked && !force) return;
  if (!force && performance.now() - userScrolledAt < 4000) return;
  const r = display.cursorRect();
  if (!r) return;
  const stageRect = el.stage.getBoundingClientRect();
  const top = r.top - stageRect.top;
  const bottom = r.bottom - stageRect.top;
  const h = stageRect.height;
  // 지금 줄이 화면 위 1/4 근처에 오도록. 이미 적당한 곳에 있으면 움직이지 않는다.
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
    const keepProgress = progress;
    createFollower();
    // 듣기를 잠깐 멈췄다 다시 켜도 경과 시간은 이어서 센다
    if (keepProgress && position >= 0) progress = keepProgress;
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
  const now = performance.now() / 1000;
  for (const f of fx.push(block)) {
    const voiced = gate.update(f.rms, f.flatness);
    const st = follower.update(f, voiced);
    progress?.update(now, st.index, voiced);
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

function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

function updateDock(): void {
  if (!loaded) {
    setText(el.measureNow, '·');
    setText(el.measureTotal, '');
    setText(el.tempo, '♩ –');
    setText(el.remain, '–');
    setText(el.elapsed, '');
    el.progressFill.style.width = '0%';
    el.dock.classList.remove('ending', 'finished');
    setStatus('악보를 고르면 시작할 수 있어요');
    return;
  }
  const ev = position >= 0 ? loaded.events[position] : null;
  setText(el.measureNow, ev ? String(ev.measure) : '·');
  setText(el.tempo, `♩ ${Math.round(follower?.tempo ?? currentBpm())}`);

  // 진행률·남은 시간
  snap = progress?.snapshot() ?? null;
  const s = snap;
  const alertSec = Number(el.alertSec.value) || 0;
  const ending = !!s && s.started && !s.finished && (s.remainingSec <= alertSec || s.measuresLeft === 0);
  if (s) {
    el.progressFill.style.width = `${(s.fraction * 100).toFixed(1)}%`;
    if (s.finished) {
      setText(el.remainLabel, '연주 시간');
      setText(el.remain, formatDuration(s.elapsedSec));
      setText(el.elapsed, '끝났어요');
    } else if (s.started) {
      setText(el.remainLabel, '남은 시간');
      setText(el.remain, `${s.remainingSec >= 60 ? '약 ' : ''}${formatDuration(s.remainingSec, true)}`);
      setText(el.elapsed, `경과 ${formatDuration(s.elapsedSec)} · ${Math.round(s.fraction * 100)}% · ${s.measuresLeft}마디 남음`);
    } else {
      setText(el.remainLabel, '예상 길이');
      setText(el.remain, `약 ${formatDuration(s.totalSec, true)}`);
      setText(el.elapsed, '첫 음을 기다려요');
    }
  }
  el.dock.classList.toggle('ending', ending);
  el.dock.classList.toggle('finished', !!s?.finished);
  if (ending && !wasEnding) navigator.vibrate?.([250, 120, 250]);
  wasEnding = ending;

  if (s?.finished) {
    setStatus(`연주가 끝났어요 · 총 ${formatDuration(s.elapsedSec)}`);
    return;
  }
  if (!mic) {
    setStatus(position < 0 ? '듣기를 누르고 첫 음부터 연주하세요' : '듣기를 누르면 이 위치부터 따라갑니다');
    return;
  }
  const quiet = performance.now() - lastVoicedAt > 1200;
  if (ending) setStatus('곧 끝나요');
  else if (quiet) setStatus(position < 0 ? '첫 음을 기다리는 중 · 듣는 중' : '기다리는 중 · 소리가 나면 이어서 따라가요');
  else if (confidence < 0.35) setStatus('위치를 찾는 중…', true);
  else setStatus('따라가는 중');
}

function setStatus(text: string, warn = false): void {
  setText(el.status, text);
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
  toastTimer = window.setTimeout(() => (el.toast.hidden = true), 5000);
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
el.cameraInput.addEventListener('change', () => {
  const files = Array.from(el.cameraInput.files ?? []);
  el.cameraInput.value = '';
  if (files.length) {
    closeLibrary();
    openImport(files);
  }
});
for (const target of [el.drop, document.body]) {
  target.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files') || el.importDialog.open) return;
    e.preventDefault();
    el.drop.classList.add('dragging');
  });
  target.addEventListener('dragleave', () => el.drop.classList.remove('dragging'));
  target.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files.length || el.importDialog.open) return;
    e.preventDefault();
    e.stopPropagation();
    el.drop.classList.remove('dragging');
    void addFiles(e.dataTransfer.files);
  });
}

// 가져오기 창
el.importCamera.addEventListener('change', () => {
  const files = Array.from(el.importCamera.files ?? []);
  el.importCamera.value = '';
  void addImportFiles(files);
});
el.importFiles.addEventListener('change', () => {
  const files = Array.from(el.importFiles.files ?? []);
  el.importFiles.value = '';
  void addImportFiles(files);
});
el.importDialog.addEventListener('dragover', (e) => e.preventDefault());
el.importDialog.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files.length) void addImportFiles(Array.from(e.dataTransfer.files).filter(isImageOrPdf));
});
el.importStart.addEventListener('click', () => void startImport());
el.importCancel.addEventListener('click', () => {
  importAbort?.abort();
  el.importDialog.close();
});
el.importDialog.addEventListener('close', () => {
  importAbort?.abort();
  importList = [];
  renderThumbs();
});

el.micBtn.addEventListener('click', () => (mic ? stopListening() : void startListening()));
el.toStart.addEventListener('click', () => setPosition(-1, true));
el.stepBack.addEventListener('click', () => setPosition(position - 1, true));
el.stepFwd.addEventListener('click', () => setPosition(position + 1, true));

for (const surface of [el.score, el.imageScore]) {
  surface.addEventListener('click', (e) => {
    if (!display.loaded) return;
    const idx = display.eventAtClient(e.clientX, e.clientY);
    if (idx >= 0) setPosition(idx, true);
  });
}

const markScrolled = () => (userScrolledAt = performance.now());
el.stage.addEventListener('wheel', markScrolled, { passive: true });
el.stage.addEventListener('touchmove', markScrolled, { passive: true });

function applyZoom(step: number): void {
  const clamp = (z: number) => Math.round(Math.max(0.4, Math.min(2.2, z)) * 100) / 100;
  if (display === imageView) {
    prefs.imageZoom = clamp(prefs.imageZoom + step);
    imageView.setZoom(prefs.imageZoom);
  } else {
    prefs.zoom = clamp(prefs.zoom + step);
    xmlView.setZoom(prefs.zoom);
  }
  savePrefs();
  followScroll(true);
}
el.zoomIn.addEventListener('click', () => applyZoom(0.1));
el.zoomOut.addEventListener('click', () => applyZoom(-0.1));

let lastWidth = el.stage.clientWidth;
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    const w = el.stage.clientWidth;
    if (Math.abs(w - lastWidth) < 8) return;
    lastWidth = w;
    if (display === xmlView) xmlView.setZoom(prefs.zoom); // 원본 악보는 CSS 로 알아서 맞춰진다
    followScroll(true);
  }, 250);
});

el.settingsToggle.addEventListener('click', () => {
  el.settings.hidden = !el.settings.hidden;
  el.settingsToggle.setAttribute('aria-expanded', String(!el.settings.hidden));
  if (!el.settings.hidden) void refreshServerStatus(el.omrServerStatus);
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
el.alertSec.value = String(prefs.alertSec);
el.omrServer.value = prefs.omrServer;
el.showTicks.checked = prefs.showTicks;
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
el.alertSec.addEventListener('change', () => {
  prefs.alertSec = Math.max(0, Number(el.alertSec.value) || 0);
  el.alertSec.value = String(prefs.alertSec);
  savePrefs();
});
el.omrServer.addEventListener('change', () => {
  prefs.omrServer = el.omrServer.value.trim();
  savePrefs();
  void refreshServerStatus(el.omrServerStatus);
});
el.showTicks.addEventListener('change', () => {
  prefs.showTicks = el.showTicks.checked;
  savePrefs();
  imageView.setShowRecognized(prefs.showTicks);
});
el.bpm.addEventListener('change', () => {
  const bpm = currentBpm();
  el.bpm.value = String(Math.round(bpm));
  follower?.setScoreTempo(bpm);
  progress?.setOptions({ scoreBpm: bpm });
  scorePrefs.bpm = Math.round(bpm);
  if (currentId) lib.savePrefs(currentId, scorePrefs);
  updateDock();
});
/** "6:30", "6분 30초", "390" 같은 입력 → 초 */
function parseDuration(text: string): number | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const mmss = /^(\d+)\s*[:분]\s*(\d{1,2})\s*초?$/.exec(t);
  if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2]);
  const min = /^(\d+(?:\.\d+)?)\s*분$/.exec(t);
  if (min) return Number(min[1]) * 60;
  const sec = /^(\d+)\s*초?$/.exec(t);
  return sec ? Number(sec[1]) : undefined;
}
el.expected.addEventListener('change', () => {
  const sec = parseDuration(el.expected.value);
  if (el.expected.value.trim() && sec === undefined) {
    toast('예상 연주 시간은 "6:30" 처럼 적어 주세요.');
    return;
  }
  scorePrefs.expectedSec = sec;
  el.expected.value = sec ? formatDuration(sec) : '';
  progress?.setOptions({ expectedTotalSec: sec });
  if (currentId) lib.savePrefs(currentId, scorePrefs);
  updateDock();
});

document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('input, textarea, select, dialog') || e.metaKey || e.ctrlKey || e.altKey) return;
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
/** 노트북용 앱으로 열렸으면 "앱 끄기"를, 아니면 "노트북용 앱 받기"를 보여 준다. */
async function setupAppMode(): Promise<void> {
  el.getAppWin.href = LAPTOP_APP.windows;
  el.getAppMac.href = LAPTOP_APP.mac;
  el.getAppPage.href = LAPTOP_APP.page;
  const st = await checkServer(prefs.omrServer);
  el.quitRow.hidden = !st.desktop;
  el.getApp.hidden = st.ok;
}
el.quitApp.addEventListener('click', async () => {
  if (!confirm('Read Classic 을 끌까요? 다시 쓰려면 바탕화면(또는 응용 프로그램)의 아이콘을 누르세요.')) return;
  stopListening();
  try {
    await fetch('/api/shutdown', { method: 'POST' });
  } catch {
    /* 이미 꺼짐 */
  }
  document.body.innerHTML =
    '<main style="font:16px/1.6 system-ui,sans-serif;padding:48px 24px;text-align:center"><h1 style="font-size:22px">Read Classic 을 껐어요</h1><p>이 창은 닫아도 됩니다. 다시 쓰려면 아이콘을 누르세요.</p></main>';
});

async function init(): Promise<void> {
  void setupAppMode();
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
  get kind() {
    return loaded?.kind ?? null;
  },
  get listening() {
    return mic !== null;
  },
  get progress() {
    return snap;
  },
};
