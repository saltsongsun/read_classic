// PDF 인식 품질 측정 (개발용, BENCH_DIR 가 있을 때만): 정답을 아는 예제 악보로 만든 PDF 를
// 쪽 그림으로 바꿔 homr 로 인식한 결과(쪽마다 pNN.musicxml)를 정답과 비교한다.
//   sh tests/pdf-bench/run.sh <작업 폴더>   (시험 PDF 만들기부터 인식·비교까지)
import { DOMParser } from '@xmldom/xmldom';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { eventsFromSteps, parsePages, toSteps, type XmlParser } from '../src/score/musicxml';
import { loadSample, run, type SampleScore } from './harness';

const dir = process.env.BENCH_DIR;
const parser = new DOMParser() as unknown as XmlParser;

function pitchAgreement(x: string[], y: string[]): number {
  const d: number[][] = Array.from({ length: x.length + 1 }, (_, i) => [i, ...new Array(y.length).fill(0)]);
  for (let j = 1; j <= y.length; j++) d[0][j] = j;
  for (let i = 1; i <= x.length; i++)
    for (let j = 1; j <= y.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
  return 1 - d[x.length][y.length] / Math.max(x.length, y.length);
}
const keyOf = (s: SampleScore) => s.events.map((e) => [...new Set(e.notes.map((m) => m % 12))].sort().join(','));

test.skipIf(!dir)('pdf benchmark', () => {
  const layout = JSON.parse(readFileSync(process.env.BENCH_LAYOUT!, 'utf8')) as { pieces: string[]; pagesPerPiece: number[]; coverPages: number };
  const file = (p: number) => join(dir!, `p${String(p).padStart(2, '0')}.musicxml`);
  const lines: string[] = [];
  let page = 1;
  for (let c = 0; c < layout.coverPages; c++, page++) {
    lines.push(`cover p${page}: ${existsSync(file(page)) ? 'RECOGNISED (bad)' : 'skipped'}`);
  }
  let sumAgree = 0;
  let sumMeasure = 0;
  layout.pieces.forEach((id, k) => {
    const truth = loadSample(id);
    const xmls: string[] = [];
    for (let i = 0; i < layout.pagesPerPiece[k]; i++, page++) xmls.push(existsSync(file(page)) ? readFileSync(file(page), 'utf8') : '');
    const parsed = parsePages(xmls, parser);
    const events = eventsFromSteps(toSteps(parsed), parsed.totalBeats);
    const omr: SampleScore = { ...truth, events };
    const agree = events.length ? pitchAgreement(keyOf(truth), keyOf(omr)) : 0;
    let measureNear = 0;
    if (events.length) {
      const r = run({ ...truth, events }, { timbre: 'piano', reverb: 0.3, pedalBeats: 4, tempoWobble: 0.08, seed: 9 });
      const pts = r.trace.filter((p) => p.truth >= 0);
      measureNear = pts.filter((p) => p.idx >= 0 && Math.abs(events[p.idx].measure - truth.events[p.truth].measure) <= 1).length / pts.length;
    }
    sumAgree += agree;
    sumMeasure += measureNear;
    const truthMeasures = truth.events[truth.events.length - 1].measure;
    lines.push(
      `${id}: events ${events.length}/${truth.events.length}, measures ${parsed.measures.length}/${truthMeasures}, pitch ${(agree * 100).toFixed(1)}%, follow measure±1 ${(measureNear * 100).toFixed(1)}%`,
    );
  });
  lines.push(`MEAN pitch ${((sumAgree / layout.pieces.length) * 100).toFixed(1)}%, follow ${((sumMeasure / layout.pieces.length) * 100).toFixed(1)}%`);
  console.log(`[${dir}]\n` + lines.join('\n'));
});
