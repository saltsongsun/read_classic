import type { AudioFrame } from '../audio/features';
import type { FollowState, ScoreEvent } from './types';

/**
 * 악보 추적기 (HMM 기반).
 *
 * 각 악보 이벤트 j는 두 개의 숨은 상태를 가진다.
 *   A_j (어택: 음이 막 시작된 한 프레임)  →  S_j (지속: 음이 울리는 동안)
 * S_j 에서 다음 음으로 넘어갈 확률은 "이 음에 머문 시간 / 예상 길이(템포 × 박자)"
 * 에 따라 커진다 (체류 시간 기반 해저드). 새 음의 시작(온셋)이 감지되면 더 커진다.
 * S_j → A_{j+1} (다음 음), S_j → A_{j+2} (음 하나 건너뜀).
 *
 * 관측값은 마이크의 크로마 벡터와 온셋 강도이며,
 * 크로마는 악보 이벤트의 배음 템플릿과의 코사인 유사도로 비교한다.
 *
 * 연주자가 앞 구절로 돌아가 다시 연주하거나 건너뛴 경우는
 * "재탐색"으로 처리한다: 최근 몇 초의 연주를 현재 위치 주변 어디서든 시작할 수 있는
 * 모델로 다시 풀어 보고, 그쪽이 지금 추적 경로보다 확실히 더 잘 설명할 때만 옮겨 간다.
 * 틀린 음 하나 때문에 엉뚱한 곳으로 튀지 않도록, 여러 음이 이어서 맞아야 한다.
 */
export interface TrackerOptions {
  /** 프레임 간격(초). */
  hopSec: number;
  /** 악보 템포(BPM). 연주하면서 자동으로 보정된다. */
  bpm?: number;
  /** 크로마 유사도 민감도. 클수록 음정이 정확히 맞아야 넘어간다. */
  sharpness?: number;
  /** 연주자의 템포 변화를 따라갈지. */
  adaptTempo?: boolean;
}

const HARMONIC_WEIGHTS = [1, 0.6, 0.45, 0.35, 0.28, 0.22, 0.18, 0.15];
const SKIP_PROB = 0.04;
const HAZARD_MAX = 0.3;
const PRE_SIM = 0.45; // 시작 전 상태가 갖는 고정 유사도
const ONSET_BOOST = 0.6; // 온셋이 확실할 때 다음 음으로 넘어갈 확률을 얼마나 올릴지

// 크로마 유사도 하한: 틀린 음처럼 어디와도 안 맞는 소리는 모든 위치에 똑같이 불리하게만 작용해서
// 엉뚱한 곳으로 끌려가지 않고 템포대로 흘러가게 한다.
const SIM_FLOOR = 0.5;

// 재탐색
const RELOC_WINDOW_SEC = 2.0; // 비교할 최근 연주 길이
const RELOC_EVERY = 6; // 몇 프레임마다 재탐색할지
const RELOC_BACK = 64; // 현재 위치에서 뒤로 몇 이벤트까지 찾아볼지
const RELOC_FWD = 32; // 앞으로 몇 이벤트까지
const RELOC_MARGIN = 6; // 로그우도가 이만큼(nats) 더 좋아야 옮긴다
const RELOC_TAU_BACK = 24; // 시작 위치 사전확률의 감쇠 (이벤트 수)
const RELOC_TAU_FWD = 8;

function addNote(t: Float64Array, midi: number, gain: number): void {
  for (let h = 0; h < HARMONIC_WEIGHTS.length; h++) {
    const pc = (((midi + Math.round(12 * Math.log2(h + 1))) % 12) + 12) % 12;
    t[pc] += gain * HARMONIC_WEIGHTS[h];
  }
}

function normalize(t: Float64Array): Float64Array {
  let n = 0;
  for (let i = 0; i < t.length; i++) n += t[i] * t[i];
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < t.length; i++) t[i] /= n;
  return t;
}

/** 이벤트의 크로마 템플릿: 새 음 + 계속 울리는 음(약하게). */
export function chromaTemplate(ev: ScoreEvent): Float64Array {
  const t = new Float64Array(12);
  for (const m of ev.notes) addNote(t, m, 1);
  for (const m of ev.held) addNote(t, m, 0.5);
  return normalize(t);
}

/**
 * 머문 시간 비율 r(= 지난 프레임 / 예상 프레임)에 따른 다음 음 전이 확률.
 * - 예상보다 훨씬 빨리 넘어가는 것도 (빠르게 연주할 때) 가능하도록 바닥값을 둔다.
 * - 예상 길이의 두 배를 훌쩍 넘기면 (늘임표, 아주 느린 연습) 다시 낮춰서
 *   한 음을 오래 끄는 연주자를 놓치지 않게 한다.
 */
function hazard(r: number, expected: number): number {
  const floor = Math.min(0.15, 0.3 / expected);
  const lr = Math.log(r);
  const rise = 1 / (1 + Math.exp(-(lr - Math.log(1.15)) / 0.15));
  const fall = 1 - 0.8 / (1 + Math.exp(-(lr - Math.log(2.2)) / 0.2));
  return floor + (HAZARD_MAX - floor) * rise * fall;
}

/** 확률 분포 한 벌 (어택/지속/체류시간). */
class Belief {
  a: Float64Array;
  s: Float64Array;
  e: Float64Array;
  pre = 0;
  constructor(n: number) {
    this.a = new Float64Array(n);
    this.s = new Float64Array(n);
    this.e = new Float64Array(n);
  }
  clear(): void {
    this.a.fill(0);
    this.s.fill(0);
    this.e.fill(0);
    this.pre = 0;
  }
  copyFrom(o: Belief): void {
    this.a.set(o.a);
    this.s.set(o.s);
    this.e.set(o.e);
    this.pre = o.pre;
  }
}

interface HistoryFrame {
  chroma: Float64Array;
  onset: number;
  logLik: number; // 주 추적기가 이 프레임에서 얻은 로그 예측우도
}

export class ScoreFollower {
  readonly events: ScoreEvent[];
  private readonly n: number;
  private readonly tmplS: Float64Array[]; // 지속 상태 템플릿
  private readonly tmplA: Float64Array[]; // 어택 상태 템플릿 (이전 음이 섞여 있음)
  private readonly repeated: Uint8Array; // 바로 앞 이벤트와 같은 음(들)인지
  private readonly expected: Float64Array; // 지속 상태의 예상 프레임 수

  private cur: Belief;
  private next: Belief;
  private altCur: Belief;
  private altNext: Belief;

  private readonly hopSec: number;
  private scoreBpm: number;
  private bpm: number;
  private sharpness: number;
  adaptTempo: boolean;

  private fresh = false; // 위치를 직접 지정한 직후 한 프레임은 전이를 건너뛴다
  private current = -1;
  private confidence = 0;
  private enteredAt = 0; // 현재 이벤트에 들어온 (연주 중) 시각
  private voicedTime = 0; // 소리가 난 시간 누적 (쉼 동안은 멈춤)

  private readonly history: HistoryFrame[] = [];
  private readonly historyLen: number;
  private sinceReloc = 0;

  constructor(events: ScoreEvent[], opts: TrackerOptions) {
    if (events.length === 0) throw new Error('악보에 음표가 없습니다.');
    this.events = events;
    this.n = events.length;
    this.hopSec = opts.hopSec;
    this.scoreBpm = opts.bpm ?? 100;
    this.bpm = this.scoreBpm;
    this.sharpness = opts.sharpness ?? 9;
    this.adaptTempo = opts.adaptTempo ?? true;
    this.historyLen = Math.max(10, Math.round(RELOC_WINDOW_SEC / this.hopSec));

    this.tmplS = events.map(chromaTemplate);
    this.tmplA = events.map((ev, j) => {
      const t = chromaTemplate(ev).slice();
      if (j > 0) {
        const prev = this.tmplS[j - 1];
        for (let i = 0; i < 12; i++) t[i] += 0.6 * prev[i];
      }
      return normalize(t);
    });
    const n = this.n;
    this.repeated = new Uint8Array(n);
    for (let j = 1; j < n; j++) this.repeated[j] = dot(this.tmplS[j - 1], this.tmplS[j]) > 0.97 ? 1 : 0;
    this.expected = new Float64Array(n);
    this.cur = new Belief(n);
    this.next = new Belief(n);
    this.altCur = new Belief(n);
    this.altNext = new Belief(n);
    this.reset();
  }

  get tempo(): number {
    return this.bpm;
  }

  get position(): number {
    return this.current;
  }

  setSharpness(v: number): void {
    this.sharpness = v;
  }

  setScoreTempo(bpm: number): void {
    this.scoreBpm = bpm;
    this.bpm = bpm;
    this.updateExpected();
  }

  /** 처음(첫 음 연주 전)으로 되돌린다. */
  reset(): void {
    this.cur.clear();
    this.cur.pre = 1;
    this.current = -1;
    this.confidence = 1;
    this.fresh = false;
    this.bpm = this.scoreBpm;
    this.history.length = 0;
    this.sinceReloc = 0;
    this.updateExpected();
  }

  /** 사용자가 위치를 직접 지정 (해당 음을 지금 연주하고 있거나 곧 연주한다고 가정). */
  setPosition(index: number): void {
    const j = Math.max(0, Math.min(this.n - 1, index));
    this.cur.clear();
    this.cur.a[j] = 0.5;
    this.cur.s[j] = 0.5;
    this.current = j;
    this.confidence = 1;
    this.fresh = true;
    this.enteredAt = this.voicedTime;
    this.history.length = 0;
    this.sinceReloc = 0;
  }

  private updateExpected(): void {
    const framesPerBeat = 60 / this.bpm / this.hopSec;
    for (let j = 0; j < this.n; j++) {
      this.expected[j] = Math.max(1, this.events[j].beats * framesPerBeat - 1);
    }
  }

  /** 오디오 프레임 하나를 반영하고 현재 위치를 돌려준다. */
  update(frame: AudioFrame, voiced: boolean): FollowState {
    if (!voiced || frame.tonalness <= 0) {
      return { index: this.current, confidence: this.confidence, bpm: this.bpm, voiced: false };
    }
    this.voicedTime += this.hopSec;

    let total: number;
    if (this.fresh) {
      this.fresh = false;
      this.next.copyFrom(this.cur);
      total = this.observe(this.next, frame, 0, this.n - 1);
    } else {
      total = this.step(this.cur, this.next, frame, 0, this.n - 1);
    }
    if (!(total > 0) || !Number.isFinite(total)) {
      // 수치적으로 모든 확률이 사라졌다면 현재 위치에서 다시 시작
      this.setPosition(Math.max(0, this.current));
      return { index: this.current, confidence: 0, bpm: this.bpm, voiced: true };
    }
    [this.cur, this.next] = [this.next, this.cur];

    // 최근 연주 기록 (재탐색용)
    this.history.push({ chroma: frame.chroma, onset: frame.onset, logLik: Math.log(total) });
    if (this.history.length > this.historyLen) this.history.shift();
    if (++this.sinceReloc >= RELOC_EVERY && this.history.length >= this.historyLen) {
      this.sinceReloc = 0;
      this.relocalize();
    }

    const { best, bestP } = this.argmax(this.cur, 0, this.n - 1);
    if (best !== this.current) {
      this.onAdvance(this.current, best);
      this.current = best;
    }
    this.confidence = bestP;
    return { index: this.current, confidence: bestP, bpm: this.bpm, voiced: true };
  }

  private argmax(b: Belief, lo: number, hi: number): { best: number; bestP: number } {
    let best = -1;
    let bestP = b.pre;
    for (let j = lo; j <= hi; j++) {
      const p = b.a[j] + b.s[j];
      if (p > bestP) {
        bestP = p;
        best = j;
      }
    }
    return { best, bestP };
  }

  /** 전이 + 관측. from → to 로 계산하고 정규화 전 합(예측우도)을 돌려준다. */
  private step(from: Belief, to: Belief, frame: AudioFrame, lo: number, hi: number): number {
    const { expected } = this;
    const o = frame.onset;
    const { a, s, e } = from;
    const na = to.a;
    const ns = to.s;
    const ne = to.e;
    na.fill(0, lo, hi + 1);
    ns.fill(0, lo, hi + 1);
    ne.fill(0, lo, hi + 1);

    let pre = from.pre;
    if (pre > 0) {
      const preStay = 0.9 * (1 - ONSET_BOOST * o);
      na[lo] += pre * (1 - preStay) * (1 - SKIP_PROB);
      if (lo + 1 <= hi) na[lo + 1] += pre * (1 - preStay) * SKIP_PROB;
      pre *= preStay;
    }
    to.pre = pre;
    const last = this.n - 1;
    for (let j = lo; j <= hi; j++) {
      const sj = s[j];
      let h = 0;
      if (j < last && sj > 0) {
        h = hazard((e[j] + 1) / expected[j], expected[j]);
        h += (1 - h) * ONSET_BOOST * o;
        const out = sj * h;
        if (j + 1 <= hi) na[j + 1] += out * (j + 2 <= last ? 1 - SKIP_PROB : 1);
        if (j + 2 <= hi) na[j + 2] += out * SKIP_PROB;
      }
      const keep = sj * (1 - h);
      const v = a[j] + keep;
      ns[j] = v;
      ne[j] = v > 0 ? (keep * (e[j] + 1) + a[j]) / v : 0;
    }
    return this.observe(to, frame, lo, hi);
  }

  /** 관측 우도를 곱하고 정규화한다. 정규화 전 합을 돌려준다. */
  private observe(b: Belief, frame: AudioFrame, lo: number, hi: number): number {
    const chroma = frame.chroma;
    const beta = this.sharpness;
    const o = frame.onset;
    const pOnA = 0.3 + 0.7 * o; // 어택 상태에서 이 정도 온셋이 보일 가능성
    const pOnArep = 0.06 + 0.94 * o; // 같은 음을 다시 칠 때는 온셋이 거의 꼭 있어야 한다
    const pOnS = 1 - 0.85 * o; // 지속 상태에서 이 정도 온셋이 보일 가능성
    const { a, s } = b;
    let total = 0;
    for (let j = lo; j <= hi; j++) {
      if (a[j] > 1e-300) {
        const sim = Math.max(SIM_FLOOR, dot(chroma, this.tmplA[j]));
        a[j] *= Math.exp(beta * (sim - 1)) * (this.repeated[j] ? pOnArep : pOnA);
      } else a[j] = 0;
      if (s[j] > 1e-300) {
        const sim = Math.max(SIM_FLOOR, dot(chroma, this.tmplS[j]));
        s[j] *= Math.exp(beta * (sim - 1)) * pOnS;
      } else s[j] = 0;
      total += a[j] + s[j];
    }
    if (b.pre > 0) {
      b.pre *= Math.exp(beta * (PRE_SIM - 1));
      total += b.pre;
    }
    if (total > 0 && Number.isFinite(total)) {
      const inv = 1 / total;
      for (let j = lo; j <= hi; j++) {
        a[j] *= inv;
        s[j] *= inv;
      }
      b.pre *= inv;
    }
    return total;
  }

  /**
   * 최근 연주를 "현재 위치 주변 아무 데서나 시작"하는 모델로 다시 풀어서,
   * 지금 경로보다 훨씬 그럴듯하면 그쪽으로 옮긴다.
   */
  private relocalize(): void {
    const center = Math.max(0, this.current);
    const lo = Math.max(0, center - RELOC_BACK);
    const hi = Math.min(this.n - 1, center + RELOC_FWD);
    let b = this.altCur;
    let nb = this.altNext;
    b.clear();
    nb.clear();
    // 시작 위치 사전확률: 지금 위치에 가까울수록 높게 (뒤로 돌아가는 연습이 앞으로 건너뛰기보다 흔하다).
    // 같은 선율이 여러 번 나오는 곡에서 멀리 있는 똑같은 구간으로 건너뛰지 않게 해 준다.
    let z = 0;
    for (let j = lo; j <= hi; j++) {
      const d = j - (center);
      const w = Math.exp(d < 0 ? d / RELOC_TAU_BACK : -d / RELOC_TAU_FWD);
      b.a[j] = w;
      b.s[j] = w;
      z += 2 * w;
    }
    for (let j = lo; j <= hi; j++) {
      b.a[j] /= z;
      b.s[j] /= z;
    }
    let altLL = 0;
    let mainLL = 0;
    const frame: AudioFrame = { time: 0, rms: 0, tonalness: 1, flatness: 0, chroma: new Float64Array(12), onset: 0 };
    for (let i = 0; i < this.history.length; i++) {
      const h = this.history[i];
      frame.chroma = h.chroma;
      frame.onset = h.onset;
      let tot: number;
      if (i === 0) tot = this.observe(b, frame, lo, hi);
      else {
        tot = this.step(b, nb, frame, lo, hi);
        [b, nb] = [nb, b];
      }
      if (!(tot > 0)) return;
      altLL += Math.log(tot);
      mainLL += h.logLik;
    }
    this.altCur = b;
    this.altNext = nb;
    if (altLL - mainLL < RELOC_MARGIN) return;

    // 확률이 비슷한 후보가 여럿이면 (같은 선율 반복) 지금 위치에서 가까운 쪽을 고른다
    const { bestP } = this.argmax(b, lo, hi);
    let best = -1;
    for (let j = lo; j <= hi; j++) {
      const p = b.a[j] + b.s[j];
      if (p >= 0.5 * bestP && (best < 0 || Math.abs(j - center) < Math.abs(best - center))) best = j;
    }
    if (best < 0 || Math.abs(best - this.current) <= 2) return;
    // 재탐색 결과를 주 추적기 분포로 채택
    this.cur.clear();
    for (let j = lo; j <= hi; j++) {
      this.cur.a[j] = b.a[j];
      this.cur.s[j] = b.s[j];
      this.cur.e[j] = b.e[j];
    }
    // 같은 평가가 반복되지 않도록 기록의 우도를 새 경로 기준으로 맞춘다
    const share = altLL / this.history.length;
    for (const h of this.history) h.logLik = share;
    this.enteredAt = this.voicedTime;
  }

  /** 한 음씩 순서대로 넘어갈 때 실제 걸린 시간으로 템포를 보정한다. */
  private onAdvance(from: number, to: number): void {
    const now = this.voicedTime;
    if (this.adaptTempo && from >= 0 && to === from + 1) {
      const dur = now - this.enteredAt;
      const beats = this.events[from].beats;
      if (dur > 0.05 && beats > 0) {
        const inst = (60 * beats) / dur;
        const lo = Math.max(30, this.scoreBpm * 0.4);
        const hi = Math.min(320, this.scoreBpm * 2.5);
        if (inst > lo * 0.7 && inst < hi * 1.4) {
          const clamped = Math.max(lo, Math.min(hi, inst));
          // 로그 영역에서 부드럽게
          const w = Math.min(0.4, 0.18 * Math.max(0.25, beats));
          this.bpm = Math.exp((1 - w) * Math.log(this.bpm) + w * Math.log(clamped));
          this.updateExpected();
        }
      }
    }
    this.enteredAt = now;
  }
}

function dot(x: Float64Array, y: Float64Array): number {
  let d = 0;
  for (let i = 0; i < 12; i++) d += x[i] * y[i];
  return d;
}
