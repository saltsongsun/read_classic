import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, test } from 'vitest';
import { combinePages, emptyPage, eventsFromSteps, parsePages, parseMusicXML, toSteps, type XmlParser } from '../src/score/musicxml';
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

  test('skips a page that could not be recognised', () => {
    const a = parseMusicXML(homrLike, parser, 0);
    const c = parseMusicXML(homrLike, parser, 2);
    const all = combinePages([a, emptyPage(), c]);
    expect(all.totalBeats).toBe(12);
    expect(all.measures.map((m) => [m.index, m.page])).toEqual([
      [1, 0],
      [2, 0],
      [3, 2],
      [4, 2],
    ]);
    expect(all.notes.some((n) => n.page === 1)).toBe(false);
  });

  test('reads tempo changes, including metronome marks in other beat units', () => {
    const measure = (n: number, direction = '') =>
      `<measure number="${n}">${n === 1 ? '<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>' : ''}${direction}` +
      '<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note></measure>';
    const metro = (unit: string, dot: boolean, pm: number) =>
      `<direction><direction-type><metronome><beat-unit>${unit}</beat-unit>${dot ? '<beat-unit-dot/>' : ''}<per-minute>${pm}</per-minute></metronome></direction-type></direction>`;
    const xml = `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"/></part-list><part id="P1">
      ${measure(1, '<direction><direction-type><words>Lento</words></direction-type><sound tempo="50"/></direction>')}
      ${measure(2)}
      ${measure(3, metro('quarter', true, 80))}
      ${measure(4, metro('half', false, 60))}
    </part></score-partwise>`;
    const parsed = parseMusicXML(xml, parser);
    expect(parsed.bpm).toBe(50);
    // 점4분음표=80 과 2분음표=60 은 둘 다 ♩=120 (같은 빠르기가 이어지면 하나로)
    expect(parsed.tempos).toEqual([
      { onset: 0, bpm: 50 },
      { onset: 8, bpm: 120 },
    ]);
    const events = eventsFromSteps(toSteps(parsed), parsed.totalBeats, parsed.tempos);
    expect(events.map((e) => e.bpm)).toEqual([50, 50, 120, 120]);
  });

  test('later pages keep the time signature of the first page', () => {
    const note = (d: number) => `<note><pitch><step>C</step><octave>4</octave></pitch><duration>${d}</duration><voice>1</voice></note>`;
    const page = (first: boolean, extra: number) =>
      `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"/></part-list><part id="P1">` +
      `<measure number="1"><attributes><divisions>1</divisions>${first ? '<time><beats>3</beats><beat-type>4</beat-type></time>' : ''}</attributes>${note(3 + extra)}</measure>` +
      `<measure number="2">${note(3)}</measure></part></score-partwise>`;
    // 둘째 쪽 첫 마디가 인식 오류로 4박이 됐다: 3/4 를 이어받아 3박으로 줄여야 한다
    const both = parsePages([page(true, 0), page(false, 1)], parser);
    expect(both.measures.map((m) => m.duration)).toEqual([3, 3, 3, 3]);
    expect(both.totalBeats).toBe(12);
    // 이어받지 않으면 (예전) 4/4 로 보고 4박 그대로
    expect(parseMusicXML(page(false, 1), parser).measures[0].duration).toBe(4);
  });

  test('rejects broken input', () => {
    expect(() => parseMusicXML('<not-xml', parser)).toThrow();
  });
});
