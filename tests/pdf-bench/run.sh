#!/bin/sh
# PDF 인식 품질 측정: 시험 PDF 만들기 → 앱처럼 쪽 그림으로 → homr 로 인식 → 정답과 비교
#   sh tests/pdf-bench/run.sh <작업 폴더> [homr 명령]
# 결과 예 (homr 0.7.0): 깨끗한 PDF·300dpi 스캔 음높이 96%, 150dpi 잡음 스캔은 오선이 끊겨 크게 떨어진다.
set -e
OUT=$(cd "$1" && pwd)
HOMR=${2:-homr}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
node "$HERE/make-pdf.cjs" "$OUT"
SCAN_DPR=3 SCAN_W=2480 SCAN_BLUR=1.2 SCAN_NOISE=50 SCAN_NAME=scan300.pdf node "$HERE/make-pdf.cjs" "$OUT"
cp "$HERE/render.html" "$OUT/"
ln -sfn "$ROOT/node_modules/pdfjs-dist" "$OUT/pdfjs"
(cd "$OUT" && python3 -m http.server 47970 --bind 127.0.0.1 >/dev/null 2>&1) &
SRV=$!
sleep 1
for pdf in clean scan300; do
  rm -rf "$OUT/$pdf"
  node "$HERE/render.cjs" "$pdf.pdf" 2000 "$OUT/$pdf"
  $HOMR --write-staff-positions "$OUT/$pdf" > "$OUT/$pdf.log" 2>&1 || true
  (cd "$ROOT" && BENCH_DIR="$OUT/$pdf" BENCH_LAYOUT="$OUT/layout.json" npx vitest run tests/pdf-bench.test.ts --disable-console-intercept)
done
kill $SRV
