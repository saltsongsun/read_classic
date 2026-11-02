/**
 * AI 피아노 음 인식 (Spotify basic-pitch, Apache-2.0): 마이크 소리 → 88건반마다 "지금 울리는 음"·"방금 친 음" 확률.
 *
 * 모델은 22050Hz 소리 2초(43844 샘플)를 받아 그 사이 172개 시점(약 11.6ms 간격)의 확률을 낸다.
 * 실시간으로 쓰려고 HOP 마다 가장 최근 2초를 넣고, 끝자락(오른쪽 문맥이 모자라 덜 정확한 부분)을 뺀
 * 바로 앞 구간만 쓴다. 그래서 결과는 실제보다 LATENCY 초쯤 늦게 나온다 — 추적기는 그만큼 늦게 따라간다.
 *
 * 크로마(음이름 12개)와 달리 옥타브까지 구분하고, 화음 속 각 음을 따로 짚는다. 빽빽한 화음, 반음계가 많은 곡,
 * 같은 음이름이 옥타브만 바뀌는 음형에서 위치를 훨씬 잘 가려낸다.
 */

export const MODEL_RATE = 22050;
export const MODEL_SAMPLES = 43844; // 약 1.99초
export const MODEL_FRAMES = 172;
export const FRAME_SEC = 256 / MODEL_RATE; // 모델 시점 간격 (약 11.6ms)
export const KEYS = 88; // A0(21) ~ C8(108)
export const LOWEST_MIDI = 21;
/** 이만큼 새 소리가 모이면 모델을 한 번 돌린다 (초) */
export const HOP_SEC = 0.25;
/** 창 끝에서 버리는 시점 수 (오른쪽 문맥이 모자라 덜 정확) */
export const EDGE_FRAMES = 8;
/** 실제보다 늦게 나오는 정도 (초, 계산 시간 제외) */
export const LATENCY = HOP_SEC + EDGE_FRAMES * FRAME_SEC;

export interface KeyFrame {
  /** 이 시점의 시각 (입력 시작 기준, 초) */
  time: number;
  /** 88건반 "울리는 음" 확률 */
  note: Float32Array;
  /** 88건반 "방금 친 음" 확률 */
  onset: Float32Array;
}

/** 모델을 돌리는 쪽 (브라우저: 웹 워커, 시험: 바로) */
export type ModelRunner = (window: Float32Array) => Promise<{ note: Float32Array; onset: Float32Array }>;

/**
 * 아무 샘플레이트 → 22050Hz. 낮은 주파수 통과 필터(창 씌운 sinc)를 거쳐 앨리어싱을 막는다.
 * 블록 단위로 이어서 넣을 수 있다.
 */
export class Resampler {
  private readonly ratio: number; // 입력 샘플 / 출력 샘플
  private readonly taps: Float32Array;
  private readonly half: number;
  private buf: Float32Array = new Float32Array(0);
  private pos = 0; // buf 안에서 다음 출력 샘플의 입력 위치

  constructor(inputRate: number) {
    this.ratio = inputRate / MODEL_RATE;
    const cutoff = Math.min(1, 1 / this.ratio) * 0.92; // 출력 나이퀴스트의 92%
    this.half = 16;
    this.taps = new Float32Array(2 * this.half + 1);
    for (let k = -this.half; k <= this.half; k++) {
      const x = k * cutoff;
      const sinc = k === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const win = 0.5 + 0.5 * Math.cos((Math.PI * k) / (this.half + 1));
      this.taps[k + this.half] = cutoff * sinc * win;
    }
  }

  push(input: Float32Array): Float32Array {
    // 남은 앞부분 + 새 입력
    const merged = new Float32Array(this.buf.length + input.length);
    merged.set(this.buf);
    merged.set(input, this.buf.length);
    const out: number[] = [];
    const h = this.half;
    while (this.pos + h + 1 < merged.length) {
      const center = Math.round(this.pos);
      let acc = 0;
      if (center - h >= 0) {
        for (let k = -h; k <= h; k++) acc += merged[center + k] * this.taps[k + h];
      }
      out.push(acc);
      this.pos += this.ratio;
    }
    // 필터 길이만큼 남겨 둔다
    const keepFrom = Math.max(0, Math.floor(this.pos) - h - 1);
    this.buf = merged.slice(keepFrom);
    this.pos -= keepFrom;
    return Float32Array.from(out);
  }
}

/**
 * 마이크 소리를 받아 HOP 마다 모델을 돌리고, 결과를 시각 순서로 쌓는다.
 * 모델이 느려서 밀리면 최신 소리 위주로 건너뛴다 (실시간이 먼저).
 */
export class KeyStream {
  private readonly resampler: Resampler;
  private ring = new Float32Array(MODEL_SAMPLES);
  private filled = 0; // 지금까지 들어온 22050Hz 샘플 수
  private sinceRun = 0;
  private busy = false;
  private readonly frames: KeyFrame[] = [];
  /** 결과가 나와 있는 마지막 시각 (이 시각까지의 소리는 AI 음 인식을 붙여 추적할 수 있다) */
  readyUntil = -Infinity;
  /** 최근 모델 계산 시간 (초) */
  lastRunSec = 0;
  /** 결과를 얼마나 오래 들고 있을지 (초) */
  keepSec = 5;

  constructor(
    inputRate: number,
    private readonly run: ModelRunner,
  ) {
    this.resampler = new Resampler(inputRate);
  }

  /** 마이크 블록을 넣는다. 모델을 돌릴 때가 되면 (앞 계산이 끝났으면) 돌린다. */
  push(block: Float32Array): void {
    const y = this.resampler.push(block);
    if (y.length === 0) return;
    if (y.length >= MODEL_SAMPLES) {
      this.ring.set(y.subarray(y.length - MODEL_SAMPLES));
    } else {
      this.ring.copyWithin(0, y.length);
      this.ring.set(y, MODEL_SAMPLES - y.length);
    }
    this.filled += y.length;
    this.sinceRun += y.length;
    if (this.sinceRun >= HOP_SEC * MODEL_RATE && !this.busy) void this.runNow();
  }

  private async runNow(): Promise<void> {
    this.busy = true;
    this.sinceRun = 0;
    const endSample = this.filled;
    const win = this.ring.slice();
    const t0 = performance.now();
    try {
      const { note, onset } = await this.run(win);
      this.lastRunSec = (performance.now() - t0) / 1000;
      this.accept(note, onset, endSample);
    } finally {
      this.busy = false;
    }
  }

  /** 모델 결과(창 전체) 중 새로 쓸 수 있는 시점들을 쌓는다. endSample: 창 끝의 (22050Hz) 샘플 번호 */
  accept(note: Float32Array, onset: Float32Array, endSample: number): void {
    const endTime = endSample / MODEL_RATE;
    const startTime = endTime - MODEL_SAMPLES / MODEL_RATE;
    for (let f = 0; f < MODEL_FRAMES - EDGE_FRAMES; f++) {
      const time = startTime + (f + 0.5) * FRAME_SEC;
      if (time <= this.readyUntil || time < 0) continue;
      this.frames.push({
        time,
        note: note.slice(f * KEYS, (f + 1) * KEYS),
        onset: onset.slice(f * KEYS, (f + 1) * KEYS),
      });
      this.readyUntil = time;
    }
    // 오래된 것은 버린다 (5초)
    while (this.frames.length && this.frames[0].time < this.readyUntil - this.keepSec) this.frames.shift();
  }

  /** 시각 t 무렵의 결과 (가장 가까운 시점, 두 시점 간격 안). 없으면 null */
  at(t: number): KeyFrame | null {
    const i = this.indexAt(t);
    if (i < 0) return null;
    let best = i;
    if (i + 1 < this.frames.length && Math.abs(this.frames[i + 1].time - t) < Math.abs(this.frames[i].time - t)) best = i + 1;
    return Math.abs(this.frames[best].time - t) <= FRAME_SEC * 2 ? this.frames[best] : null;
  }

  /** t 이하인 마지막 시점의 번호 (없으면 -1) */
  private indexAt(t: number): number {
    let lo = 0;
    let hi = this.frames.length - 1;
    if (hi < 0 || this.frames[0].time > t) return this.frames.length && this.frames[0].time - t < FRAME_SEC ? 0 : -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.frames[mid].time <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** t 무렵 몇 시점 동안의 "방금 친 음" 최대값 (온셋은 한두 시점에만 뜨므로 놓치지 않게) */
  onsetAround(t: number, sec: number): Float32Array | null {
    const out = new Float32Array(KEYS);
    let any = false;
    for (let i = this.indexAt(t); i >= 0; i--) {
      const f = this.frames[i];
      if (f.time < t - sec) break;
      any = true;
      for (let k = 0; k < KEYS; k++) if (f.onset[k] > out[k]) out[k] = f.onset[k];
    }
    return any ? out : null;
  }
}
