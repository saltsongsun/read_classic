import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));

/**
 * PDF 를 그릴 때 pdf.js 가 따로 불러오는 파일들을 public/pdfjs/ 로 복사한다 (빌드 결과에도 들어간다).
 * - wasm: 스캔한 악보 PDF 에 흔한 JBIG2(흑백 스캔)·JPEG2000 그림 해독기. 없으면 그 쪽이 백지로 그려진다.
 * - standard_fonts, cmaps: 글꼴을 넣지 않은 PDF 의 글자
 */
function pdfjsAssets(): Plugin {
  const copy = () => {
    for (const dir of ['wasm', 'standard_fonts', 'cmaps', 'iccs']) {
      const src = join(root, 'node_modules', 'pdfjs-dist', dir);
      const dst = join(root, 'public', 'pdfjs', dir);
      if (!existsSync(src)) continue;
      mkdirSync(dst, { recursive: true });
      cpSync(src, dst, { recursive: true });
    }
  };
  return { name: 'pdfjs-assets', buildStart: copy, configureServer: copy };
}

/** AI 음 인식 실행기(onnxruntime-web 의 wasm)를 public/ort/ 로 복사한다 */
function ortAssets(): Plugin {
  const copy = () => {
    const src = join(root, 'node_modules', 'onnxruntime-web', 'dist');
    const dst = join(root, 'public', 'ort');
    mkdirSync(dst, { recursive: true });
    for (const f of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']) {
      if (existsSync(join(src, f))) cpSync(join(src, f), join(dst, f));
    }
  };
  return { name: 'ort-assets', buildStart: copy, configureServer: copy };
}

export default defineConfig({
  plugins: [pdfjsAssets(), ortAssets()],
  worker: { format: 'es' },
  // 개발 서버가 처음 쓰는 순간에 미리 묶느라 페이지를 새로 고치지 않게
  optimizeDeps: { include: ['onnxruntime-web/wasm', 'pdfjs-dist'] },
  // GitHub Pages 등 하위 경로에 올려도 동작하도록 상대 경로로 빌드
  base: './',
  server: {
    // 개발 중에는 악보 인식 서버(python server/app.py, 기본 8000번)로 /api 요청을 넘긴다
    proxy: { '/api': process.env.OMR_URL ?? 'http://localhost:8000' },
  },
  build: {
    // 악보 렌더러(OpenSheetMusicDisplay + VexFlow)가 커서 한 덩어리로 둔다
    chunkSizeWarningLimit: 2000,
  },
  test: {
    // npm run report → 정확도 리포트, 그 외에는 회귀 테스트
    include: process.env.REPORT
      ? ['tests/report/*.test.ts']
      : process.env.E2E_PREP
        ? ['tests/e2e/*.test.ts']
        : ['tests/*.test.ts'],
    testTimeout: 120000,
  },
});
