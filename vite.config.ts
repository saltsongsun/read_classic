import { defineConfig } from 'vitest/config';

export default defineConfig({
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
