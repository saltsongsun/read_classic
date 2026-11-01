// 앱에 기본으로 들어가는 예제 악보 정의 (모두 퍼블릭 도메인 곡, 직접 입력).
// scripts/make-samples.mjs 가 이 정의로 MusicXML 파일을 만들고,
// 테스트는 같은 정의로 합성 오디오를 만들어 추적 정확도를 확인한다.
//
// 음표 문법:  음이름[#|b]옥타브/길이[.][~]   쉼표: r/길이   마디 구분: |
//   길이: 1=온음표 2=2분 4=4분 8=8분 16=16분, 점(.)은 1.5배, ~ 는 다음 음과 붙임줄

const PRELUDE_C = [
  ['C4', 'E4', 'G4', 'C5', 'E5'],
  ['C4', 'D4', 'A4', 'D5', 'F5'],
  ['B3', 'D4', 'G4', 'D5', 'F5'],
  ['C4', 'E4', 'G4', 'C5', 'E5'],
  ['C4', 'E4', 'A4', 'E5', 'A5'],
  ['C4', 'D4', 'F#4', 'A4', 'D5'],
  ['B3', 'D4', 'G4', 'D5', 'G5'],
  ['B3', 'C4', 'E4', 'G4', 'C5'],
  ['A3', 'C4', 'E4', 'G4', 'C5'],
  ['D3', 'A3', 'D4', 'F#4', 'C5'],
  ['G3', 'B3', 'D4', 'G4', 'B4'],
  ['G3', 'Bb3', 'E4', 'G4', 'C#5'],
  ['F3', 'A3', 'D4', 'A4', 'D5'],
  ['F3', 'Ab3', 'D4', 'F4', 'B4'],
  ['E3', 'G3', 'C4', 'G4', 'C5'],
  ['E3', 'F3', 'A3', 'C4', 'F4'],
  ['D3', 'F3', 'A3', 'C4', 'F4'],
  ['G2', 'D3', 'G3', 'B3', 'F4'],
  ['C3', 'E3', 'G3', 'C4', 'E4'],
];

const preludeRH = PRELUDE_C.map(([, , a, b, c]) => {
  const half = `r/8 ${a}/16 ${b}/16 ${c}/16 ${a}/16 ${b}/16 ${c}/16`;
  return `${half} ${half}`;
}).join(' | ');
const preludeLH1 = PRELUDE_C.map(([b1]) => `${b1}/2 ${b1}/2`).join(' | ');
const preludeLH2 = PRELUDE_C.map(([, b2]) => {
  const half = `r/16 ${b2}/8.~ ${b2}/4`;
  return `${half} ${half}`;
}).join(' | ');

export const SCORES = [
  {
    id: 'ode-to-joy',
    title: '환희의 송가',
    composer: 'L. v. Beethoven (교향곡 9번 주제, 단순화)',
    bpm: 108,
    time: [4, 4],
    fifths: 0,
    staves: [
      {
        clef: 'G',
        voices: [
          'E4/4 E4/4 F4/4 G4/4 | G4/4 F4/4 E4/4 D4/4 | C4/4 C4/4 D4/4 E4/4 | E4/4. D4/8 D4/2 | ' +
            'E4/4 E4/4 F4/4 G4/4 | G4/4 F4/4 E4/4 D4/4 | C4/4 C4/4 D4/4 E4/4 | D4/4. C4/8 C4/2 | ' +
            'D4/4 D4/4 E4/4 C4/4 | D4/4 E4/8 F4/8 E4/4 C4/4 | D4/4 E4/8 F4/8 E4/4 D4/4 | C4/4 D4/4 G3/2 | ' +
            'E4/4 E4/4 F4/4 G4/4 | G4/4 F4/4 E4/4 D4/4 | C4/4 C4/4 D4/4 E4/4 | D4/4. C4/8 C4/2',
        ],
      },
    ],
  },
  {
    id: 'twinkle',
    title: '작은 별',
    composer: '프랑스 민요 (Ah! vous dirai-je, maman)',
    bpm: 96,
    time: [2, 4],
    fifths: 0,
    staves: [
      {
        clef: 'G',
        voices: [
          'C4/4 C4/4 | G4/4 G4/4 | A4/4 A4/4 | G4/2 | F4/4 F4/4 | E4/4 E4/4 | D4/4 D4/4 | C4/2 | ' +
            'G4/4 G4/4 | F4/4 F4/4 | E4/4 E4/4 | D4/2 | G4/4 G4/4 | F4/4 F4/4 | E4/4 E4/4 | D4/2 | ' +
            'C4/4 C4/4 | G4/4 G4/4 | A4/4 A4/4 | G4/2 | F4/4 F4/4 | E4/4 E4/4 | D4/4 D4/4 | C4/2',
        ],
      },
    ],
  },
  {
    id: 'bach-prelude-c',
    title: '평균율 1권 전주곡 C장조 (1–19마디)',
    composer: 'J. S. Bach, BWV 846',
    bpm: 66,
    time: [4, 4],
    fifths: 0,
    staves: [
      { clef: 'G', voices: [preludeRH] },
      { clef: 'F', voices: [preludeLH2, preludeLH1] },
    ],
  },
];

const STEP_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const TYPE_NAME = { 1: 'whole', 2: 'half', 4: 'quarter', 8: 'eighth', 16: '16th' };
/** MusicXML divisions (4분음표 하나를 몇으로 나눌지). */
export const DIVISIONS = 4;

/** "C#4/8.~" 같은 토큰 하나를 해석한다. */
export function parseToken(tok) {
  const m = /^(r|[A-G])(#|b)?(\d)?\/(1|2|4|8|16)(\.)?(~)?$/.exec(tok);
  if (!m) throw new Error(`잘못된 음표 표기: ${tok}`);
  const [, step, acc, oct, len, dot, tie] = m;
  const base = (4 * DIVISIONS) / Number(len);
  const dur = dot ? base * 1.5 : base;
  if (step === 'r') return { rest: true, dur, type: TYPE_NAME[len], dot: !!dot };
  const alter = acc === '#' ? 1 : acc === 'b' ? -1 : 0;
  const octave = Number(oct);
  return {
    rest: false,
    step,
    alter,
    octave,
    midi: 12 * (octave + 1) + STEP_SEMITONE[step] + alter,
    dur,
    type: TYPE_NAME[len],
    dot: !!dot,
    tie: !!tie,
  };
}

/** 성부 문자열 → 마디별 토큰 배열 */
export function parseVoice(str) {
  return str.split('|').map((bar) => bar.trim().split(/\s+/).filter(Boolean).map(parseToken));
}

/**
 * 악보 정의를 (붙임줄을 합친) 음 목록으로 바꾼다.
 * onset / duration 은 4분음표 단위.
 */
export function toRawNotes(score) {
  const measureDur = (score.time[0] * 4 * DIVISIONS) / score.time[1];
  const notes = [];
  for (const staff of score.staves) {
    for (const voiceStr of staff.voices) {
      const bars = parseVoice(voiceStr);
      let pendingTie = null;
      bars.forEach((bar, mi) => {
        let pos = mi * measureDur;
        for (const t of bar) {
          if (!t.rest) {
            if (pendingTie && pendingTie.midi === t.midi) {
              pendingTie.duration += t.dur / DIVISIONS;
            } else {
              const n = { midi: t.midi, onset: pos / DIVISIONS, duration: t.dur / DIVISIONS, measure: mi + 1 };
              notes.push(n);
              pendingTie = n;
            }
            if (!t.tie) pendingTie = null;
          } else {
            pendingTie = null;
          }
          pos += t.dur;
        }
      });
    }
  }
  notes.sort((a, b) => a.onset - b.onset || a.midi - b.midi);
  return notes;
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 악보 정의 → MusicXML 3.1 partwise 문자열 */
export function toMusicXML(score) {
  const measureDur = (score.time[0] * 4 * DIVISIONS) / score.time[1];
  const staffBars = score.staves.map((st) => st.voices.map(parseVoice));
  const nMeasures = Math.max(...staffBars.flat().map((v) => v.length));
  const multi = score.staves.length > 1;
  // 보표마다 성부 번호 1~4, 5~8 … (악보 프로그램들의 관례: 첫 성부 = 기둥 위, 둘째 = 아래)
  const voiceIds = staffBars.map((voices, si) => voices.map((_, vi) => si * 4 + vi + 1));

  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
  out.push(
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
  );
  out.push('<score-partwise version="3.1">');
  out.push(`  <work><work-title>${esc(score.title)}</work-title></work>`);
  out.push(
    `  <identification><creator type="composer">${esc(score.composer)}</creator><encoding><software>read_classic sample generator</software></encoding></identification>`,
  );
  out.push('  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>');
  out.push('  <part id="P1">');
  for (let m = 0; m < nMeasures; m++) {
    out.push(`    <measure number="${m + 1}">`);
    if (m === 0) {
      out.push('      <attributes>');
      out.push(`        <divisions>${DIVISIONS}</divisions>`);
      out.push(`        <key><fifths>${score.fifths}</fifths></key>`);
      out.push(`        <time><beats>${score.time[0]}</beats><beat-type>${score.time[1]}</beat-type></time>`);
      if (multi) out.push(`        <staves>${score.staves.length}</staves>`);
      score.staves.forEach((st, si) => {
        const line = st.clef === 'G' ? 2 : 4;
        out.push(`        <clef${multi ? ` number="${si + 1}"` : ''}><sign>${st.clef}</sign><line>${line}</line></clef>`);
      });
      out.push('      </attributes>');
      out.push(
        `      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${score.bpm}</per-minute></metronome></direction-type><sound tempo="${score.bpm}"/></direction>`,
      );
    }
    let first = true;
    staffBars.forEach((voices, si) => {
      const shownAcc = new Map(); // 마디 안에서 이미 표시한 임시표
      voices.forEach((bars, vi) => {
        if (!first) out.push(`      <backup><duration>${measureDur}</duration></backup>`);
        first = false;
        const bar = bars[m] ?? [];
        const prevBar = bars[m - 1] ?? [];
        let tiedFromPrev = prevBar.length > 0 && prevBar[prevBar.length - 1].tie;
        for (const t of bar) {
          out.push('      <note>');
          if (t.rest) out.push('        <rest/>');
          else {
            out.push(
              `        <pitch><step>${t.step}</step>${t.alter ? `<alter>${t.alter}</alter>` : ''}<octave>${t.octave}</octave></pitch>`,
            );
          }
          out.push(`        <duration>${t.dur}</duration>`);
          if (!t.rest && tiedFromPrev) out.push('        <tie type="stop"/>');
          if (!t.rest && t.tie) out.push('        <tie type="start"/>');
          out.push(`        <voice>${voiceIds[si][vi]}</voice>`);
          out.push(`        <type>${t.type}</type>`);
          if (t.dot) out.push('        <dot/>');
          if (!t.rest) {
            const key = `${t.step}${t.octave}`;
            const shown = shownAcc.get(key) ?? 0;
            if (t.alter !== shown) {
              const name = t.alter > 0 ? 'sharp' : t.alter < 0 ? 'flat' : 'natural';
              out.push(`        <accidental>${name}</accidental>`);
              shownAcc.set(key, t.alter);
            }
          }
          if (voices.length > 1 && !t.rest) out.push(`        <stem>${vi === 0 ? 'up' : 'down'}</stem>`);
          if (multi) out.push(`        <staff>${si + 1}</staff>`);
          const ties = [];
          if (!t.rest && tiedFromPrev) ties.push('<tied type="stop"/>');
          if (!t.rest && t.tie) ties.push('<tied type="start"/>');
          if (ties.length) out.push(`        <notations>${ties.join('')}</notations>`);
          out.push('      </note>');
          tiedFromPrev = !t.rest && t.tie;
        }
      });
    });
    if (m === nMeasures - 1) out.push('      <barline location="right"><bar-style>light-heavy</bar-style></barline>');
    out.push('    </measure>');
  }
  out.push('  </part>');
  out.push('</score-partwise>');
  return out.join('\n') + '\n';
}
