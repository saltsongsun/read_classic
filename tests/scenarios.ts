// 실제 연습 상황을 흉내 낸 연주 목록 만들기
import { mulberry32 } from './synth';
import type { PlayedNote, SampleScore } from './harness';

/** [fromBeat, toBeat) 구간을 이어 붙여 연주 (사이에 gap 박 쉼). */
export function playSegments(score: SampleScore, segments: Array<[number, number]>, gap = 1): PlayedNote[] {
  const out: PlayedNote[] = [];
  let cursor = 0;
  for (const [from, to] of segments) {
    for (const n of score.notes) {
      if (n.onset >= from - 1e-9 && n.onset < to - 1e-9) {
        out.push({ ...n, onset: cursor + (n.onset - from), duration: Math.min(n.duration, to - n.onset), origOnset: n.onset });
      }
    }
    cursor += to - from + gap;
  }
  return out;
}

/** 일정 비율의 음을 반음 1~2개 틀리게 연주. */
export function withWrongNotes(notes: PlayedNote[], ratio: number, seed = 5): PlayedNote[] {
  const rnd = mulberry32(seed);
  return notes.map((n) => (rnd() < ratio ? { ...n, midi: n.midi + (rnd() < 0.5 ? -1 : 1) * (1 + Math.floor(rnd() * 2)) } : n));
}
