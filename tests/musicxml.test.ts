import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, test } from 'vitest';
import { combinePages, eventsFromSteps, parseMusicXML, toSteps, type XmlParser } from '../src/score/musicxml';
// @ts-expect-error -- 순수 JS 모듈
import { SCORES, toMusicXML, toRawNotes } from '../samples/scores.mjs';
import { notesToEvents } from './harness';

const parser = new DOMParser() as unknown as XmlParser;

describe('parseMusicXML', () => {
  for (const def of SCORES as Array<{ id: string }>) {
    test(`matches the sample definition: ${def.id}`, () => {
      const parsed = parseMusicXML(toMusicXML(def), parser);
      const expected = (toRawNotes(def) as Array<{ midi: number; onset: number; duration: number; measure: number }>).map(
        (n) => [n.midi, n.onset, n.duration, n.measure],
      );
      expect(parsed.notes.map((n) => [n.midi, n.onset, n.duration, n.measure])).toEqual(expected);
      const events = eventsFromSteps(toSteps(parsed), parsed.totalBeats);
      const ref = notesToEvents(toRawNotes(def));
      expect(events.map((e) => [e.notes, e.held, e.beats, e.measure])).toEqual(
        ref.map((e) => [e.notes, e.held, e.beats, e.measure]),
      );
    });
  }

  // homr 출력과 같은 모양 (한 파트, 보표 2개, 음표마다 imgpos 주석)
  const homrLike = `<?xml version='1.0' encoding='utf-8'?>
<score-partwise version="4.0"><work><work-title>Test</work-title></work>
<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
<part id="P1">
<measure number="1"><attributes><divisions>24</divisions><staves>2</staves><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
<attributes><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef><key><fifths>4</fifths></key></attributes>
<note><pitch><step>C</step><octave>4</octave><alter>1</alter></pitch><duration>48</duration><type>half</type><voice>1</voice><staff>1</staff><notations /><!-- imgpos: 227, 200 --></note>
<note><pitch><step>E</step><octave>4</octave></pitch><duration>24</duration><type>quarter</type><voice>1</voice><staff>1</staff><tie type="start"/><!-- imgpos: 300, 190 --></note>
<backup><duration>72</duration></backup>
<note><pitch><step>C</step><octave>3</octave><alter>1</alter></pitch><duration>72</duration><type>half</type><dot /><voice>5</voice><staff>2</staff><!-- imgpos: 243, 361 --></note>
<note><chord /><pitch><step>G</step><octave>3</octave><alter>1</alter></pitch><duration>72</duration><type>half</type><dot /><voice>5</voice><staff>2</staff><!-- imgpos: 243, 340 --></note>
</measure>
<measure number="2">
<note><pitch><step>E</step><octave>4</octave></pitch><duration>24</duration><type>quarter</type><voice>1</voice><staff>1</staff><tie type="stop"/><!-- imgpos: 351, 190 --></note>
<note><grace/><pitch><step>D</step><octave>5</octave></pitch><type>16th</type><voice>1</voice><staff>1</staff></note>
<note><rest/><duration>24</duration><voice>1</voice><staff>1</staff></note>
<note><pitch><step>B</step><octave>4</octave></pitch><duration>24</duration><voice>1</voice><staff>1</staff><!-- imgpos: 420, 185 --></note>
</measure>
</part></score-partwise>`;

  test('reads homr image positions, chords, ties, grace notes and backup', () => {
    const p = parseMusicXML(homrLike, parser);
    expect(p.title).toBe('Test');
    expect(p.notes.map((n) => [n.midi, n.onset, n.duration, n.measure, n.pos?.x, n.pos?.y])).toEqual([
      [49, 0, 3, 1, 243, 361], // C#3 (점2분)
      [56, 0, 3, 1, 243, 340], // G#3 화음
      [61, 0, 2, 1, 227, 200], // C#4
      [64, 2, 2, 1, 300, 190], // E4 + 붙임줄로 이어진 다음 마디의 E4
      [71, 5, 1, 2, 420, 185], // B4 (꾸밈음은 건너뜀)
    ]);
    expect(p.measures.map((m) => [m.onset, m.duration])).toEqual([
      [0, 3],
      [3, 3],
    ]);
    expect(p.totalBeats).toBe(6);
    const events = eventsFromSteps(toSteps(p), p.totalBeats);
    expect(events.map((e) => e.notes)).toEqual([[49, 56, 61], [64], [71]]);
    expect(events[1].held).toEqual([49, 56]);
    expect(events[2].beats).toBe(1);
  });

  test('combines pages, continuing beats and measure numbers', () => {
    const a = parseMusicXML(homrLike, parser, 0);
    const b = parseMusicXML(homrLike, parser, 1);
    const all = combinePages([a, b]);
    expect(all.totalBeats).toBe(12);
    expect(all.measures.map((m) => [m.index, m.page, m.onset])).toEqual([
      [1, 0, 0],
      [2, 0, 3],
      [3, 1, 6],
      [4, 1, 9],
    ]);
    const second = all.notes.filter((n) => n.page === 1);
    expect(second[0].onset).toBe(6);
    expect(second[second.length - 1].measure).toBe(4);
  });

  test('rejects broken input', () => {
    expect(() => parseMusicXML('<not-xml', parser)).toThrow();
  });
});
