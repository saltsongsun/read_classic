import { describe, expect, test } from 'vitest';
import { FRAME_SEC, KEYS, KeyStream, MODEL_FRAMES, MODEL_RATE, MODEL_SAMPLES, Resampler } from '../src/audio/keyModel';
import { aiKeyStream, runModel } from './aiKeys';
import { loadSample, performance_, run } from './harness';

describe('AI piano note recognition plumbing', () => {
  test('resampling to 22050 Hz keeps the pitch', () => {
    const sr = 48000;
    const x = new Float32Array(sr);
    for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * 440 * i) / sr);
    const r = new Resampler(sr);
    // 블록으로 나눠 넣어도 이어진다
    const parts = [r.push(x.subarray(0, 12345)), r.push(x.subarray(12345))];
    const y = new Float32Array(parts[0].length + parts[1].length);
    y.set(parts[0]);
    y.set(parts[1], parts[0].length);
    expect(Math.abs(y.length - MODEL_RATE)).toBeLessThan(64);
    // 영점 교차로 주파수 확인
    let cross = 0;
    for (let i = 2000; i < y.length - 2000; i++) if (y[i - 1] < 0 && y[i] >= 0) cross++;
    const hz = cross / ((y.length - 4000) / MODEL_RATE);
    expect(Math.abs(hz - 440)).toBeLessThan(3);
  });

  test('the model hears the notes of a chord, with their octave', async () => {
    const x = new Float32Array(MODEL_SAMPLES);
    const hz = (m: number) => 440 * 2 ** ((m - 69) / 12);
    for (let i = 0; i < x.length; i++) {
      const t = i / MODEL_RATE;
      const env = Math.exp(-t * 0.8);
      for (const m of [48, 64, 67]) for (let h = 1; h <= 4; h++) x[i] += (env * 0.15 * Math.sin(2 * Math.PI * hz(m) * h * t)) / h;
    }
    const { note } = await runModel(x);
    const f = 100;
    const frame = Array.from(note.slice(f * KEYS, (f + 1) * KEYS));
    const top = frame.map((v, k) => [v, k + 21]).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, m]) => m).sort();
    expect(top).toEqual([48, 64, 67]); // C3 E4 G4 — 크로마로는 C·E·G 만 안다
  });

  test('stream keeps only new, non-edge frames in time order', () => {
    const s = new KeyStream(48000, async () => ({ note: new Float32Array(), onset: new Float32Array() }));
    const z = new Float32Array(MODEL_FRAMES * KEYS);
    s.accept(z, z, MODEL_SAMPLES);
    const first = s.readyUntil;
    s.accept(z, z, MODEL_SAMPLES + 5512);
    expect(s.readyUntil).toBeGreaterThan(first);
    expect(s.readyUntil).toBeLessThan((MODEL_SAMPLES + 5512) / MODEL_RATE);
    expect(s.at(first - 0.5)).not.toBeNull();
    expect(s.at(first - 0.5)!.time).toBeCloseTo(first - 0.5, 1);
    expect(FRAME_SEC).toBeCloseTo(0.0116, 3);
  });
});

describe('following with AI note recognition', () => {
  test('pedal and hall reverb over dense arpeggios: clearly better than pitch classes alone', async () => {
    const bach = loadSample('bach-prelude-c');
    const opts = { timbre: 'piano' as const, reverb: 0.6, pedalBeats: 4, tempoWobble: 0.08, seed: 5 };
    const { samples, sampleRate } = performance_(bach, opts);
    const keys = await aiKeyStream(samples, sampleRate);
    const chroma = run(bach, opts);
    const ai = run(bach, { ...opts, keys });
    expect(ai.near).toBeGreaterThan(chroma.near + 0.1);
    expect(ai.measureNear).toBeGreaterThan(0.95);
    expect(ai.finalIndex).toBe(bach.events.length - 1);
  }, 300000);
});
