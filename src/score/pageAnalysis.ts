/**
 * 악보 쪽 그림 살펴보기: 오선(같은 간격의 가는 가로줄 5개)이 어디에 몇 개 있는지 찾는다.
 *
 * - PDF 의 표지·머리말·해설처럼 악보가 없는 쪽을 골라내 인식 시간을 아끼고 엉뚱한 음이 섞이지 않게 한다.
 * - 인식 결과와 견줘서 "6줄 중 4줄만 읽었다" 같은 품질 경고를 낸다.
 *
 * 쪽을 세로 띠 여러 개로 나눠 띠마다 가로 투영(행별 잉크 비율)을 보고, 가늘고 뚜렷한 가로줄이
 * 같은 간격으로 4~5개 이어지는 곳을 오선으로 본다. 살짝 기운 쪽도 띠가 좁아서 견딘다.
 * 두 개 이상의 띠에서 같은 높이에 나오면 하나의 오선으로 인정한다 (글자 줄을 오선으로 착각하지 않게).
 */

export interface Staff {
  /** 오선 가운데 높이 (쪽 높이에 대한 비율) */
  y: number;
  /** 오선 높이 (첫 줄~다섯째 줄, 쪽 높이에 대한 비율) */
  height: number;
}

export interface PageAnalysis {
  staves: Staff[];
  /** 악보가 있는 쪽인지 (오선이 2개 이상) */
  music: boolean;
  /** 아무것도 그려지지 않은 쪽 (빈 쪽이거나, PDF 안의 그림을 풀지 못함) */
  blank?: boolean;
}

/** 분석할 때 쓰는 가로 폭 (이보다 크면 줄여서 본다) */
export const ANALYSIS_WIDTH = 1200;
const STRIPS = 10;
const MIN_COVER = 0.2; // 띠 안에서 줄이 차지해야 하는 비율 (흐린 스캔은 오선이 끊겨 있다)

/** 종이 색: 밝은 쪽에서 가장 흔한 밝기 */
function paperLevel(gray: ArrayLike<number>): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  let paper = 255;
  for (let v = 128; v < 256; v++) if (hist[v] > hist[paper]) paper = v;
  return paper;
}

/** 띠 하나에서 가는 가로줄이 있는 행들 */
function lineRows(cov: Float64Array): number[] {
  const rows: number[] = [];
  const n = cov.length;
  for (let y = 2; y < n - 2; y++) {
    const c = cov[y];
    if (c < MIN_COVER || c < cov[y - 1] || c <= cov[y + 1]) continue;
    // 가늘어야 한다: 두 행 위아래는 훨씬 비어 있어야 (음표 머리·빔 같은 굵은 덩어리는 제외)
    if (c < 1.5 * Math.max(cov[y - 2], cov[y + 2])) continue;
    rows.push(y);
  }
  return rows;
}

/**
 * 줄 사이(칸)가 비어 있는지: 오선은 칸이 대부분 비어 있지만, 글자 줄은 줄 사이가 글자로 차 있다.
 * 칸 가운데 부분의 평균 잉크 비율이 줄의 40% 아래여야 한다.
 */
function gapsAreOpen(cov: Float64Array, g: number[]): boolean {
  let lines = 0;
  for (const y of g) lines += cov[y];
  lines /= g.length;
  let gap = 0;
  let n = 0;
  for (let i = 0; i + 1 < g.length; i++) {
    for (let y = g[i] + 2; y <= g[i + 1] - 2; y++) {
      gap += cov[y];
      n++;
    }
  }
  return n === 0 || gap / n <= 0.4 * lines;
}

/**
 * 같은 간격으로 바로바로 이어지는 줄 4~5개 묶음 → [첫 줄, 줄 간격].
 * 사이에 다른 가는 줄이 끼어 있으면 오선이 아니다 (글자 줄은 윗선·밑선이 번갈아 나온다).
 */
function staffGroups(rows: number[], cov: Float64Array): Array<[number, number]> {
  const groups: Array<[number, number]> = [];
  let i = 0;
  while (i + 3 < rows.length) {
    let s = rows[i + 1] - rows[i];
    const g = [rows[i]];
    let k = i + 1;
    if (s >= 4 && s <= 40) {
      g.push(rows[k]);
      while (g.length < 5 && k + 1 < rows.length) {
        const want = g[g.length - 1] + s;
        if (Math.abs(rows[k + 1] - want) > Math.max(1.5, s * 0.15)) break;
        g.push(rows[++k]);
        s = (g[g.length - 1] - g[0]) / (g.length - 1);
      }
    }
    if (g.length >= 4 && gapsAreOpen(cov, g)) {
      groups.push([g[0], s]);
      i = k + 1;
    } else {
      i++;
    }
  }
  return groups;
}

/**
 * 회색조 그림(0=검정, 255=흰색)에서 오선을 찾는다.
 * @param gray 가로 width, 세로 height 의 밝기 값
 */
export function analyzeGray(gray: ArrayLike<number>, width: number, height: number): PageAnalysis {
  // 잉크 정도: 종이보다 120 이상 어두우면 1. 줄이 점선처럼 끊기거나 줄여서 옅어진 오선도 띠 평균으로는 드러난다.
  const paper = paperLevel(gray);
  const inkOf = new Float64Array(256);
  for (let v = 0; v < 256; v++) inkOf[v] = Math.min(1, Math.max(0, (paper - 12 - v) / 108));
  const stripW = Math.floor(width / STRIPS);
  // 띠마다 찾은 오선: [가운데 y, 줄 간격]
  const found: Array<{ y: number; s: number; strip: number }> = [];
  const cov = new Float64Array(height);
  for (let k = 0; k < STRIPS; k++) {
    const x0 = k * stripW;
    const x1 = k === STRIPS - 1 ? width : x0 + stripW;
    for (let y = 0; y < height; y++) {
      let dark = 0;
      const row = y * width;
      for (let x = x0; x < x1; x++) dark += inkOf[gray[row + x]];
      cov[y] = dark / (x1 - x0);
    }
    for (const [y0, s] of staffGroups(lineRows(cov), cov)) found.push({ y: y0 + 2 * s, s, strip: k });
  }
  // 띠마다 찾은 것을 높이로 묶는다 (오선 하나의 높이 안이면 같은 오선). 띠 두 개 이상에서 나온 것만 오선으로.
  found.sort((a, b) => a.y - b.y);
  const staves: Staff[] = [];
  let i = 0;
  while (i < found.length) {
    const group = [found[i]];
    let j = i + 1;
    const mean = () => group.reduce((a, g) => a + g.y, 0) / group.length;
    while (j < found.length && found[j].y - mean() <= 2.5 * found[j].s) group.push(found[j++]);
    if (new Set(group.map((g) => g.strip)).size >= 2) {
      const ys = group.map((g) => g.y).sort((a, b) => a - b);
      const s = group.map((g) => g.s).sort((a, b) => a - b)[group.length >> 1];
      staves.push({ y: ys[ys.length >> 1] / height, height: (4 * s) / height });
    }
    i = j;
  }
  // 잉크가 거의 없는 쪽: 빈 쪽 (스캔 그림을 풀지 못하면 이렇게 된다)
  let ink = 0;
  for (let i = 0; i < gray.length; i += 7) if (inkOf[gray[i]] > 0.5) ink++;
  const blank = ink / Math.ceil(gray.length / 7) < 0.0005;
  return { staves, music: staves.length >= 2, blank };
}

/** 캔버스(쪽 그림)를 분석용 크기로 줄여서 살펴본다. */
export function analyzeCanvas(canvas: HTMLCanvasElement): PageAnalysis {
  const scale = Math.min(1, ANALYSIS_WIDTH / canvas.width);
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  const small = document.createElement('canvas');
  small.width = w;
  small.height = h;
  const ctx = small.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const gray = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  return analyzeGray(gray, w, h);
}

/**
 * 인식 결과(줄마다 상자 [cx, cy, w, h], 쪽 크기 비율)가 찾아 둔 오선을 얼마나 덮는지.
 * 덮지 못한 오선이 있으면 그 줄을 읽지 못한 것이다.
 */
export function coveredStaves(staves: Staff[], boxes: number[][]): number {
  return staves.filter((st) => boxes.some(([, cy, , h]) => Math.abs(st.y - cy) <= h / 2 + st.height * 0.5)).length;
}

/**
 * 처음에 인식할 쪽: 악보가 보이는 쪽만. 단, 악보로 보이는 쪽이 너무 적으면(흐린 스캔 등 오선을 못 찾는 PDF)
 * 판별을 믿을 수 없으므로 모든 쪽을 넣는다.
 */
export function defaultInclusion(pages: Array<PageAnalysis | undefined>): boolean[] {
  const known = pages.filter((p): p is PageAnalysis => !!p && !p.blank);
  const music = known.filter((p) => p.music).length;
  if (known.length === 0 || music < Math.max(1, 0.2 * known.length)) return pages.map((p) => !p?.blank);
  return pages.map((p) => !p || p.music);
}
