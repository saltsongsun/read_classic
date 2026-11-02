import type { ScoreEvent } from './types';

/** 악보에서 뽑아낸 음 하나 (붙임줄은 이미 합쳐진 상태). */
export interface RawNote {
  midi: number;
  /** 시작 시점 (4분음표 단위, 반복 포함 연주 순서 기준). */
  onset: number;
  /** 길이 (4분음표 단위). */
  duration: number;
}

/** 커서 한 칸(같은 시점에 시작하는 음들). */
export interface RawStep {
  onset: number;
  notes: RawNote[];
  measure: number;
  cursorStep: number;
  /** 이 칸의 악보 빠르기 (♩/분, 빠르기 표시가 있을 때만) */
  bpm?: number;
}

const EPS = 1e-6;

/**
 * 커서 칸들을 추적용 이벤트 목록으로 바꾼다.
 * 새로 시작하는 음이 없는 칸(쉼표, 붙임줄로 이어진 음)은 건너뛴다.
 */
export function buildEvents(steps: RawStep[]): ScoreEvent[] {
  const sorted = steps
    .filter((s) => s.notes.length > 0)
    .slice()
    .sort((a, b) => a.onset - b.onset || a.cursorStep - b.cursorStep);

  // 같은 시점의 칸이 여러 개면 하나로 합친다.
  const merged: RawStep[] = [];
  for (const s of sorted) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.onset - s.onset) < EPS) last.notes = last.notes.concat(s.notes);
    else merged.push({ ...s, notes: s.notes.slice() });
  }

  const events: ScoreEvent[] = [];
  let active: RawNote[] = [];
  for (let i = 0; i < merged.length; i++) {
    const s = merged[i];
    active = active.filter((n) => n.onset + n.duration > s.onset + EPS);
    const notes = uniq(s.notes.map((n) => n.midi));
    const held = uniq(active.map((n) => n.midi)).filter((m) => !notes.includes(m));
    const next = merged[i + 1];
    const longest = Math.max(...s.notes.map((n) => n.duration));
    const beats = next ? next.onset - s.onset : Math.max(1, longest);
    const ev: ScoreEvent = { notes, held, beats: Math.max(beats, 1 / 32), measure: s.measure, cursorStep: s.cursorStep };
    if (s.bpm && s.bpm > 0) ev.bpm = s.bpm;
    events.push(ev);
    active = active.concat(s.notes);
  }
  return events;
}

function uniq(xs: number[]): number[] {
  return [...new Set(xs)].sort((a, b) => a - b);
}

/** 악보 빠르기 표시 (시작 박 위치, ♩/분). */
export interface TempoMark {
  onset: number;
  bpm: number;
}

/** 박 위치의 빠르기: 그 앞의 마지막 표시 (첫 표시보다 앞이면 첫 표시). */
export function tempoAt(tempos: TempoMark[], onset: number): number | undefined {
  if (tempos.length === 0) return undefined;
  let bpm = tempos[0].bpm;
  for (const t of tempos) {
    if (t.onset <= onset + EPS) bpm = t.bpm;
    else break;
  }
  return bpm;
}

/**
 * 악보대로 연주할 때 걸리는 시간 (초). 빠르기 표시가 바뀌는 곳은 그대로 반영하고,
 * 표시가 없는 이벤트는 fallbackBpm 으로 계산한다.
 */
export function nominalSeconds(events: ScoreEvent[], fallbackBpm: number): number {
  return events.reduce((sum, e) => sum + (e.beats * 60) / (e.bpm ?? fallbackBpm), 0);
}
