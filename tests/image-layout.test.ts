import { DOMParser } from '@xmldom/xmldom';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { layoutEvents, type PageInfo } from '../src/score/imageLayout';
import { combinePages, eventsFromSteps, parseMusicXML, toSteps, type XmlParser } from '../src/score/musicxml';

const here = dirname(fileURLToPath(import.meta.url));
const parser = new DOMParser() as unknown as XmlParser;
const staffs = (name: string) =>
  readFileSync(join(here, 'omr', name), 'utf8')
    .trim()
    .split('\n')
    .map((l) => l.split(' ').slice(1).map(Number));

describe('layoutEvents with real homr output (no per-note positions)', () => {
  const xml = readFileSync(join(here, 'omr', 'ode-to-joy-photo.musicxml'), 'utf8');
  const score = combinePages([parseMusicXML(xml, parser, 0)]);
  const steps = toSteps(score);
  const events = eventsFromSteps(steps, score.totalBeats);
  // 사진 크기 (tests/omr/ode-to-joy-photo.jpg)
  const pages: PageInfo[] = [{ width: 2150, height: 1264, staffs: staffs('ode-to-joy-photo.txt') }];
  const geo = layoutEvents(score, steps, events, pages);

  test('measures are assigned to the three recognised systems', () => {
    expect(score.measures.map((m) => m.system)).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2]);
  });

  test('each note marker sits inside its system box and moves left to right', () => {
    const sys = pages[0].staffs.map(([, cy, , h]) => [cy - h / 2, cy + h / 2]);
    geo.forEach((g, i) => {
      const m = score.measures[events[i].measure - 1];
      expect(g.y0).toBeCloseTo(sys[m.system][0], 5);
      expect(g.y1).toBeCloseTo(sys[m.system][1], 5);
      expect(g.x).toBeGreaterThanOrEqual(g.measure.x0);
      expect(g.x).toBeLessThanOrEqual(g.measure.x1);
      const prev = geo[i - 1];
      if (prev && events[i - 1].measure !== undefined && score.measures[events[i - 1].measure - 1].system === m.system) {
        expect(g.x).toBeGreaterThan(prev.x);
      }
    });
  });
});

describe('layoutEvents with per-note image positions (newer homr)', () => {
  const xml = `<?xml version="1.0"?><score-partwise><part-list><score-part id="P1"/></part-list><part id="P1">
<measure number="1"><attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes>
<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><!-- imgpos: 200, 100 --></note>
<note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><!-- imgpos: 300, 102 --></note></measure>
<measure number="2"><print new-system="yes"/>
<note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><!-- imgpos: 150, 300 --></note></measure>
</part></score-partwise>`;
  const score = combinePages([parseMusicXML(xml, parser, 0)]);
  const steps = toSteps(score);
  const events = eventsFromSteps(steps, score.totalBeats);
  const geo = layoutEvents(score, steps, events, [{ width: 1000, height: 500, staffs: [[0.5, 0.2, 0.9, 0.1], [0.5, 0.6, 0.9, 0.1]] }]);

  test('uses the exact note positions', () => {
    expect(geo.map((g) => g.x)).toEqual([0.2, 0.3, 0.15]);
    expect(geo[2].y0).toBeCloseTo(0.55, 5);
  });
});
