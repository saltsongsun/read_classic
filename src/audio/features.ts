import { FFT, hannWindow, nextPow2 } from './fft';

/** 한 홉(hop)마다 만들어지는 분석 결과. */
export interface AudioFrame {
  /** 프레임 끝 시각(초). 입력 시작 기준. */
  time: number;
  /** 짧은 창의 RMS 레벨. */
  rms: number;
  /** 12개 음이름(C..B) 크로마 벡터. L2 정규화됨 (음이 없으면 0 벡터). */
  chroma: Float64Array;
  /** 정규화 전 크로마 합. 음정 성분이 얼마나 뚜렷한지 나타낸다. */
  tonalness: number;
  /** 0..1 온셋(새 음이 시작됨) 강도. */
  onset: number;
  /** 스펙트럼 평탄도 (0: 뚜렷한 음, 1: 백색 잡음에 가까움). */
  flatness: number;
}

export interface FeatureOptions {
  /** 크로마용 FFT 크기 (기본: 약 85ms에 해당하는 2의 거듭제곱). */
  frameSize?: number;
  /** 홉 크기 (기본: frameSize/4). */
  hopSize?: number;
  /** 온셋 검출용 짧은 FFT 크기 (기본: frameSize/2). */
  onsetSize?: number;
  fmin?: number;
  fmax?: number;
}

const LOG_GAMMA = 100;
const PITCH_SIGMA = 0.22; // 반음 단위. 조율이 조금 어긋나도 허용

/**
 * 마이크 PCM을 받아 크로마·온셋·레벨을 계산한다.
 * 실시간(AudioWorklet)과 오프라인(테스트) 모두에서 같은 코드가 쓰이도록
 * 입력은 임의 길이의 Float32Array 블록으로 받는다.
 */
export class FeatureExtractor {
  readonly sampleRate: number;
  readonly frameSize: number;
  readonly hopSize: number;
  readonly onsetSize: number;

  private readonly fft: FFT;
  private readonly onsetFft: FFT;
  private readonly win: Float64Array;
  private readonly onsetWin: Float64Array;
  private readonly buf: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly ore: Float64Array;
  private readonly oim: Float64Array;
  private readonly mag: Float64Array;
  private readonly logMag: Float64Array;
  private readonly prevOnsetSpec: Float64Array;
  private readonly kmin: number;
  private readonly kmax: number;
  private readonly okmin: number;
  private readonly okmax: number;

  private filled = 0; // buf 안에 유효한 샘플 수
  private pending = 0; // 마지막 프레임 이후 들어온 샘플 수
  private totalSamples = 0;
  private fluxMean = 0;
  private fluxDev = 0;
  private prevFlux = 0;
  private framesSeen = 0;

  constructor(sampleRate: number, opts: FeatureOptions = {}) {
    this.sampleRate = sampleRate;
    this.frameSize = opts.frameSize ?? nextPow2(sampleRate * 0.075);
    this.hopSize = opts.hopSize ?? this.frameSize / 4;
    this.onsetSize = opts.onsetSize ?? this.frameSize / 2;
    this.fft = new FFT(this.frameSize);
    this.onsetFft = new FFT(this.onsetSize);
    this.win = hannWindow(this.frameSize);
    this.onsetWin = hannWindow(this.onsetSize);
    this.buf = new Float64Array(this.frameSize);
    this.re = new Float64Array(this.frameSize);
    this.im = new Float64Array(this.frameSize);
    this.ore = new Float64Array(this.onsetSize);
    this.oim = new Float64Array(this.onsetSize);
    this.mag = new Float64Array(this.frameSize / 2 + 1);
    this.logMag = new Float64Array(this.frameSize / 2 + 1);
    this.prevOnsetSpec = new Float64Array(this.onsetSize / 2 + 1);
    const binHz = sampleRate / this.frameSize;
    this.kmin = Math.max(2, Math.floor((opts.fmin ?? 55) / binHz));
    this.kmax = Math.min(this.frameSize / 2 - 2, Math.ceil((opts.fmax ?? 5000) / binHz));
    const obinHz = sampleRate / this.onsetSize;
    this.okmin = Math.max(1, Math.floor(80 / obinHz));
    this.okmax = Math.min(this.onsetSize / 2 - 1, Math.ceil(8000 / obinHz));
  }

  get hopSec(): number {
    return this.hopSize / this.sampleRate;
  }

  reset(): void {
    this.buf.fill(0);
    this.prevOnsetSpec.fill(0);
    this.filled = 0;
    this.pending = 0;
    this.totalSamples = 0;
    this.fluxMean = 0;
    this.fluxDev = 0;
    this.prevFlux = 0;
    this.framesSeen = 0;
  }

  /** 샘플 블록을 넣고, 완성된 프레임들을 돌려준다. */
  push(samples: Float32Array | Float64Array): AudioFrame[] {
    const out: AudioFrame[] = [];
    const n = this.frameSize;
    let offset = 0;
    while (offset < samples.length) {
      const take = Math.min(this.hopSize - this.pending, samples.length - offset);
      // 버퍼를 왼쪽으로 밀고 새 샘플을 뒤에 붙인다.
      this.buf.copyWithin(0, take);
      for (let i = 0; i < take; i++) this.buf[n - take + i] = samples[offset + i];
      offset += take;
      this.pending += take;
      this.totalSamples += take;
      this.filled = Math.min(n, this.filled + take);
      if (this.pending >= this.hopSize) {
        this.pending = 0;
        if (this.filled >= this.onsetSize) out.push(this.analyze());
      }
    }
    return out;
  }

  private analyze(): AudioFrame {
    const n = this.frameSize;
    const { re, im, buf, win, mag, logMag } = this;

    // ---- 크로마 (긴 창) ----
    for (let i = 0; i < n; i++) {
      re[i] = buf[i] * win[i];
      im[i] = 0;
    }
    this.fft.transform(re, im);
    const scale = 4 / n;
    let maxMag = 0;
    let sumPow = 0;
    let sumLogPow = 0;
    for (let k = this.kmin - 1; k <= this.kmax + 1; k++) {
      const m = Math.hypot(re[k], im[k]) * scale;
      mag[k] = m;
      logMag[k] = Math.log(m + 1e-12);
      if (k >= this.kmin && k <= this.kmax) {
        if (m > maxMag) maxMag = m;
        sumPow += m * m + 1e-20;
        sumLogPow += 2 * logMag[k];
      }
    }
    const nb = this.kmax - this.kmin + 1;
    const flatness = sumPow > 0 ? Math.exp(sumLogPow / nb) / (sumPow / nb) : 1;

    const chroma = new Float64Array(12);
    let tonalness = 0;
    if (maxMag > 1e-7) {
      const binHz = this.sampleRate / n;
      const relFloor = maxMag * 0.003; // -50dB 이하 피크는 무시
      for (let k = this.kmin; k <= this.kmax; k++) {
        const m = mag[k];
        if (m < relFloor || m <= mag[k - 1] || m < mag[k + 1]) continue;
        // 주변 평균보다 확실히 튀어나온 봉우리만 음정 성분으로 본다.
        let local = 0;
        let cnt = 0;
        for (let j = k - 8; j <= k + 8; j++) {
          if (j < this.kmin - 1 || j > this.kmax + 1 || Math.abs(j - k) < 2) continue;
          local += mag[j];
          cnt++;
        }
        if (cnt > 0 && m < 2.0 * (local / cnt)) continue;

        const a = logMag[k - 1];
        const b = logMag[k];
        const c = logMag[k + 1];
        const denom = a - 2 * b + c;
        const delta = denom < 0 ? (0.5 * (a - c)) / denom : 0;
        const freq = (k + Math.max(-0.5, Math.min(0.5, delta))) * binHz;
        if (freq <= 0) continue;
        const midi = 69 + 12 * Math.log2(freq / 440);
        const nearest = Math.round(midi);
        const d = midi - nearest;
        const pitchW = Math.exp(-0.5 * (d / PITCH_SIGMA) ** 2);
        const weight = Math.log(1 + (LOG_GAMMA * m) / maxMag) * pitchW;
        chroma[((nearest % 12) + 12) % 12] += weight;
        tonalness += weight;
      }
    }
    let norm = 0;
    for (let i = 0; i < 12; i++) norm += chroma[i] * chroma[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < 12; i++) chroma[i] /= norm;

    // ---- 온셋 (짧은 창, 스펙트럴 플럭스) ----
    const on = this.onsetSize;
    const { ore, oim, onsetWin, prevOnsetSpec } = this;
    const base = n - on;
    let energy = 0;
    for (let i = 0; i < on; i++) {
      const s = buf[base + i];
      energy += s * s;
      ore[i] = s * onsetWin[i];
      oim[i] = 0;
    }
    const rms = Math.sqrt(energy / on);
    this.onsetFft.transform(ore, oim);
    const oscale = 4 / on;
    let flux = 0;
    for (let k = this.okmin; k <= this.okmax; k++) {
      const v = Math.log(1 + 1000 * Math.hypot(ore[k], oim[k]) * oscale);
      const diff = v - prevOnsetSpec[k];
      if (diff > 0) flux += diff;
      prevOnsetSpec[k] = v;
    }
    flux /= this.okmax - this.okmin + 1;

    // 적응형 문턱값: 최근 플럭스의 평균/편차 대비 얼마나 튀는지
    this.framesSeen++;
    let onset = 0;
    if (this.framesSeen > 3) {
      const z = (flux - this.fluxMean) / (this.fluxDev + 0.01);
      const rising = flux >= this.prevFlux;
      if (rising && flux > 0.02) onset = Math.max(0, Math.min(1, (z - 1.5) / 3));
    }
    const alpha = Math.min(1, this.hopSec / 1.5);
    const clipped = Math.min(flux, this.fluxMean + 4 * (this.fluxDev + 0.01));
    this.fluxMean += alpha * (clipped - this.fluxMean);
    this.fluxDev += alpha * (Math.abs(clipped - this.fluxMean) - this.fluxDev);
    this.prevFlux = flux;

    return {
      time: this.totalSamples / this.sampleRate,
      rms,
      chroma,
      tonalness,
      onset,
      flatness,
    };
  }
}

/**
 * 배경 소음 레벨을 추적해서 "연주 중"인지 판단한다.
 * - 소음 바닥값은 조용할 때 빠르게 내려가고, 잡음처럼 평탄한 소리가 계속되면 그 레벨로 올라간다.
 * - sensitivity가 높을수록 작은 소리도 연주로 간주한다.
 */
export class LevelGate {
  private floor = 1e-3;
  sensitivity = 0.5; // 0..1

  reset(): void {
    this.floor = 1e-3;
  }

  get noiseFloor(): number {
    return this.floor;
  }

  /** 프레임 레벨과 평탄도를 받아 소음 레벨을 갱신하고, 연주 소리가 나는 중이면 true. */
  update(rms: number, flatness = 0): boolean {
    const noiseLike = flatness > NOISE_FLATNESS;
    if (rms < this.floor) this.floor = 0.8 * this.floor + 0.2 * rms;
    else if (noiseLike) this.floor = 0.9 * this.floor + 0.1 * rms;
    else this.floor = this.floor * 1.0002;
    this.floor = Math.min(0.05, Math.max(this.floor, 1e-6));
    // sensitivity 0 → +20dB, 1 → +6dB
    const ratio = Math.pow(10, (20 - 14 * this.sensitivity) / 20);
    return !noiseLike && rms > this.floor * ratio && rms > 3e-4 * (1.2 - this.sensitivity);
  }
}

/** 이 이상 평탄한 스펙트럼은 음이 아니라 잡음으로 본다. */
export const NOISE_FLATNESS = 0.3;
