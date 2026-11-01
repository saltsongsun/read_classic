// 테스트용 간단한 악기 합성기. 악보 음 목록 + 템포 변화 → PCM.
import type { RawNote } from '../src/follow/build';

export type Timbre = 'piano' | 'strings';

export interface SynthOptions {
  sampleRate?: number;
  bpm: number;
  /** 박 단위로 템포가 얼마나 흔들릴지 (0.1 = ±10% 정도). */
  tempoWobble?: number;
  timbre?: Timbre;
  noise?: number;
  seed?: number;
  /** [박 위치, 초] — 해당 박 직전에 그만큼 멈춘다 (연주자가 쉬는 상황). */
  pauses?: Array<[number, number]>;
  /** 음 시작 시각을 흩뜨리는 정도 (초). */
  jitter?: number;
  /** 앞에 붙는 무음 (초). */
  leadIn?: number;
  /** 피아노 오른쪽 페달: 이 박 간격으로 페달을 바꾼다고 보고, 그때까지 음을 끌어 준다. */
  pedalBeats?: number;
  /** 홀 잔향 (0 = 없음, 0.5 = 객석 뒤쪽 정도). */
  reverb?: number;
  /** [시작 초, 길이 초, 세기] — 박수 같은 넓은 대역 잡음 */
  applause?: Array<[number, number, number]>;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 박 위치 → 실제 시각 변환 함수를 만든다 (템포가 천천히 흔들림). */
export function makeTimeMap(maxBeat: number, opts: SynthOptions): (beat: number) => number {
  const rnd = mulberry32(opts.seed ?? 1);
  const step = 0.25;
  const n = Math.ceil(maxBeat / step) + 8;
  const times = new Float64Array(n + 1);
  let factor = 1;
  const wob = opts.tempoWobble ?? 0;
  const pauses = opts.pauses ?? [];
  times[0] = opts.leadIn ?? 0.5;
  for (let i = 0; i < n; i++) {
    // 느린 랜덤워크
    factor += (rnd() - 0.5) * wob * 0.5;
    factor = Math.max(1 - wob, Math.min(1 + wob, factor));
    let dt = (step * 60) / (opts.bpm * factor);
    for (const [b, sec] of pauses) if (b > i * step - 1e-9 && b <= (i + 1) * step - 1e-9) dt += sec;
    times[i + 1] = times[i] + dt;
  }
  return (beat: number) => {
    const x = beat / step;
    const i = Math.min(n - 1, Math.max(0, Math.floor(x)));
    const f = x - i;
    return times[i] + f * (times[i + 1] - times[i]);
  };
}

export function synthesize(notes: RawNote[], opts: SynthOptions): { samples: Float32Array; timeOf: (beat: number) => number; sampleRate: number } {
  const sr = opts.sampleRate ?? 44100;
  const maxBeat = Math.max(...notes.map((n) => n.onset + n.duration));
  const timeOf = makeTimeMap(maxBeat, opts);
  const total = Math.ceil((timeOf(maxBeat) + (opts.reverb ? 3 : 1.5)) * sr);
  const out = new Float64Array(total);
  const rnd = mulberry32((opts.seed ?? 1) * 7919);
  const timbre = opts.timbre ?? 'piano';
  const jitter = opts.jitter ?? 0.01;

  const pedal = opts.pedalBeats;
  for (const note of notes) {
    const t0 = timeOf(note.onset) + (rnd() - 0.5) * 2 * jitter;
    let endBeat = note.onset + note.duration;
    if (pedal) endBeat = Math.max(endBeat, (Math.floor(note.onset / pedal + 1e-9) + 1) * pedal - 0.05);
    const t1 = timeOf(endBeat);
    const f0 = 440 * Math.pow(2, (note.midi - 69) / 12);
    const vel = 0.6 + 0.4 * rnd();
    const start = Math.max(0, Math.floor(t0 * sr));
    const release = timbre === 'piano' ? 0.12 : 0.06;
    let end = Math.min(total, Math.floor((t1 + release) * sr));
    const nh = timbre === 'piano' ? 8 : 10;
    const phases = Array.from({ length: nh }, () => rnd() * 2 * Math.PI);
    const decay = timbre === 'piano' ? 0.6 + 1.6 * Math.exp(-(note.midi - 48) / 24) : 1e9;
    if (timbre === 'piano') end = Math.min(end, start + Math.floor(decay * 7 * sr));
    for (let i = start; i < end; i++) {
      const t = (i - start) / sr;
      const tEnd = t1 - t0;
      let env: number;
      if (timbre === 'piano') {
        env = Math.min(1, t / 0.004) * Math.exp(-t / decay);
      } else {
        env = Math.min(1, t / 0.05);
      }
      if (t > tEnd) env *= Math.max(0, 1 - (t - tEnd) / release);
      if (env <= 1e-5) continue;
      // 비브라토: 순간 주파수 f(1 + d·sin(2πrt)) 를 적분한 위상 편이
      const vibPhase = timbre === 'strings' ? -(0.004 / 5.5) * Math.cos(2 * Math.PI * 5.5 * t) : 0;
      let s = 0;
      for (let h = 1; h <= nh; h++) {
        const fh = f0 * h * (timbre === 'piano' ? Math.sqrt(1 + 0.0004 * h * h) : 1);
        if (fh > sr / 2.2) break;
        const amp = timbre === 'piano' ? 1 / Math.pow(h, 1.1) * Math.exp(-t * h * 0.25) : 1 / Math.pow(h, 1.4);
        s += amp * Math.sin(2 * Math.PI * fh * t + fh * vibPhase + phases[h - 1]);
      }
      out[i] += 0.12 * vel * env * s;
    }
  }
  if (opts.reverb) schroederReverb(out, sr, opts.reverb);
  for (const [start, len, level] of opts.applause ?? []) {
    const a = Math.floor(start * sr);
    const b = Math.min(total, Math.floor((start + len) * sr));
    for (let i = Math.max(0, a); i < b; i++) {
      // 손뼉: 짧은 잡음 덩어리가 무작위로 겹친 소리
      const clap = rnd() < 0.002 ? 1 : 0;
      out[i] += level * (0.4 * (rnd() * 2 - 1) + clap * (rnd() * 2 - 1) * 2);
    }
  }
  const noise = opts.noise ?? 0.002;
  for (let i = 0; i < total; i++) out[i] += noise * (rnd() * 2 - 1);
  const f32 = new Float32Array(total);
  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(out[i]));
  const g = peak > 0.95 ? 0.95 / peak : 1;
  for (let i = 0; i < total; i++) f32[i] = out[i] * g;
  return { samples: f32, timeOf, sampleRate: sr };
}

/**
 * 간단한 슈뢰더 잔향 (병렬 콤 필터 4개 + 직렬 올패스 2개). 잔향 시간 약 2초.
 * wet 은 잔향 소리의 비율.
 */
function schroederReverb(x: Float64Array, sr: number, wet: number): void {
  const combs = [0.0297, 0.0371, 0.0411, 0.0437].map((d) => Math.round(d * sr));
  const rt60 = 2.0;
  const wetBuf = new Float64Array(x.length);
  for (const d of combs) {
    const g = Math.pow(10, (-3 * d) / (sr * rt60));
    const buf = new Float64Array(d);
    let lp = 0;
    let k = 0;
    for (let i = 0; i < x.length; i++) {
      const y = buf[k];
      lp = 0.7 * y + 0.3 * lp; // 고음이 먼저 줄어드는 홀
      buf[k] = x[i] + g * lp;
      wetBuf[i] += y / combs.length;
      k = (k + 1) % d;
    }
  }
  for (const d of [Math.round(0.005 * sr), Math.round(0.0017 * sr)]) {
    const buf = new Float64Array(d);
    let k = 0;
    const g = 0.7;
    for (let i = 0; i < x.length; i++) {
      const delayed = buf[k];
      const v = wetBuf[i] + g * delayed;
      wetBuf[i] = delayed - g * v;
      buf[k] = v;
      k = (k + 1) % d;
    }
  }
  for (let i = 0; i < x.length; i++) x[i] = (1 - wet) * x[i] + wet * 2.5 * wetBuf[i];
}

/** 16-bit PCM mono WAV 파일 바이트를 만든다. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  return new Uint8Array(buf);
}
