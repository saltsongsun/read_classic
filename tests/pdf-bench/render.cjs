// 앱의 pdfToPages 와 같은 방식으로 PDF 를 쪽 그림으로: node render.cjs <pdf 이름> <가로 폭> <출력 폴더>
// (render.html 과 pdfjs 를 둔 폴더를 http://127.0.0.1:47970 으로 열어 둔 상태에서)
const { chromium } = require('playwright');
const fs = require('fs');
const [, , pdf, width, outDir, type = 'image/jpeg', q = '0.9'] = process.argv;
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto('http://127.0.0.1:47970/render.html');
  await p.waitForFunction(() => window.ready);
  const urls = await p.evaluate(([u, w, t, q]) => window.renderPdf(u, Number(w), t, Number(q)), [pdf, width, type, q]);
  fs.mkdirSync(outDir, { recursive: true });
  urls.forEach((u, i) => fs.writeFileSync(`${outDir}/p${String(i + 1).padStart(2, '0')}.${type === 'image/png' ? 'png' : 'jpg'}`, Buffer.from(u.split(',')[1], 'base64')));
  console.log(outDir, urls.length, 'pages');
  await b.close();
})();
