import { describe, expect, test } from 'vitest';
import { FFT } from '../src/audio/fft';
import { FeatureExtractor, LevelGate } from '../src/audio/features';
import { buildEvents } from '../src/follow/build';
import { chromaTemplate } from '../src/follow/tracker';
import { loadSample, run, type RunResult } from './harness';
import { playSegments, withWrongNotes } from './scenarios';

/** 마지막 이벤트까지 도달했고, 소리 나는 동안 ±1음 이내로 맞힌 비율이 기준 이상인지 */
function expectTracked(r: RunResult, near: number, total: number) {
  expect(r.finalIndex).toBe(total - 1);
  expect(r.near).toBeGreaterThanOrEqual(near);
}

describe('FFT', () => {
  test('matches a naive DFT', () => {
    const n = 64;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1) + (i % 5) * 0.01;
    const x = re.slice();
    new FFT(n).transform(re, im);
    for (const k of [0, 1, 7, 20, 33]) {
      let sr = 0;
      let si = 0;
      for (let t = 0; t < n; t++) {
        sr += x[t] * Math.cos((-2 * Math.PI * k * t) / n);
        si += x[t] * Math.sin((-2 * Math.PI * k * t) / n);
      }
      expect(re[k]).toBeCloseTo(sr, 8);
      expect(im[k]).toBeCloseTo(si, 8);
    }
  });
});

describe('features', () => {
  test('chroma of an A4 tone peaks at A', () => {
    const sr = 44100;
    const fx = new FeatureExtractor(sr);
    const x = new Float32Array(sr);
    for (let i = 0; i < x.length; i++) {
      const t = i / sr;
      x[i] = 0.3 * Math.sin(2 * Math.PI * 440 * t) + 0.15 * Math.sin(2 * Math.PI * 880 * t) + 0.1 * Math.sin(2 * Math.PI * 1320 * t);
    }
    const frames = fx.push(x);
    const f = frames[frames.length - 1];
    const best = f.chroma.indexOf(Math.max(...f.chroma));
    expect(best).toBe(9); // A
    expect(f.flatness).toBeLessThan(0.05);
  });

  test('white noise is flagged as noise, not as playing', () => {
    const sr = 44100;
    const fx = new FeatureExtractor(sr);
    const gate = new LevelGate();
    const x = new Float32Array(sr * 2);
    let seed = 1;
    for (let i = 0; i < x.length; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      x[i] = 0.05 * ((seed / 2 ** 32) * 2 - 1);
    }
    const voiced = fx.push(x).map((f) => gate.update(f.rms, f.flatness));
    expect(voiced.filter(Boolean).length).toBe(0);
  });
});

describe('buildEvents', () => {
  test('merges simultaneous notes, skips rests/ties, tracks held notes', () => {
    const events = buildEvents([
      { onset: 0, measure: 1, cursorStep: 0, notes: [{ midi: 48, onset: 0, duration: 2 }, { midi: 64, onset: 0, duration: 1 }] },
      { onset: 1, measure: 1, cursorStep: 1, notes: [{ midi: 67, onset: 1, duration: 1 }] },
      { onset: 2, measure: 1, cursorStep: 2, notes: [] }, // 쉼표 / 붙임줄 이어짐
      { onset: 3, measure: 1, cursorStep: 3, notes: [{ midi: 60, onset: 3, duration: 1 }, { midi: 60, onset: 3, duration: 1 }] },
    ]);
    expect(events.map((e) => e.notes)).toEqual([[48, 64], [67], [60]]);
    expect(events[1].held).toEqual([48]); // 2박짜리 C3가 아직 울림
    expect(events.map((e) => e.beats)).toEqual([1, 2, 1]);
    expect(events.map((e) => e.cursorStep)).toEqual([0, 1, 3]);
  });

  test('templates include harmonics but keep the root strongest', () => {
    const t = chromaTemplate({ notes: [57], held: [], beats: 1, measure: 1, cursorStep: 0 });
    expect(t.indexOf(Math.max(...t))).toBe(9); // A
    expect(t[4]).toBeGreaterThan(0.1); // 3배음 → E
  });
});

describe('score following on synthesized performances', () => {
  const ode = loadSample('ode-to-joy');
  const twinkle = loadSample('twinkle');
  const all = playSegments(ode, [[0, 64]]);

  test('piano at score tempo', () => {
    const r = run(ode, { timbre: 'piano', tempoWobble: 0.05, seed: 3 });
    expectTracked(r, 0.98, ode.events.length);
    expect(r.exact).toBeGreaterThan(0.9);
  });

  test('legato strings, practising much slower than marked (repeated notes)', () => {
    const r = run(twinkle, { timbre: 'strings', bpm: twinkle.bpm * 0.6, tempoWobble: 0.1, seed: 4 });
    expectTracked(r, 0.95, twinkle.events.length);
  });

  test('faster than marked, tracker tempo far off', () => {
    const r = run(ode, { timbre: 'piano', bpm: 140, trackerBpm: 80, tempoWobble: 0.05, seed: 5 });
    expectTracked(r, 0.97, ode.events.length);
  });

  test('polyphonic piano (Bach prelude, held bass notes)', () => {
    const bach = loadSample('bach-prelude-c');
    const r = run(bach, { timbre: 'piano', bpm: bach.bpm * 1.1, tempoWobble: 0.1, seed: 6 });
    expectTracked(r, 0.97, bach.events.length);
  });

  test('holds position while the player pauses', () => {
    const r = run(ode, { timbre: 'piano', pauses: [[16, 3], [40, 2]], tempoWobble: 0.05, seed: 2 });
    expectTracked(r, 0.98, ode.events.length);
  });

  test('wrong notes do not throw the cursor elsewhere', () => {
    const r = run(ode, { timbre: 'piano', play: withWrongNotes(all, 0.1), tempoWobble: 0.05, seed: 2 });
    expectTracked(r, 0.95, ode.events.length);
  });

  test('going back two bars to practise again', () => {
    const r = run(ode, { timbre: 'piano', play: playSegments(ode, [[0, 40], [32, 64]]), tempoWobble: 0.05, seed: 2 });
    expectTracked(r, 0.93, ode.events.length);
  });

  test('restarting from the top is eventually recognised', () => {
    const r = run(ode, { timbre: 'piano', play: playSegments(ode, [[0, 24], [0, 64]]), tempoWobble: 0.05, seed: 2 });
    expectTracked(r, 0.8, ode.events.length);
    // 마지막 두 구절(재시작 이후 충분히 지난 뒤)은 정확해야 한다
    const tail = r.trace.filter((p) => p.truth >= 30);
    const ok = tail.filter((p) => Math.abs(p.idx - p.truth) <= 1).length / tail.length;
    expect(ok).toBeGreaterThan(0.97);
  });

  test('starting from a chosen measure', () => {
    const m9 = ode.events.findIndex((e) => e.measure === 9);
    const r = run(ode, { timbre: 'piano', play: playSegments(ode, [[32, 64]]), startAt: m9, tempoWobble: 0.05, seed: 2 });
    expectTracked(r, 0.98, ode.events.length);
  });

  test('noisy room', () => {
    const r = run(ode, { timbre: 'strings', noise: 0.02, tempoWobble: 0.05, seed: 2 });
    expect(r.near).toBeGreaterThan(0.97);
    expect(r.finalIndex).toBeGreaterThanOrEqual(ode.events.length - 2);
  });
});
