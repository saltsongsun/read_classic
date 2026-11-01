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

const server = await createServer({ root, logLevel: 'error', server: { port: 5199, strictPort: false } });
await server.listen();
const base = server.resolvedUrls.local[0];

const CASES = [
  { id: 'ode-to-joy', minNear: 0.85 },
  { id: 'bach-prelude-c', minNear: 0.8 },
];

let failed = false;
for (const c of CASES) {
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
  await page.goto(`${base}?score=sample:${c.id}`);
  await page.waitForFunction(() => window.__readClassic?.events.length > 0, null, { timeout: 30000 });
  await page.waitForTimeout(500);

  await page.click('#micBtn');
  const t0 = Date.now();
  const samples = [];
  const total = truth.duration + 1.5;
  let shot = false;
  while ((Date.now() - t0) / 1000 < total) {
    const pos = await page.evaluate(() => window.__readClassic.position);
    const t = (Date.now() - t0) / 1000;
    samples.push({ t, pos });
    if (!shot && t > truth.duration * 0.55) {
      await page.screenshot({ path: join(outDir, `${c.id}-playing.png`) });
      shot = true;
    }
    await page.waitForTimeout(80);
  }
  await page.screenshot({ path: join(outDir, `${c.id}-end.png`) });

  // 마이크 시작 지연을 모르므로 -0.6 ~ +0.8초 사이에서 가장 잘 맞는 지연을 고른다
  const truthAt = (t) => {
    let idx = -1;
    for (const e of truth.timeline) if (e.time <= t) idx = e.index;
    return idx;
  };
  let best = { near: 0, delay: 0 };
  for (let d = -0.6; d <= 0.8; d += 0.05) {
    const considered = samples.filter((s) => truthAt(s.t - d - 0.15) >= 0 && s.t - d < truth.timeline.at(-1).time + 0.3);
    const ok = considered.filter((s) => Math.abs(s.pos - truthAt(s.t - d - 0.15)) <= 1).length;
    const near = considered.length ? ok / considered.length : 0;
    if (near > best.near + 1e-9 || (Math.abs(near - best.near) < 1e-9 && Math.abs(d) < Math.abs(best.delay))) best = { near, delay: d };
  }
  const final = samples.at(-1).pos;
  const last = truth.timeline.length - 1;
  const pass = best.near >= c.minNear && final === last && errors.length === 0;
  failed ||= !pass;
  console.log(
    `${pass ? 'PASS' : 'FAIL'} ${c.id}: ±1음 ${(best.near * 100).toFixed(1)}% (지연 ${best.delay.toFixed(2)}s), 마지막 위치 ${final}/${last}` +
      (errors.length ? `, 페이지 오류: ${errors.join(' | ')}` : ''),
  );
  await browser.close();
}

await server.close();
process.exit(failed ? 1 : 0);
