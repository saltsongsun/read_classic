import { describe, expect, test } from 'vitest';
import { BeatClock } from '../src/follow/beatClock';
import type { ScoreEvent } from '../src/follow/types';

// 4/4, ♩=60, 마디마다 4분음표 4개 × 30마디 = 120초짜리 곡
const events: ScoreEvent[] = Array.from({ length: 120 }, (_, i) => ({ notes: [60], held: [], beats: 1, measure: 1 + Math.floor(i / 4), cursorStep: i, bpm: 60 }));
function drive(c: BeatClock, from: number, to: number, voiced: (t: number) => boolean): void {
  for (let t = from; t <= to + 1e-9; t += 0.05) c.update(t, voiced(t));
}

describe('bar/beat clock', () => {
  test('length comes from bars, time signature and tempo; position follows the clock from the first sound', () => {
    const c = new BeatClock(events, { scoreBpm: 60 });
    expect(c.snapshot().totalSec).toBeCloseTo(120, 6);
    drive(c, 0, 5, () => false);
    expect(c.position()).toBe(-1); // 소리 나기 전
    drive(c, 5.05, 35.1, () => true); // 5.05초에 첫 소리, 30초 연주
    expect(c.position()).toBe(30);
    expect(events[c.position()].measure).toBe(8);
    expect(c.snapshot().remainingSec).toBeCloseTo(90, 0);
  });

  test('an expected duration sets the pace', () => {
    const c = new BeatClock(events, { scoreBpm: 60, expectedTotalSec: 180 }); // 1.5배 느리게
    drive(c, 0, 30, () => true);
    expect(c.position()).toBe(20);
    expect(c.snapshot().remainingSec).toBeCloseTo(150, 0);
  });

  test('a long silence (between movements) stops the clock until playing resumes', () => {
    const c = new BeatClock(events, { scoreBpm: 60 });
    drive(c, 0, 20, () => true);
    drive(c, 20.05, 32, () => false); // 12초 쉼
    expect(c.isPaused).toBe(true);
    expect(c.position()).toBe(20); // 소리가 그친 곳에서 멈춤
    drive(c, 32.05, 42, () => true);
    expect(c.position()).toBe(30);
  });

  test('a short rest is part of the music and keeps counting', () => {
    const c = new BeatClock(events, { scoreBpm: 60 });
    drive(c, 0, 20, () => true);
    drive(c, 20.05, 22, () => false); // 2초 쉼표
    drive(c, 22.05, 30, () => true);
    expect(c.position()).toBe(30);
  });

  test('tapping where the pianist is re-syncs and re-estimates the pace', () => {
    const c = new BeatClock(events, { scoreBpm: 60 });
    drive(c, 0, 40, () => true); // 계산상 40번째 음인데
    c.setPosition(32, 40); // 실제로는 32번째 (0.8배 빠르기)
    expect(c.position()).toBe(32);
    drive(c, 40.05, 50, () => true);
    expect(c.position()).toBe(40); // 이후로는 1.25초/박
    expect(c.snapshot().remainingSec).toBeCloseTo(80 * 1.25, 0);
  });

  test('tapping far back (a repeat) moves the position but keeps the pace', () => {
    const c = new BeatClock(events, { scoreBpm: 60, expectedTotalSec: 120 });
    drive(c, 0, 60, () => true); // 계산대로 60번째 음 (16마디 첫 박)
    c.setPosition(20, 60); // 도돌이표: 6마디로 돌아가 반복
    expect(c.position()).toBe(20);
    expect(c.bpm).toBeCloseTo(60, 6); // 속도는 그대로
    drive(c, 60.05, 70, () => true);
    expect(c.position()).toBe(30);
    expect(c.snapshot().remainingSec).toBeCloseTo(90, 0);
    // 반복 뒤 계산이 조금 어긋나 고치면, 반복한 만큼도 연주한 거리로 쳐서 속도를 잡는다
    c.setPosition(28, 70); // 70초 동안 60 + 8 = 68박 → 70/68
    expect(c.bpm).toBeCloseTo((60 * 68) / 70, 3);
  });

  test('the end is recognised when the last bar is reached and the sound stops', () => {
    const c = new BeatClock(events, { scoreBpm: 60 });
    drive(c, 0, 121, () => true);
    expect(c.position()).toBe(119);
    expect(c.snapshot().finished).toBe(false);
    drive(c, 121.05, 125, () => false);
    expect(c.snapshot().finished).toBe(true);
    expect(c.snapshot().totalSec).toBeCloseTo(121, 0);
  });
});
