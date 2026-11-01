// 실제 homr(0.7.0) 인식 결과로 추적이 되는지 확인한다.
// tests/omr/*.musicxml 은 예제 악보를 이미지로 그린 것(그리고 휴대폰 사진처럼 왜곡한 것)을 homr 로 인식한 결과.
import { DOMParser } from '@xmldom/xmldom';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { eventsFromSteps, parseMusicXML, toSteps, type XmlParser } from '../src/score/musicxml';
import { loadSample, run, type SampleScore } from './harness';

const here = dirname(fileURLToPath(import.meta.url));
const parser = new DOMParser() as unknown as XmlParser;

function omrScore(id: string, file: string): SampleScore {
  const truth = loadSample(id);
  const parsed = parseMusicXML(readFileSync(join(here, 'omr', file), 'utf8'), parser);
  return { ...truth, events: eventsFromSteps(toSteps(parsed), parsed.totalBeats) };
}

/** 인식된 이벤트 음높이(음이름 집합) 순서가 정답과 얼마나 같은지 (편집 거리 기반) */
function pitchAgreement(a: SampleScore, b: SampleScore): number {
  const key = (s: SampleScore) => s.events.map((e) => [...new Set(e.notes.map((m) => m % 12))].sort().join(','));
  const x = key(a);
  const y = key(b);
  const d: number[][] = Array.from({ length: x.length + 1 }, (_, i) => [i, ...new Array(y.length).fill(0)]);
  for (let j = 1; j <= y.length; j++) d[0][j] = j;
  for (let i = 1; i <= x.length; i++)
    for (let j = 1; j <= y.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
  return 1 - d[x.length][y.length] / Math.max(x.length, y.length);
}

describe('following a score recognised from an image', () => {
  for (const [id, file] of [
    ['ode-to-joy', 'ode-to-joy.musicxml'],
    ['ode-to-joy', 'ode-to-joy-photo.musicxml'],
    ['bach-prelude-c', 'bach-prelude-c.musicxml'],
    ['bach-prelude-c', 'bach-prelude-c-photo.musicxml'],
  ] as const) {
    test(file, () => {
      const truth = loadSample(id);
      const omr = omrScore(id, file);
      const agree = pitchAgreement(truth, omr);
      // 정답 악보로 합성한 연주를, 인식된 악보로 따라간다 (홀 잔향 + 페달)
      const r = run({ ...truth, events: omr.events }, { timbre: 'piano', reverb: 0.3, pedalBeats: 4, tempoWobble: 0.08, seed: 9 });
      // 인식 악보는 마디 안의 박 위치가 어긋날 수 있어서, 콩쿠르 용도에 맞게 마디 단위로 본다
      const points = r.trace.filter((p) => p.truth >= 0);
      const ok = points.filter((p) => p.idx >= 0 && Math.abs(omr.events[p.idx].measure - truth.events[p.truth].measure) <= 1);
      const measureNear = ok.length / points.length;
      const lastMeasure = omr.events[omr.events.length - 1].measure;
      const finalMeasure = r.finalIndex >= 0 ? omr.events[r.finalIndex].measure : 0;
      console.log(
        `${file}: 인식 이벤트 ${omr.events.length}/${truth.events.length}, 음높이 일치 ${(agree * 100).toFixed(1)}%, ` +
          `마디 ±1 ${(measureNear * 100).toFixed(1)}%, 마지막 마디 ${finalMeasure}/${lastMeasure}`,
      );
      expect(agree).toBeGreaterThan(0.85);
      expect(measureNear).toBeGreaterThan(0.85);
      expect(finalMeasure).toBe(lastMeasure);
    });
  }
});
