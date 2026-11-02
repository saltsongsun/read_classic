// 브라우저 종단 테스트: 합성 연주 WAV 를 Chromium 의 가짜 마이크로 흘려 넣고
// 앱의 커서가 악보를 제대로 따라가는지 확인한다.
//
//   npm run e2e            (먼저 tests/fixtures/*.wav 를 만들고 실행)
//
// Playwright(Chromium)가 설치되어 있어야 한다.
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtures = join(root, 'tests', 'fixtures');
const outDir = join(root, 'tests', 'e2e', 'out');
mkdirSync(outDir, { recursive: true });

if (!existsSync(join(fixtures, 'ode-to-joy.wav'))) {
  execSync('npx vitest run', { cwd: root, stdio: 'inherit', env: { ...process.env, E2E_PREP: '1' } });
}

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = await import('playwright'));
}

// 악보 인식 서버: OMR_URL 이 살아 있으면 그걸 쓰고 (실제 homr), 아니면 저장된 실제 인식 결과를
// 돌려주는 대역으로 server/app.py 를 띄운다 (python 에 fastapi 가 있어야 함).
import { spawn } from 'node:child_process';
let omrUrl = process.env.OMR_URL ?? 'http://localhost:8000';
let omrProc = null;
async function alive(url) {
  try {
    return (await fetch(`${url}/api/health`)).ok;
  } catch {
    return false;
  }
}
if (!(await alive(omrUrl))) {
  omrUrl = 'http://localhost:8765';
  const python = process.env.PYTHON ?? 'python3';
  omrProc = spawn(python, ['-m', 'uvicorn', 'server.app:app', '--port', '8765'], {
    cwd: root,
    env: { ...process.env, STATIC_DIR: '/nonexistent', HOMR_CMD: `${python} ${join(root, 'tests', 'e2e', 'replay_homr.py')}` },
    stdio: 'ignore',
  });
  for (let i = 0; i < 40 && !(await alive(omrUrl)); i++) await new Promise((r) => setTimeout(r, 250));
}
const omrReady = await alive(omrUrl);
console.log(omrReady ? `악보 인식 서버: ${omrUrl}` : '악보 인식 서버를 띄우지 못해 사진 악보 시험은 건너뜁니다 (fastapi 필요)');
process.env.OMR_URL = omrUrl;

const server = await createServer({ root, logLevel: 'error', server: { port: 5199, strictPort: false, proxy: { '/api': omrUrl } } });
await server.listen();
const base = server.resolvedUrls.local[0];

// mode: 'notes' = 음을 듣고 따라가기, 'beats' = 마디·박자로 계산 (앱 기본)
const CASES = [
  { id: 'ode-to-joy', mode: 'notes', minNear: 0.85 },
  { id: 'bach-prelude-c', mode: 'notes', minNear: 0.8 },
  // AI 음 인식(88건반)을 켜고: 웹 워커 + wasm 모델이 실제 브라우저에서 돌아가는지
  { id: 'bach-prelude-c', mode: 'notes', ai: true, minNear: 0.8 },
  // 마디·박자로 계산: 예상 연주 시간만 알면 음을 듣지 않고도 마디·남은 시간이 맞아야 한다
  // (합성 연주는 악보 빠르기의 90% 에 ±8% 흔들림)
  { id: 'ode-to-joy', mode: 'beats', minMeasure: 0.85 },
  { id: 'bach-prelude-c', mode: 'beats', minMeasure: 0.85 },
  // 사진 악보: 업로드 → 인식 서버 → 원본 사진 위에서 따라가기, 남은 시간
  { id: 'ode-to-joy', mode: 'notes', photo: 'tests/omr/ode-to-joy-photo.jpg', minMeasure: 0.85 },
];

let failed = false;
for (const c of CASES) {
  if (c.photo && !omrReady) continue;
  const wav = join(fixtures, `${c.id}.wav`);
  const truth = JSON.parse(readFileSync(join(fixtures, `${c.id}.json`), 'utf8'));
  const browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}%noloop`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['microphone'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(c.photo ? base : `${base}?score=sample:${c.id}`);
  await page.waitForFunction(() => window.__readClassic?.events.length > 0, null, { timeout: 30000 });
  if (c.photo) {
    await page.setInputFiles('#fileInput', [join(root, c.photo)]);
    await page.waitForFunction(() => document.querySelectorAll('#importPages li').length === 1, null, { timeout: 20000 });
    await page.fill('#importTitle', 'e2e 사진 악보');
    await page.click('#importStart');
    await page.waitForFunction(() => window.__readClassic.kind === 'image', null, { timeout: 180000 });
  }
  if (c.photo || c.mode === 'beats') {
    // 끝나기 10초 전에 알림
    await page.evaluate(() => {
      const i = document.getElementById('alertSec');
      i.value = '10';
      i.dispatchEvent(new Event('change'));
    });
  }
  await page.click('#settingsToggle');
  await page.selectOption('#followMode', c.mode);
  if (c.ai) await page.check('#ai');
  if (c.mode === 'beats') {
    // 예상 연주 시간 = 악보 빠르기대로의 길이 ÷ 0.9 (합성 연주 빠르기)
    await page.waitForFunction(() => window.__readClassic.progress?.scoreTotalSec > 0, null, { timeout: 10000 });
    const nominal = await page.evaluate(() => window.__readClassic.progress.scoreTotalSec);
    const sec = Math.round(nominal / 0.9);
    c.expected = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    await page.fill('#expected', c.expected);
    await page.dispatchEvent('#expected', 'change');
  }
  await page.click('#settingsToggle');
  await page.waitForTimeout(500);

  await page.click('#micBtn');
  let sawAi = false;
  const t0 = Date.now();
  const samples = [];
  const total = truth.duration + 1.5;
  let shot = false;
  while ((Date.now() - t0) / 1000 < total + (c.photo ? 3 : 0)) {
    const st = await page.evaluate(() => ({
      status: document.getElementById('status').textContent,
      pos: window.__readClassic.position,
      measure: window.__readClassic.measure,
      progress: window.__readClassic.progress,
      ending: document.getElementById('dock').classList.contains('ending'),
    }));
    const t = (Date.now() - t0) / 1000;
    if (/AI 음 인식/.test(st.status ?? '')) sawAi = true;
    samples.push({ t, ...st });
    if (!shot && t > truth.duration * 0.55) {
      await page.screenshot({ path: join(outDir, `${c.id}-playing.png`) });
      shot = true;
    }
    await page.waitForTimeout(80);
  }
  await page.screenshot({ path: join(outDir, `${c.id}-end.png`) });

  // 마이크 시작 지연을 모르므로 -0.6 ~ +1.2초 사이에서 가장 잘 맞는 지연을 고른다 (AI 음 인식은 0.3~0.5초 늦다)
  const truthAt = (t) => {
    let idx = -1;
    for (const e of truth.timeline) if (e.time <= t) idx = e.index;
    return idx;
  };
  let best = { near: 0, delay: 0 };
  // AI 음 인식은 기기가 붐비면 더 늦을 수 있어 2초까지 본다
  for (let d = -0.6; d <= (c.ai ? 2.0 : 1.2); d += 0.05) {
    const considered = samples.filter((s) => truthAt(s.t - d - 0.15) >= 0 && s.t - d < truth.timeline.at(-1).time + 0.3);
    const ok = considered.filter((s) => Math.abs(s.pos - truthAt(s.t - d - 0.15)) <= 1).length;
    const near = considered.length ? ok / considered.length : 0;
    if (near > best.near + 1e-9 || (Math.abs(near - best.near) < 1e-9 && Math.abs(d) < Math.abs(best.delay))) best = { near, delay: d };
  }
  if (c.photo || c.mode === 'beats') {
    // 사진 악보는 인식된 음 번호가 원본과 다를 수 있어, 마디·박자 계산은 음 단위로 맞추지 않아 마디로 비교한다
    const measureAt = (t) => {
      let m = 0;
      for (const e of truth.timeline) if (e.time <= t) m = e.measure;
      return m;
    };
    const d = best.delay;
    const considered = samples.filter((s) => measureAt(s.t - d - 0.15) > 0 && s.t - d < truth.timeline.at(-1).time + 0.3);
    const ok = considered.filter((s) => s.measure !== null && Math.abs(s.measure - measureAt(s.t - d - 0.15)) <= 1);
    const measureNear = ok.length / considered.length;
    const lastMeasure = truth.timeline.at(-1).measure;
    // 마지막 음이 끝나는 때 (합성 소리는 마지막 음 뒤 1.6초 울림이 이어진다)
    const endT = c.photo ? truth.timeline.at(-1).time + 1.2 : truth.duration - 1.6;
    const start = truth.timeline[0].time;
    const remErr = [0.5, 0.75].map((f) => {
      const t = d + start + f * (endT - start);
      const s = samples.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
      return Math.abs((s.progress?.remainingSec ?? 0) - (endT + d - s.t)) / (endT - start);
    });
    // '곧 끝나요'는 마지막 10초 무렵에만 나와야 한다
    const sawEnding = samples.some((s) => s.ending && s.t > d + endT - 14) && !samples.some((s) => s.ending && s.t < d + endT - 16);
    const finished = samples.at(-1).progress?.finished;
    const pass = measureNear >= c.minMeasure && samples.at(-1).measure === lastMeasure && remErr.every((e) => e < 0.15) && sawEnding && finished && errors.length === 0;
    failed ||= !pass;
    console.log(
      `${pass ? 'PASS' : 'FAIL'} ${c.photo ? '사진 악보' : `마디·박자 계산 (예상 ${c.expected})`} ${c.id}: 마디 ±1 ${(measureNear * 100).toFixed(1)}%, 마지막 마디 ${samples.at(-1).measure}/${lastMeasure}, ` +
        `남은 시간 오차 ${remErr.map((e) => (e * 100).toFixed(0) + '%').join('/')} (곡 길이 대비, 50%/75% 지점), '곧 끝나요' ${sawEnding ? '표시됨' : '없음'}, 연주 끝 ${finished ? '인식' : '못 함'}` +
        (errors.length ? `, 페이지 오류: ${errors.join(' | ')}` : ''),
    );
    await browser.close();
    continue;
  }
  const final = samples.at(-1).pos;
  const last = truth.timeline.length - 1;
  const pass = best.near >= c.minNear && final === last && errors.length === 0 && (!c.ai || sawAi);
  failed ||= !pass;
  console.log(
    `${pass ? 'PASS' : 'FAIL'} ${c.id}${c.ai ? ` (AI 음 인식 ${sawAi ? '동작' : '안 됨'})` : ''}: ±1음 ${(best.near * 100).toFixed(1)}% (지연 ${best.delay.toFixed(2)}s), 마지막 위치 ${final}/${last}` +
      (errors.length ? `, 페이지 오류: ${errors.join(' | ')}` : ''),
  );
  await browser.close();
}

// 여러 쪽 중 한 쪽을 읽지 못해도 나머지 쪽으로 악보를 만든다
if (omrReady) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.waitForFunction(() => window.__readClassic?.events.length > 0, null, { timeout: 30000 });
  // 아무것도 없는 흰 쪽 (표지처럼 악보가 없는 쪽)
  const blankB64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 200;
    c.height = 280;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    return c.toDataURL('image/png').split(',')[1];
  });
  const blank = Buffer.from(blankB64, 'base64');
  await page.setInputFiles('#fileInput', [
    { name: 'page1.jpg', mimeType: 'image/jpeg', buffer: readFileSync(join(root, 'tests/omr/ode-to-joy-photo.jpg')) },
    { name: 'blank.png', mimeType: 'image/png', buffer: blank },
  ]);
  await page.waitForFunction(() => document.querySelectorAll('#importPages li').length === 2, null, { timeout: 20000 });
  await page.click('#importStart');
  let toastText = '';
  try {
    await page.waitForFunction(() => /읽지 못했어요/.test(document.getElementById('toast').textContent ?? ''), null, { timeout: 120000 });
    toastText = await page.textContent('#toast');
  } catch {
    toastText = (await page.textContent('#importProgress')) ?? '';
  }
  const st = await page.evaluate(() => ({ kind: window.__readClassic.kind, events: window.__readClassic.events.length }));
  const pass = st.kind === 'image' && st.events > 50 && /2쪽은 읽지 못했어요/.test(toastText) && errors.length === 0;
  failed ||= !pass;
  console.log(
    `${pass ? 'PASS' : 'FAIL'} 한 쪽 인식 실패: 악보 ${st.kind}, 음 ${st.events}개, 알림 "${toastText.trim()}"` +
      (errors.length ? `, 페이지 오류: ${errors.join(' | ')}` : ''),
  );
  await browser.close();
}

// PDF: 표지·머리말 쪽은 오선이 없어 자동으로 빼고 악보 쪽만 인식한다
if (omrReady) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.waitForFunction(() => window.__readClassic?.events.length > 0, null, { timeout: 30000 });
  await page.setInputFiles('#fileInput', join(root, 'tests/pages/cover-and-music.pdf'));
  await page.waitForFunction(() => document.querySelectorAll('#importPages li').length === 3, null, { timeout: 60000 });
  const excluded = await page.$$eval('#importPages li', (ls) => ls.map((l) => l.classList.contains('excluded')));
  // 스캔 악보 PDF(JBIG2·JPEG2000 그림)를 그리는 해독기가 함께 배포되는지
  const wasmOk = await page.evaluate(async () => (await fetch('pdfjs/wasm/jbig2.wasm')).ok && (await fetch('pdfjs/wasm/openjpeg.wasm')).ok);
  await page.click('#importStart');
  let toastText = '';
  try {
    await page.waitForFunction(() => /저장했어요/.test(document.getElementById('toast').textContent ?? ''), null, { timeout: 120000 });
    toastText = await page.textContent('#toast');
  } catch {
    toastText = (await page.textContent('#importProgress')) ?? '';
  }
  const st = await page.evaluate(() => ({ kind: window.__readClassic.kind, events: window.__readClassic.events.length }));
  const pass =
    wasmOk && JSON.stringify(excluded) === JSON.stringify([true, true, false]) && /\(1쪽,/.test(toastText) && st.kind === 'image' && st.events > 50 && errors.length === 0;
  failed ||= !pass;
  console.log(
    `${pass ? 'PASS' : 'FAIL'} PDF 표지 건너뛰기: 스캔 해독기 ${wasmOk ? '있음' : '없음'}, 뺀 쪽 ${JSON.stringify(excluded)}, 악보 ${st.kind}, 음 ${st.events}개, 알림 "${toastText.trim()}"` +
      (errors.length ? `, 페이지 오류: ${errors.join(' | ')}` : ''),
  );
  await browser.close();
}

// 여러 PDF 를 한꺼번에: 파일마다 악보 하나씩, 뒤에서 차례로 인식 (그동안 다른 악보를 열어 둘 수 있다)
if (omrReady) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?score=sample:twinkle`);
  await page.waitForFunction(() => window.__readClassic?.events.length > 0, null, { timeout: 30000 });
  const pdf = readFileSync(join(root, 'tests/pages/cover-and-music.pdf'));
  await page.setInputFiles('#fileInput', [
    { name: '첫째 곡.pdf', mimeType: 'application/pdf', buffer: pdf },
    { name: '둘째 곡.pdf', mimeType: 'application/pdf', buffer: pdf },
  ]);
  // 창이 뜨지 않고 "인식 중" 칸에 두 작업이 생긴다
  await page.waitForFunction(() => document.querySelectorAll('#jobList .job').length === 2, null, { timeout: 30000 });
  const dialogOpen = await page.evaluate(() => document.getElementById('importDialog').open);
  await page.waitForFunction(() => document.querySelectorAll('#jobList .job.done').length === 2, null, { timeout: 240000 }).catch(() => undefined);
  const states = await page.$$eval('#jobList .job', (ls) => ls.map((l) => l.className.replace('job ', '') + ':' + l.querySelector('.job-msg').textContent));
  const titles = await page.$$eval('#userList .lib-title', (ls) => ls.map((l) => l.textContent));
  // 그동안 보던 악보는 그대로 (저절로 바뀌지 않는다)
  const stillTwinkle = await page.evaluate(() => window.__readClassic.events.length < 50);
  const pass =
    !dialogOpen && states.every((x) => x.startsWith('done')) && titles.includes('첫째 곡') && titles.includes('둘째 곡') && stillTwinkle && errors.length === 0;
  failed ||= !pass;
  console.log(
    `${pass ? 'PASS' : 'FAIL'} 여러 PDF 뒤에서 인식: 작업 ${JSON.stringify(states)}, 목록 ${JSON.stringify(titles)}, 보던 악보 그대로 ${stillTwinkle}` +
      (errors.length ? `, 페이지 오류: ${errors.join(' | ')}` : ''),
  );
  await browser.close();
}

await server.close();
omrProc?.kill();
process.exit(failed ? 1 : 0);
