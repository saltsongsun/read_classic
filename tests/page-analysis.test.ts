import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { analyzeGray, coveredStaves, defaultInclusion } from '../src/score/pageAnalysis';

const here = dirname(fileURLToPath(import.meta.url));

/** tests/pages/*.pgm.gz: 쪽 그림을 가로 1200 으로 줄인 회색조 (파일을 작게 하려고 밝기를 4단계로 줄임) */
function load(name: string) {
  const raw = gunzipSync(readFileSync(join(here, 'pages', `${name}.pgm.gz`)));
  const text = raw.subarray(0, 40).toString('latin1');
  const m = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(text)!;
  const [w, h] = [Number(m[1]), Number(m[2])];
  return { gray: raw.subarray(m[0].length), w, h };
}

describe('page analysis', () => {
  test.each([
    ['cover', 0],
    ['preface', 0],
    ['bach-clean', 12], // 큰보표 6줄 = 오선 12개
    ['ode-clean', 2],
    ['bach-scan300', 8], // 둘째 쪽: 큰보표 4줄
  ])('%s: %i staves', (name, staves) => {
    const { gray, w, h } = load(name);
    const a = analyzeGray(gray, w, h);
    expect(a.staves.length).toBe(staves);
    expect(a.music).toBe(staves >= 2);
  });

  test('pages without music are left out, unless the whole PDF is too blurry to tell', () => {
    const a = (name: string) => {
      const { gray, w, h } = load(name);
      return analyzeGray(gray, w, h);
    };
    expect(defaultInclusion([a('cover'), a('preface'), a('bach-clean'), a('ode-clean')])).toEqual([false, false, true, true]);
    // 오선이 거의 지워진 저해상도 스캔: 악보로 보이는 쪽이 적으면 판별을 믿지 않고 모두 넣는다
    const blurry = [a('cover'), a('bach-scan150'), a('bach-scan150'), a('bach-scan150'), a('bach-scan150'), a('bach-scan150')].map((p, i) =>
      i === 0 ? p : { ...p, staves: p.staves.slice(0, 1), music: false },
    );
    expect(defaultInclusion(blurry)).toEqual([true, true, true, true, true, true]);
    // 사진(분석 안 함)은 늘 넣는다
    expect(defaultInclusion([undefined, a('bach-clean')])).toEqual([true, true]);
  });

  test('a page that came out blank is never sent for recognition', () => {
    const white = new Uint8Array(1200 * 1700).fill(255);
    const blank = analyzeGray(white, 1200, 1700);
    expect(blank.blank).toBe(true);
    const { gray, w, h } = load('bach-clean');
    expect(analyzeGray(gray, w, h).blank).toBe(false);
    // 모든 쪽이 백지여도 (예전 버그: 스캔 그림을 풀지 못함) 인식하러 보내지 않는다
    expect(defaultInclusion([blank, blank, blank])).toEqual([false, false, false]);
  });

  test('recognised systems are matched against the staves found', () => {
    const { gray, w, h } = load('bach-clean');
    const { staves } = analyzeGray(gray, w, h);
    // homr 가 이 쪽에서 낸 줄 상자 6개 (tests 밖 벤치마크에서 얻은 값)
    const boxes = [0.166, 0.295, 0.425, 0.555, 0.684, 0.817].map((cy) => [0.5, cy, 0.917, 0.088]);
    expect(coveredStaves(staves, boxes)).toBe(12);
    expect(coveredStaves(staves, boxes.slice(0, 4))).toBe(8);
  });
});
