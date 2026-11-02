import { describe, expect, test } from 'vitest';
import { ProgressEstimator } from '../src/follow/progress';
import type { ScoreEvent } from '../src/follow/types';
import { loadSample, run } from './harness';

const ev = (beats: number, bpm?: number, measure = 1): ScoreEvent => ({ notes: [60], held: [], beats, measure, cursorStep: 0, ...(bpm ? { bpm } : {}) });

/** 위치를 정해진 대로 움직이며 0.05초마다 update */
function drive(p: ProgressEstimator, until: number, positionAt: (t: number) => number, from = 0): void {
  for (let t = from; t <= until + 1e-9; t += 0.05) p.update(t, positionAt(t), true);
}

describe('score timeline', () => {
  test('total length follows tempo changes written in the score', () => {
    // ♩=60 으로 8박(8초) + ♩=120 으로 8박(4초)
    const events = [...Array.from({ length: 8 }, () => ev(1, 60)), ...Array.from({ length: 8 }, () => ev(1, 120))];
    const p = new ProgressEstimator(events, { scoreBpm: 60 });
    const s = p.snapshot();
    expect(s.scoreTotalSec).toBeCloseTo(12, 6);
    expect(s.basis).toBe('score');
    // 연습 템포를 두 배로 하면 전체가 절반
    p.setOptions({ scoreBpm: 120 });
    expect(p.snapshot().scoreTotalSec).toBeCloseTo(6, 6);
  });

  test('without tempo marks the length is only a guess until an expected time is given', () => {
    const events = Array.from({ length: 10 }, () => ev(1));
    const p = new ProgressEstimator(events, { scoreBpm: 100 });
    expect(p.snapshot().basis).toBe('guess');
    p.setOptions({ expectedTotalSec: 90 });
    expect(p.snapshot().basis).toBe('expected');
    expect(p.snapshot().totalSec).toBeCloseTo(90, 6);
  });
});

describe('time check', () => {
  // ♩=60, 1박짜리 120개 = 2분짜리 곡
  const events = Array.from({ length: 120 }, (_, i) => ev(1, 60, 1 + Math.floor(i / 4)));

  test('a tracker that keeps pace is trusted', () => {
    const p = new ProgressEstimator(events, { scoreBpm: 60 });
    drive(p, 40, (t) => Math.floor(t));
    const s = p.snapshot();
    expect(s.check).toBe('ok');
    expect(Math.abs(s.remainingSec - 80)).toBeLessThan(3);
  });

  test('a tracker that stops moving while music goes on: falls back to time, then hands back', () => {
    const p = new ProgressEstimator(events, { scoreBpm: 60 });
    // 20초까지 잘 따라가다가 20번째 음에서 멈춤 (인식이 틀린 구간)
    drive(p, 20, (t) => Math.floor(t));
    drive(p, 45, () => 20, 20.05);
    let s = p.snapshot();
    expect(s.check).toBe('lost');
    expect(p.timeHint()).toBeGreaterThan(40);
    expect(p.timeHint()).toBeLessThan(50);
    // 남은 시간은 시간에 맞춰 계속 줄어든다 (실제 남은 시간 75초)
    for (let k = 0; k < 40; k++) s = p.snapshot();
    expect(Math.abs(s.remainingSec - 75)).toBeLessThan(6);
    // 추적기가 제자리를 다시 찾으면 돌아온다
    drive(p, 60, (t) => Math.floor(t), 45.05);
    s = p.snapshot();
    expect(s.check).toBe('ok');
    expect(p.timeHint()).toBeNull();
  });

  test('a long held note is not mistaken for being lost', () => {
    const slow = [...Array.from({ length: 10 }, () => ev(1, 60)), ev(12, 60), ...Array.from({ length: 10 }, () => ev(1, 60))];
    const p = new ProgressEstimator(slow, { scoreBpm: 60 });
    drive(p, 21, (t) => (t < 10 ? Math.floor(t) : t < 22 ? 10 : 11 + Math.floor(t - 22)));
    expect(p.snapshot().check).toBe('ok');
  });

  test('much slower than the expected time is reported', () => {
    const p = new ProgressEstimator(events, { scoreBpm: 60, expectedTotalSec: 120 });
    // 예상(♩=60)보다 40% 느리게
    drive(p, 60, (t) => Math.floor(t / 1.4));
    const s = p.snapshot();
    expect(s.check).toBe('slow');
    expect(s.deviation).toBeGreaterThan(0.3);
  });

  test('finishes on time even if the last notes were never tracked', () => {
    const p = new ProgressEstimator(events, { scoreBpm: 60 });
    drive(p, 100, (t) => Math.min(Math.floor(t), 99));
    for (let t = 100.05; t <= 130; t += 0.05) p.update(t, 99, t < 121); // 실제로는 120초에 끝남
    expect(p.snapshot().finished).toBe(true);
  });
});

describe('time check with real tracking', () => {
  test('a mis-recognised section: time takes over and the tracker finds its place again', () => {
    const bach = loadSample('bach-prelude-c');
    // 사진 악보 인식 오류 흉내: 60~100번째 음을 엉뚱한 음으로 바꾼 악보로 추적
    const events = bach.events.map((e, i) => (i >= 60 && i < 100 ? { ...e, notes: e.notes.map((m) => m + ((i * 5) % 7) + 1), held: [] } : e));
    const withHint = run({ ...bach, events }, { timbre: 'piano', reverb: 0.3, tempoWobble: 0.05, seed: 4 });
    const after = withHint.trace.filter((p) => p.truth >= 110);
    const ok = after.filter((p) => Math.abs(p.idx - p.truth) <= 2).length / after.length;
    expect(ok).toBeGreaterThan(0.9);
    expect(withHint.finalIndex).toBe(bach.events.length - 1);
    expect(withHint.remaining.some((x) => x.check === 'lost')).toBe(true);
    // 놓친 동안에도 남은 시간은 곡 길이의 20% 이내
    const start = withHint.remaining.find((x) => x.started)!.t;
    const dur = withHint.endTime - start;
    for (const x of withHint.remaining.filter((x) => x.check === 'lost')) expect(Math.abs(x.est - x.truth)).toBeLessThan(0.2 * dur);
  });
});
