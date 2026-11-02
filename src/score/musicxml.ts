/**
 * 가벼운 MusicXML 해석기.
 *
 * 사진/PDF 악보는 악보 인식(homr) 결과 MusicXML 을 받는데, homr 는 각 음표 안에
 * `<!-- imgpos: x, y -->` 주석으로 원본 이미지에서의 위치를 적어 준다.
 * OSMD 는 주석을 버리므로, 위치를 지키기 위해 직접 읽는다.
 * (붙임줄, 화음, 여러 성부의 backup/forward, 꾸밈음, 여러 보표/파트를 처리. 도돌이표는 펼치지 않는다.)
 */
import { buildEvents, tempoAt, type RawNote, type RawStep, type TempoMark } from '../follow/build';
import type { ScoreEvent } from '../follow/types';

export interface ImgPos {
  x: number;
  y: number;
}

export interface ParsedNote extends RawNote {
  /** 1부터 세는 전체 마디 번호 (여러 페이지를 이어 붙인 뒤에도 연속). */
  measure: number;
  staff: number;
  voice: string;
  page: number;
  pos?: ImgPos;
}

export interface ParsedMeasure {
  /** 1부터 세는 전체 마디 번호 */
  index: number;
  page: number;
  /** 페이지 안에서 몇 번째 줄(시스템)인지, 0부터. 악보에 줄바꿈 표시가 있을 때만 정확하다. */
  system: number;
  onset: number;
  duration: number;
}

export interface ParsedScore {
  title?: string;
  bpm?: number;
  notes: ParsedNote[];
  measures: ParsedMeasure[];
  totalBeats: number;
  /** 빠르기 표시들 (박 순서) */
  tempos?: TempoMark[];
}

export interface ScoreStep {
  onset: number;
  measure: number;
  notes: ParsedNote[];
}

/** DOMParser 와 같은 모양 (테스트에서는 xmldom 을 넘긴다). */
export interface XmlParser {
  parseFromString(text: string, type: string): Document;
}

const STEP: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ELEMENT = 1;
const COMMENT = 8;

function kids(el: Element, name?: string): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === ELEMENT && (!name || n.nodeName === name)) out.push(n as Element);
  }
  return out;
}
function kid(el: Element, name: string): Element | undefined {
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === ELEMENT && n.nodeName === name) return n as Element;
  return undefined;
}
function num(el: Element | undefined, name: string): number | undefined {
  const c = el && kid(el, name);
  if (!c) return undefined;
  const v = Number((c.textContent ?? '').trim());
  return Number.isFinite(v) ? v : undefined;
}
function imgposOf(note: Element): ImgPos | undefined {
  for (let n = note.firstChild; n; n = n.nextSibling) {
    if (n.nodeType !== COMMENT) continue;
    const m = /imgpos:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(n.nodeValue ?? '');
    if (m) return { x: Number(m[1]), y: Number(m[2]) };
  }
  return undefined;
}

export function parseMusicXML(text: string, parser: XmlParser = new DOMParser(), page = 0): ParsedScore {
  const doc = parser.parseFromString(text, 'application/xml');
  const root = doc.documentElement;
  if (!root || root.nodeName === 'parsererror' || doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('MusicXML 을 읽을 수 없습니다.');
  }
  if (root.nodeName === 'score-timewise') throw new Error('score-timewise 형식은 아직 지원하지 않습니다.');

  const work = kid(root, 'work');
  const title =
    (work && kid(work, 'work-title')?.textContent?.trim()) || kid(root, 'movement-title')?.textContent?.trim() || undefined;

  const notes: ParsedNote[] = [];
  let measures: ParsedMeasure[] = [];
  let bpm: number | undefined;
  const tempos: TempoMark[] = [];

  kids(root, 'part').forEach((part, partIndex) => {
    let divisions = 1;
    let measureQuarters = 4;
    let measureStart = 0;
    const partMeasures: ParsedMeasure[] = [];
    const pendingTies = new Map<string, ParsedNote>();

    let system = 0;
    kids(part, 'measure').forEach((measure, mi) => {
      const start = measureStart;
      const print = kid(measure, 'print');
      if (mi > 0 && print && (print.getAttribute('new-system') === 'yes' || print.getAttribute('new-page') === 'yes')) {
        system++;
      }
      let pos = start;
      let maxPos = start;
      let lastOnset = start;
      const measureNo = mi + 1;
      const voiceEnds = new Map<string, number>();

      for (const el of kids(measure)) {
        switch (el.nodeName) {
          case 'attributes': {
            divisions = num(el, 'divisions') ?? divisions;
            const time = kid(el, 'time');
            const beats = num(time, 'beats');
            const beatType = num(time, 'beat-type');
            if (beats && beatType) measureQuarters = (beats * 4) / beatType;
            break;
          }
          case 'direction':
          case 'sound': {
            const t = tempoOf(el);
            if (t) {
              bpm ??= t;
              tempos.push({ onset: pos, bpm: t });
            }
            break;
          }
          case 'backup':
            pos -= (num(el, 'duration') ?? 0) / divisions;
            break;
          case 'forward':
            pos += (num(el, 'duration') ?? 0) / divisions;
            maxPos = Math.max(maxPos, pos);
            break;
          case 'note': {
            if (kid(el, 'grace') || kid(el, 'cue')) break;
            const isChord = !!kid(el, 'chord');
            const dur = (num(el, 'duration') ?? 0) / divisions;
            const onset = isChord ? lastOnset : pos;
            if (!isChord) {
              lastOnset = pos;
              pos += dur;
              maxPos = Math.max(maxPos, pos);
            }
            const vkey = `${partIndex}:${kid(el, 'voice')?.textContent?.trim() ?? num(el, 'staff') ?? 1}`;
            voiceEnds.set(vkey, Math.max(voiceEnds.get(vkey) ?? start, onset + dur));
            const pitch = kid(el, 'pitch');
            if (kid(el, 'rest') || !pitch) break;
            const step = kid(pitch, 'step')?.textContent?.trim() ?? '';
            if (!(step in STEP)) break;
            const midi = 12 * ((num(pitch, 'octave') ?? 4) + 1) + STEP[step] + Math.round(num(pitch, 'alter') ?? 0);
            const staff = num(el, 'staff') ?? 1;
            const voice = `${partIndex}:${kid(el, 'voice')?.textContent?.trim() ?? staff}`;
            const ties = kids(el, 'tie').map((t) => t.getAttribute('type'));
            const key = `${partIndex}:${midi}`;
            const prev = pendingTies.get(key);
            if (ties.includes('stop') && prev && Math.abs(prev.onset + prev.duration - onset) < 1e-3) {
              // 붙임줄: 앞 음을 늘리기만 한다
              prev.duration += dur;
              if (!ties.includes('start')) pendingTies.delete(key);
              break;
            }
            const note: ParsedNote = { midi, onset, duration: dur, measure: measureNo, staff, voice, page, pos: imgposOf(el) };
            notes.push(note);
            if (ties.includes('start')) pendingTies.set(key, note);
            else pendingTies.delete(key);
            break;
          }
        }
      }
      let len = maxPos - start;
      if (len <= 1e-6) len = measureQuarters;
      if (len > measureQuarters * 1.05) {
        // 인식 오류로 박자표보다 길어진 마디: 넘친 성부를 마디 길이에 맞게 줄인다.
        // (사진 악보 인식에서 쉼표·붙임줄·여러 성부의 박이 어긋나는 일이 흔하다)
        fitVoices(notes, measureNo, partIndex, start, measureQuarters, voiceEnds);
        len = measureQuarters;
      }
      partMeasures.push({ index: measureNo, page, system, onset: start, duration: len });
      measureStart = start + len;
    });
    if (partIndex === 0 || partMeasures.length > measures.length) measures = partMeasures;
  });

  notes.sort((a, b) => a.onset - b.onset || a.midi - b.midi);
  const last = measures[measures.length - 1];
  const totalBeats = last ? last.onset + last.duration : 0;
  return { title, bpm, notes, measures, totalBeats, tempos: cleanTempos(tempos) };
}

const BEAT_UNIT: Record<string, number> = { whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25, '32nd': 0.125 };

/** <sound tempo> 또는 메트로놈 표시(♩=120, 𝅗𝅥=60 …)의 빠르기를 4분음표 기준으로. */
function tempoOf(el: Element): number | undefined {
  const sound = el.nodeName === 'sound' ? el : kid(el, 'sound');
  const t = sound ? Number(sound.getAttribute('tempo')) : NaN;
  if (t > 0 && t < 1000) return t;
  if (el.nodeName !== 'direction') return undefined;
  const metro = el.getElementsByTagName('metronome')[0];
  const pm = metro ? num(metro, 'per-minute') : undefined;
  if (!metro || !pm || pm <= 0) return undefined;
  const unit = BEAT_UNIT[kid(metro, 'beat-unit')?.textContent?.trim() ?? 'quarter'] ?? 1;
  const dots = kids(metro, 'beat-unit-dot').length;
  return pm * unit * (2 - 0.5 ** dots);
}

/** 박 순서대로, 같은 자리 중복(여러 성부·보표)은 하나로. */
function cleanTempos(tempos: TempoMark[]): TempoMark[] {
  const out: TempoMark[] = [];
  for (const t of [...tempos].sort((a, b) => a.onset - b.onset)) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.onset - t.onset) < 1e-6) prev.bpm = t.bpm;
    else if (!prev || prev.bpm !== t.bpm) out.push({ ...t });
  }
  return out;
}

/** 마디 안에서 박자표보다 길어진 성부들의 시작·길이를 비례해서 줄인다. */
function fitVoices(
  notes: ParsedNote[],
  measure: number,
  partIndex: number,
  start: number,
  length: number,
  voiceEnds: Map<string, number>,
): void {
  for (const [voice, end] of voiceEnds) {
    if (!voice.startsWith(`${partIndex}:`) || end <= start + length * 1.05) continue;
    const k = length / (end - start);
    for (const n of notes) {
      if (n.measure !== measure || n.voice !== voice) continue;
      n.onset = start + (n.onset - start) * k;
      n.duration *= k;
    }
  }
  // 붙임줄로 다음 마디까지 이어진 음은 마디 끝을 넘지 않게
  for (const n of notes) {
    if (n.measure === measure && n.onset + n.duration > start + length + 1e-6 && n.onset < start + length) {
      n.duration = Math.max(n.duration, 1e-3);
    }
  }
}

/** 페이지별 인식 결과를 이어 붙인다 (박 위치와 마디 번호를 이어서 센다). */
/** 인식하지 못한 쪽 자리에 넣는 빈 쪽. */
export function emptyPage(): ParsedScore {
  return { notes: [], measures: [], totalBeats: 0 };
}

export function combinePages(pages: ParsedScore[]): ParsedScore {
  const notes: ParsedNote[] = [];
  const measures: ParsedMeasure[] = [];
  let beatOffset = 0;
  let measureOffset = 0;
  let bpm: number | undefined;
  let title: string | undefined;
  const tempos: TempoMark[] = [];
  pages.forEach((p, pageIndex) => {
    bpm ??= p.bpm;
    title ??= p.title;
    for (const t of p.tempos ?? []) tempos.push({ onset: t.onset + beatOffset, bpm: t.bpm });
    for (const n of p.notes) {
      notes.push({ ...n, page: pageIndex, onset: n.onset + beatOffset, measure: n.measure + measureOffset });
    }
    for (const m of p.measures) {
      measures.push({ ...m, page: pageIndex, onset: m.onset + beatOffset, index: m.index + measureOffset });
    }
    beatOffset += p.totalBeats;
    measureOffset += p.measures.length;
  });
  return { title, bpm, notes, measures, totalBeats: beatOffset, tempos };
}

/** 같은 시점에 시작하는 음들을 한 칸으로 묶는다. */
export function toSteps(score: ParsedScore): ScoreStep[] {
  const steps: ScoreStep[] = [];
  for (const n of score.notes) {
    const last = steps[steps.length - 1];
    if (last && Math.abs(last.onset - n.onset) < 1e-6) last.notes.push(n);
    else steps.push({ onset: n.onset, measure: n.measure, notes: [n] });
  }
  return steps;
}

/** 추적용 이벤트. event.cursorStep 은 toSteps() 결과의 인덱스. */
export function eventsFromSteps(steps: ScoreStep[], totalBeats?: number, tempos: TempoMark[] = []): ScoreEvent[] {
  const raw: RawStep[] = steps.map((s, i) => ({
    onset: s.onset,
    notes: s.notes,
    measure: s.measure,
    cursorStep: i,
    bpm: tempoAt(tempos, s.onset),
  }));
  const events = buildEvents(raw);
  // 마지막 음의 길이는 악보 끝까지
  if (events.length && totalBeats !== undefined) {
    const last = events[events.length - 1];
    const lastStep = steps[last.cursorStep];
    const toEnd = totalBeats - lastStep.onset;
    if (toEnd > last.beats) last.beats = toEnd;
  }
  return events;
}
