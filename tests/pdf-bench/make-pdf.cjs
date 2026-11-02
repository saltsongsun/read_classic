// PDF 인식 시험용: 정답을 아는 예제 악보(MusicXML)를 OSMD 로 A4 쪽에 빽빽하게 그려 PDF 로 만든다 (표지·머리말 쪽 포함).
// 같은 쪽을 스캔한 것처럼(살짝 기울고, 흐리고, 잡음, 흑백) 만든 PDF 도 만든다.
//   node make-pdf.cjs <폴더>                     → clean.pdf, scan.pdf, layout.json
//   SCAN_DPR=3 SCAN_W=2480 SCAN_BLUR=1.2 SCAN_NOISE=50 SCAN_NAME=scan300.pdf node make-pdf.cjs <폴더>   (300dpi 스캔)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const out = process.argv[2];
(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: Number(process.env.SCAN_DPR || 1) });
  await page.setContent(`<html><head><style>
    @page { size: A4; margin: 0 }
    body { margin: 0; font-family: serif }
    .pg { width: 794px; height: 1123px; box-sizing: border-box; padding: 40px 30px; page-break-after: always; overflow: hidden; background: #fff }
    .cover h1 { font-size: 40px; text-align: center; margin-top: 280px } .cover p { text-align: center; font-size: 20px }
    .text p { font-size: 15px; line-height: 1.6; text-align: justify }
  </style></head><body></body></html>`);
  await page.addScriptTag({ path: path.join(root, 'node_modules/opensheetmusicdisplay/build/opensheetmusicdisplay.min.js') });
  const xml = (id) => fs.readFileSync(path.join(root, 'public/samples', id + '.musicxml'), 'utf8');
  const pieces = (process.env.PIECES || 'bach-prelude-c,ode-to-joy,twinkle').split(',');
  const layout = await page.evaluate(async ({ pieces, xmls }) => {
    const body = document.body;
    const cover = document.createElement('div');
    cover.className = 'pg cover';
    cover.innerHTML = '<h1>Klavierstücke</h1><p>Urtext · Edition for testing</p><p>© public domain</p>';
    body.append(cover);
    const text = document.createElement('div');
    text.className = 'pg text';
    text.innerHTML = '<h2>Vorwort / Preface</h2>' + Array.from({ length: 9 }, () => '<p>' + 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. '.repeat(2) + '</p>').join('');
    body.append(text);
    const pagesPerPiece = [];
    for (let i = 0; i < pieces.length; i++) {
      const holder = document.createElement('div');
      holder.style.width = '734px';
      body.append(holder);
      const osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay(holder, { backend: 'svg', autoResize: false, pageFormat: 'A4_P', drawPartNames: false, pageBackgroundColor: '#FFFFFF' });
      await osmd.load(xmls[i]);
      osmd.Zoom = 0.62;
      osmd.render();
      const svgs = [...holder.querySelectorAll('svg')];
      pagesPerPiece.push(svgs.length);
      for (const svg of svgs) {
        const pg = document.createElement('div');
        pg.className = 'pg';
        pg.style.padding = '0';
        svg.setAttribute('width', '794');
        svg.removeAttribute('height');
        svg.style.width = '794px';
        svg.style.height = 'auto';
        pg.append(svg);
        body.insertBefore(pg, holder);
      }
      holder.remove();
    }
    return pagesPerPiece;
  }, { pieces, xmls: pieces.map(xml) });
  fs.writeFileSync(path.join(out, 'layout.json'), JSON.stringify({ pieces, pagesPerPiece: layout, coverPages: 2 }));
  await page.pdf({ path: path.join(out, 'clean.pdf'), format: 'A4', printBackground: true, preferCSSPageSize: true });

  // 스캔본 흉내: 쪽마다 그림으로 찍어 기울이고 흐리게 + 잡음 + 흑백 → 그림 PDF
  const n = await page.evaluate(() => document.querySelectorAll('.pg').length);
  const shots = [];
  for (let i = 0; i < n; i++) {
    const el = (await page.$$('.pg'))[i];
    shots.push((await el.screenshot({ type: 'png', scale: 'device' })).toString('base64'));
  }
  const scan = await b.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 1 });
  const imgs = await scan.evaluate(async ({ shots, SW, SB, SN }) => {
    const res = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const [k, s] of shots.entries()) {
      const img = new Image();
      img.src = 'data:image/png;base64,' + s;
      await img.decode();
      const W = SW, H = Math.round(W * 1.4142); // A4
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#f4f1ea'; ctx.fillRect(0, 0, W, H);
      ctx.translate(W / 2, H / 2);
      ctx.rotate(((k % 2 ? -1 : 1) * (0.6 + rnd() * 0.8) * Math.PI) / 180);
      ctx.filter = `blur(${SB}px)`;
      ctx.drawImage(img, -W / 2 + 10, -H / 2 + 14, W, H);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.filter = 'none';
      const d = ctx.getImageData(0, 0, W, H);
      for (let i = 0; i < d.data.length; i += 4) {
        const g = 0.3 * d.data[i] + 0.59 * d.data[i + 1] + 0.11 * d.data[i + 2] + (rnd() - 0.5) * SN;
        const v = g < 150 ? 25 : 245;
        d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
      }
      ctx.putImageData(d, 0, 0);
      res.push(c.toDataURL('image/png'));
    }
    return res;
  }, { shots, SW: Number(process.env.SCAN_W || 1654), SB: Number(process.env.SCAN_BLUR || 0.8), SN: Number(process.env.SCAN_NOISE || 60) });
  await scan.setContent(`<html><head><style>@page{size:A4;margin:0}body{margin:0}img{width:794px;height:1123px;display:block;page-break-after:always}</style></head><body>${imgs.map((u) => `<img src="${u}">`).join('')}</body></html>`);
  await scan.pdf({ path: path.join(out, process.env.SCAN_NAME || 'scan.pdf'), format: 'A4', printBackground: true, preferCSSPageSize: true });
  console.log('pages', n, 'layout', layout);
  await b.close();
})();
