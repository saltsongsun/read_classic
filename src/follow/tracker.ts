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
  /**
   * 추적 단위의 최소 길이(초, 악보 템포 기준). 이보다 짧은 음들은 묶어서 한 단위로 추적하고,
   * 단위 안에서의 음 위치는 시간으로 나눠 표시한다. 홀 잔향·페달로 빠른 음들이 뭉개질 때 강하다.
   */
  minUnitSec?: number;
  /**
   * 지나간 곳으로 돌아갈지.
   * - 'repeats' (기본, 콩쿠르): 앞으로만 간다. 단, 도돌이표(repeats)에서 연주자가 실제로 반복하면
   *   그 구간의 시작으로 한 번 돌아간다. 반복을 건너뛰면 그대로 앞으로 간다.
   * - 'free' (연습): 앞 구절로 돌아가 다시 치면 어디든 따라간다.
   */
  backward?: 'repeats' | 'free';
  /** 도돌이표: from(반복 구간 마지막 이벤트)에서 to(구간 첫 이벤트)로 돌아갈 수 있다 */
  repeats?: RepeatJump[];
}

export interface RepeatJump {
  from: number;
  to: number;
}

/** 추적 단위: 연속된 악보 이벤트 [first, last] */
interface Unit {
  first: number;
  last: number;
  beats: number;
}

const MIN_UNIT_SEC = 0; // 기본은 음 하나하나를 추적 (묶으면 마른 소리에서 오히려 나빠짐)

/** 짧은 이벤트들을 묶는다. 마디가 바뀌는 곳에서는 끊는다. */
function groupUnits(events: ScoreEvent[], minBeats: number): Unit[] {
  const units: Unit[] = [];
  let cur: Unit | null = null;
  events.forEach((ev, i) => {
    if (cur && (cur.beats >= minBeats || ev.measure !== events[cur.first].measure)) {
      units.push(cur);
      cur = null;
    }
    if (!cur) cur = { first: i, last: i, beats: ev.beats };
    else {
      cur.last = i;
      cur.beats += ev.beats;
    }
  });
  if (cur) units.push(cur);
  return units;
}

/** 단위 하나를 이벤트 하나처럼 보이게 합친다 (템플릿 계산용). */
function mergeUnit(events: ScoreEvent[], u: Unit): ScoreEvent {
  const notes = new Set<number>();
  for (let i = u.first; i <= u.last; i++) for (const m of events[i].notes) notes.add(m);
  const first = events[u.first];
  return {
    notes: [...notes],
    held: first.held.filter((m) => !notes.has(m)),
    beats: u.beats,
    measure: first.measure,
    cursorStep: first.cursorStep,
  };
}

const HARMONIC_WEIGHTS = [1, 0.6, 0.45, 0.35, 0.28, 0.22, 0.18, 0.15];
const SKIP_PROB = 0.04;
const HAZARD_MAX = 0.3;
const PRE_SIM = 0.45; // 시작 전 상태가 갖는 고정 유사도
const ONSET_BOOST = 0.6; // 온셋이 확실할 때 다음 음으로 넘어갈 확률을 얼마나 올릴지

// 크로마 유사도 하한: 틀린 음처럼 어디와도 안 맞는 소리는 모든 위치에 똑같이 불리하게만 작용해서
// 엉뚱한 곳으로 끌려가지 않고 템포대로 흘러가게 한다.
const SIM_FLOOR = 0.5;
/** 온셋 프레임에서 어택 상태 유사도에 "새로 생긴 소리" 크로마를 섞는 최대 비율 */
const ATTACK_MIX = 0.6;

// 재탐색
const RELOC_WINDOW_SEC = 2.0; // 비교할 최근 연주 길이
const RELOC_EVERY = 6; // 몇 프레임마다 재탐색할지
const RELOC_BACK = 64; // 현재 위치에서 뒤로 몇 이벤트까지 찾아볼지
const RELOC_FWD = 32; // 앞으로 몇 이벤트까지
const RELOC_MARGIN = 16; // 로그우도가 이만큼(nats) 더 좋아야 옮긴다 (프레임끼리 비슷해서 증거가 부풀려지므로 넉넉하게)
const RELOC_TAU_BACK = 24; // 시작 위치 사전확률의 감쇠 (이벤트 수). 앞 구절로 돌아가 다시 치는 일은 흔하다
const RELOC_TAU_FWD = 3; // 앞으로 건너뛰는 일은 드물다
const RELOC_CONFIRM = 2; // 같은 결론이 몇 번 연속 나와야 옮길지
const RELOC_MIN_SIM = 0.72; // 옮겨 갈 곳의 평균 유사도 하한
// 도돌이표로 돌아가기: 반복 구간 끝 근처에 있을 때만 구간 시작 주변을 찾아본다
const REPEAT_AFTER = 16; // 구간 끝을 지나 이만큼까지 (돌아간 걸 알아채는 사이 앞으로 흘러가 있을 수 있다)
const REPEAT_SPAN = 24; // 구간 시작에서 이만큼까지 찾아본다
const REPEAT_MIN_SEC = 0.8; // 구간 끝에 닿은 뒤 이만큼은 들어 봐야 판단한다
const REPEAT_LISTEN_SEC = 1.0; // 판단에 쓰는 최근 소리 길이
const REPEAT_MARGIN = 8; // 도돌이표로 돌아갈 때 필요한 증거 (nats). 갈 곳이 정해져 있어 일반 재탐색보다 덜 엄격하다
const LOCAL_BACK = 8; // 콩쿠르 모드에서도 이 정도(음 몇 개, 한두 박)는 되돌려 바로잡는다 (추적기가 먼저 나간 경우)
// 시간 힌트 (위치를 놓쳤을 때 흐른 시간으로 어림한 위치): 그 주변도 찾아본다
const HINT_SPAN = 24; // 힌트 앞뒤로 몇 단위까지
const HINT_TAU = 8; // 힌트 주변 사전확률의 감쇠
const RELOC_MAX_SPAN = 400; // 한 번에 찾아볼 최대 범위 (계산량)

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
 * 페달·홀 잔향으로 앞서 친 음이 남아 울리는 정도 (박 단위 감쇠).
 * 지속 상태는 "마른" 템플릿과 이 "울리는" 템플릿 중 더 잘 맞는 쪽을 쓰므로, 방 소리에 맞춰 저절로 고른다.
 */
export const RING = { gain: 1.0, tau: 2, window: 4 };

/**
 * 울림까지 넣은 템플릿: 바로 앞 몇 박 안에 친 음들을 거리에 따라 약하게 더한다.
 * 피아노는 페달과 홀 잔향 때문에 분산화음의 앞 음들이 계속 들리므로, 이게 없으면
 * 지금 음보다 "울리는 화음 전체"에 더 잘 맞는 음 위치에 붙어 버린다.
 */
export function ringingTemplates(events: ScoreEvent[]): Float64Array[] {
  const onset: number[] = [];
  let b = 0;
  for (const e of events) {
    onset.push(b);
    b += e.beats;
  }
  return events.map((ev, j) => {
    const t = new Float64Array(12);
    for (const m of ev.notes) addNote(t, m, 1);
    for (const m of ev.held) addNote(t, m, 0.5);
    if (RING.gain > 0) {
      const present = new Set([...ev.notes, ...ev.held]);
      const ringing = new Map<number, number>();
      for (let k = j - 1; k >= 0 && onset[j] - onset[k] <= RING.window; k--) {
        const w = RING.gain * Math.exp(-(onset[j] - onset[k]) / RING.tau);
        for (const m of events[k].notes) {
          if (!present.has(m)) ringing.set(m, Math.max(ringing.get(m) ?? 0, w));
        }
      }
      for (const [m, w] of ringing) addNote(t, m, w);
    }
    return normalize(t);
  });
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
  attack: Float64Array;
  onset: number;
  logLik: number; // 주 추적기가 이 프레임에서 얻은 로그 예측우도
}

export class ScoreFollower {
  readonly events: ScoreEvent[];
  private readonly units: Unit[];
  private readonly n: number; // 단위 수
  private readonly tmplS: Float64Array[]; // 지속 상태 템플릿 (마른 소리)
  private readonly tmplWet: Float64Array[] | null; // 앞 음들이 남아 울리는 경우 (페달·홀 잔향)
  private readonly tmplA: Float64Array[]; // 어택 상태 템플릿 (이전 음이 섞여 있음)
  private readonly tmplNew: Float64Array[]; // 이 이벤트에서 새로 치는 음만
  private readonly repeated: Uint8Array; // 바로 앞 이벤트와 같은 음(들)인지
  private readonly expected: Float64Array; // 지속 상태의 예상 프레임 수

  private cur: Belief;
  private next: Belief;
  private altCur: Belief;
  private altNext: Belief;
  private spareCur: Belief; // 도돌이표 후보를 따로 풀어 볼 때
  private spareNext: Belief;

  private readonly hopSec: number;
  private scoreBpm: number;
  private bpm: number;
  private sharpness: number;
  adaptTempo: boolean;

  private fresh = false; // 위치를 직접 지정한 직후 한 프레임은 전이를 건너뛴다
  private current = -1; // 현재 단위
  private currentEvent = -1; // 현재 이벤트 (화면 표시용)
  private confidence = 0;
  private enteredAt = 0; // 현재 이벤트에 들어온 (연주 중) 시각
  private voicedTime = 0; // 소리가 난 시간 누적 (쉼 동안은 멈춤)

  private readonly history: HistoryFrame[] = [];
  private readonly historyLen: number;
  private sinceReloc = 0;
  private relocCandidate = -1;
  private relocVotes = 0;
  private hintUnit = -1;
  private readonly backward: 'repeats' | 'free';
  private readonly repeatUnits: Array<{ from: number; to: number; used: boolean; reachedAt: number }>;
  private frameNo = 0; // 소리 난 프레임 수
  private repeatNow = -1; // 이번 재탐색에서 고른 도돌이표
  private jumpedBack = false; // 방금 도돌이표로 돌아갔다

  constructor(events: ScoreEvent[], opts: TrackerOptions) {
    if (events.length === 0) throw new Error('악보에 음표가 없습니다.');
    this.events = events;
    this.hopSec = opts.hopSec;
    this.scoreBpm = opts.bpm ?? 100;
    this.units = groupUnits(events, ((opts.minUnitSec ?? MIN_UNIT_SEC) * this.scoreBpm) / 60);
    this.n = this.units.length;
    const unitEvents = this.units.map((u) => mergeUnit(events, u));
    this.bpm = this.scoreBpm;
    this.sharpness = opts.sharpness ?? 9;
    this.adaptTempo = opts.adaptTempo ?? true;
    this.historyLen = Math.max(10, Math.round(RELOC_WINDOW_SEC / this.hopSec));
    this.backward = opts.backward ?? 'repeats';
    this.repeatUnits = (opts.repeats ?? [])
      .filter((r) => r.to < r.from && r.from < events.length)
      .map((r) => ({ from: this.unitOf(r.from), to: this.unitOf(r.to), used: false, reachedAt: -1 }));

    this.tmplS = unitEvents.map(chromaTemplate);
    this.tmplWet = RING.gain > 0 ? ringingTemplates(unitEvents) : null;
    this.tmplA = unitEvents.map((ev, j) => {
      const t = chromaTemplate(ev).slice();
      if (j > 0) {
        const prev = this.tmplS[j - 1];
        for (let i = 0; i < 12; i++) t[i] += 0.6 * prev[i];
      }
      return normalize(t);
    });
    // 어택 상태는 단위의 첫 음과 비교
    this.tmplNew = this.units.map((u) => chromaTemplate({ ...events[u.first], held: [] }));
    const n = this.n;
    this.repeated = new Uint8Array(n);
    for (let j = 1; j < n; j++) {
      const prevLast = chromaTemplate({ ...events[this.units[j - 1].last], held: [] });
      this.repeated[j] = dot(prevLast, this.tmplNew[j]) > 0.97 ? 1 : 0;
    }
    this.expected = new Float64Array(n);
    this.cur = new Belief(n);
    this.next = new Belief(n);
    this.altCur = new Belief(n);
    this.altNext = new Belief(n);
    this.spareCur = new Belief(n);
    this.spareNext = new Belief(n);
    this.reset();
  }

  get tempo(): number {
    return this.bpm;
  }

  /** 현재 이벤트 인덱스 (시작 전이면 -1). */
  get position(): number {
    return this.currentEvent;
  }

  private unitOf(eventIndex: number): number {
    let lo = 0;
    let hi = this.n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.units[mid].first <= eventIndex) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** 단위 안에서 머문 시간으로 지금 몇 번째 음인지 나눈다. */
  private eventInUnit(u: number): number {
    const unit = this.units[u];
    if (unit.first === unit.last) return unit.first;
    const frac = Math.min(0.999, Math.max(0, (this.cur.e[u] + 1) / (this.expected[u] + 1)));
    const target = frac * unit.beats;
    let acc = 0;
    for (let i = unit.first; i <= unit.last; i++) {
      acc += this.events[i].beats;
      if (acc > target) return i;
    }
    return unit.last;
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
    this.currentEvent = -1;
    this.confidence = 1;
    this.fresh = false;
    this.bpm = this.scoreBpm;
    this.history.length = 0;
    this.sinceReloc = 0;
    for (const r of this.repeatUnits) {
      r.used = false;
      r.reachedAt = -1;
    }
    this.updateExpected();
  }

  /** 사용자가 위치를 직접 지정 (해당 음을 지금 연주하고 있거나 곧 연주한다고 가정). */
  setPosition(index: number): void {
    const ev = Math.max(0, Math.min(this.events.length - 1, index));
    const j = this.unitOf(ev);
    this.cur.clear();
    this.cur.a[j] = 0.5;
    this.cur.s[j] = 0.5;
    // 단위 중간의 음을 골랐다면 그만큼 지난 것으로
    let before = 0;
    for (let i = this.units[j].first; i < ev; i++) before += this.events[i].beats;
    this.cur.e[j] = (before * 60) / this.bpm / this.hopSec;
    this.current = j;
    this.currentEvent = ev;
    this.confidence = 1;
    this.fresh = true;
    this.enteredAt = this.voicedTime;
    this.history.length = 0;
    this.sinceReloc = 0;
  }

  private updateExpected(): void {
    const framesPerBeat = 60 / this.bpm / this.hopSec;
    for (let j = 0; j < this.n; j++) {
      this.expected[j] = Math.max(1, this.units[j].beats * framesPerBeat - 1);
    }
  }

  /** 오디오 프레임 하나를 반영하고 현재 위치를 돌려준다. */
  update(frame: AudioFrame, voiced: boolean): FollowState {
    if (!voiced || frame.tonalness <= 0) {
      return { index: this.currentEvent, confidence: this.confidence, bpm: this.bpm, voiced: false };
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
      this.setPosition(Math.max(0, this.currentEvent));
      return { index: this.currentEvent, confidence: 0, bpm: this.bpm, voiced: true };
    }
    [this.cur, this.next] = [this.next, this.cur];

    // 최근 연주 기록 (재탐색용)
    this.history.push({ chroma: frame.chroma, attack: frame.attack, onset: frame.onset, logLik: Math.log(total) });
    if (this.history.length > this.historyLen) this.history.shift();
    if (++this.sinceReloc >= RELOC_EVERY && this.history.length >= this.historyLen) {
      this.sinceReloc = 0;
      this.relocalize();
    }

    let { best, bestP } = this.argmax(this.cur, 0, this.n - 1);
    // 앞으로만 가는 모드: 확률이 잠깐 앞 음으로 쏠려도 표시 위치는 되돌리지 않는다 (도돌이표 이동은 relocalize 에서)
    if (this.backward !== 'free' && best >= 0 && best < this.current - LOCAL_BACK && !this.jumpedBack) best = this.current;
    this.jumpedBack = false;
    if (best !== this.current) {
      this.onAdvance(this.current, best);
      this.current = best;
    }
    this.frameNo++;
    for (const r of this.repeatUnits) if (!r.used && r.reachedAt < 0 && best >= r.from - 1) r.reachedAt = this.frameNo;
    this.currentEvent = best < 0 ? -1 : this.eventInUnit(best);
    this.confidence = bestP;
    return { index: this.currentEvent, confidence: bestP, bpm: this.bpm, voiced: true };
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
    const attack = frame.attack;
    const beta = this.sharpness;
    const o = frame.onset;
    // 새 음이 시작된 프레임에서는 "새로 생긴 소리"가 어택 상태 판단에 더 믿을 만하다
    const lam = attack ? ATTACK_MIX * o : 0;
    const pOnA = 0.3 + 0.7 * o; // 어택 상태에서 이 정도 온셋이 보일 가능성
    const pOnArep = 0.06 + 0.94 * o; // 같은 음을 다시 칠 때는 온셋이 거의 꼭 있어야 한다
    const pOnS = 1 - 0.85 * o; // 지속 상태에서 이 정도 온셋이 보일 가능성
    const { a, s } = b;
    let total = 0;
    for (let j = lo; j <= hi; j++) {
      if (a[j] > 1e-300) {
        let raw = dot(chroma, this.tmplA[j]);
        if (lam > 0) raw = (1 - lam) * raw + lam * dot(attack, this.tmplNew[j]);
        const sim = Math.max(SIM_FLOOR, raw);
        a[j] *= Math.exp(beta * (sim - 1)) * (this.repeated[j] ? pOnArep : pOnA);
      } else a[j] = 0;
      if (s[j] > 1e-300) {
        let raw = dot(chroma, this.tmplS[j]);
        if (this.tmplWet) raw = Math.max(raw, dot(chroma, this.tmplWet[j]));
        const sim = Math.max(SIM_FLOOR, raw);
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
   * 시간 힌트: 위치를 놓쳤을 때 흐른 시간으로 어림한 이벤트 번호 (null 이면 없앰).
   * 재탐색할 때 지금 위치 주변뿐 아니라 이 주변도 찾아본다. 소리가 실제로 맞아야만 옮겨 간다.
   */
  setHint(eventIndex: number | null): void {
    this.hintUnit = eventIndex === null || eventIndex < 0 ? -1 : this.unitOf(Math.min(eventIndex, this.events.length - 1));
  }

  /**
   * 최근 연주(history)를 [lo, hi] 안 아무 데서나 시작할 수 있는 모델로 다시 푼다 (altCur/altNext 사용).
   * 숫자 문제로 풀 수 없으면 null.
   */
  private searchWindow(
    lo: number,
    hi: number,
    prior: (j: number) => number,
    start = 0,
  ): { lo: number; hi: number; altLL: number; mainLL: number; b: Belief; frames: number } | null {
    let b = this.altCur;
    let nb = this.altNext;
    b.clear();
    nb.clear();
    let z = 0;
    for (let j = lo; j <= hi; j++) {
      const w = prior(j);
      b.a[j] = w;
      b.s[j] = w;
      z += 2 * w;
    }
    if (!(z > 0)) return null;
    for (let j = lo; j <= hi; j++) {
      b.a[j] /= z;
      b.s[j] /= z;
    }
    let altLL = 0;
    let mainLL = 0;
    const frame: AudioFrame = { time: 0, rms: 0, tonalness: 1, flatness: 0, chroma: new Float64Array(12), attack: new Float64Array(12), onset: 0 };
    for (let i = start; i < this.history.length; i++) {
      const h = this.history[i];
      frame.chroma = h.chroma;
      frame.attack = h.attack;
      frame.onset = h.onset;
      let tot: number;
      if (i === start) tot = this.observe(b, frame, lo, hi);
      else {
        tot = this.step(b, nb, frame, lo, hi);
        [b, nb] = [nb, b];
      }
      if (!(tot > 0)) return null;
      altLL += Math.log(tot);
      mainLL += h.logLik;
    }
    this.altCur = b;
    this.altNext = nb;
    return { lo, hi, altLL, mainLL, b, frames: this.history.length - start };
  }

  /**
   * 최근 연주를 "현재 위치 주변 아무 데서나 시작"하는 모델로 다시 풀어서,
   * 지금 경로보다 훨씬 그럴듯하면 그쪽으로 옮긴다.
   */
  private relocalize(): void {
    // 마지막 음에 도달했으면 곡이 끝난 것: 뒤따르는 박수·잡음으로 위치를 바꾸지 않는다
    if (this.current >= this.n - 1) return;
    const center = Math.max(0, this.current);
    const free = this.backward === 'free';
    // 찾아볼 범위: 연습 모드는 앞뒤로, 콩쿠르 모드는 지금 위치부터 앞으로만
    let lo = Math.max(0, center - (free ? RELOC_BACK : LOCAL_BACK));
    let hi = Math.min(this.n - 1, center + RELOC_FWD);
    // 시간 힌트는 앞이든 뒤든 쓴다. 뒤쪽 힌트는 추적기가 연주보다 앞질러 갔을 때다 (연주자는 그만큼 빨리 갈 수 없다)
    const hint = this.hintUnit;
    if (hint >= 0) {
      lo = Math.max(0, Math.min(lo, hint - HINT_SPAN));
      hi = Math.min(this.n - 1, Math.max(hi, hint + HINT_SPAN));
      if (hi - lo > RELOC_MAX_SPAN) {
        // 너무 넓으면 힌트 쪽을 남긴다
        lo = Math.max(0, hint - HINT_SPAN);
        hi = Math.min(this.n - 1, hint + HINT_SPAN);
      }
    }
    const prior = (j: number): number => {
      const d = j - center;
      let w = d < -LOCAL_BACK && !free ? 0 : Math.exp(d < 0 ? d / RELOC_TAU_BACK : -d / RELOC_TAU_FWD);
      if (hint >= 0) w += Math.exp(-Math.abs(j - hint) / HINT_TAU);
      return w;
    };
    let result = this.searchWindow(lo, hi, prior);
    if (!result) return;
    this.repeatNow = -1;
    // 도돌이표: 반복 구간 끝에 닿은 뒤 들린 소리만으로, 구간 시작으로 돌아가 다시 치는지 본다 (구간마다 한 번).
    // 끝에 닿기 전 소리까지 섞으면 구간 시작과 맞지 않아 알아채지 못한다.
    let repeatOk = false;
    if (!free) {
      const minFrames = Math.round(REPEAT_MIN_SEC / this.hopSec);
      this.repeatUnits.forEach((r, k) => {
        if (repeatOk || r.used || r.reachedAt < 0 || center > r.from + REPEAT_AFTER) return;
        const since = this.frameNo - r.reachedAt;
        if (since < minFrames) return;
        // 가장 최근 소리만 (구간 끝 음을 오래 누르고 있다가 돌아가는 일이 많아서)
        const start = Math.max(0, this.history.length - Math.min(since, Math.round(REPEAT_LISTEN_SEC / this.hopSec)));
        const rlo = Math.max(0, r.to - 2);
        const rhi = Math.min(this.n - 1, r.to + REPEAT_SPAN, r.from);
        const keep = result!;
        [this.altCur, this.altNext, this.spareCur, this.spareNext] = [this.spareCur, this.spareNext, this.altCur, this.altNext];
        const alt = this.searchWindow(rlo, rhi, (j) => Math.exp(-Math.abs(j - r.to) / 4), start);
        const frames = this.history.length - start;
        if (alt && alt.altLL - alt.mainLL >= REPEAT_MARGIN && alt.altLL / frames >= this.sharpness * (RELOC_MIN_SIM - 1)) {
          result = alt;
          this.repeatNow = k;
          repeatOk = true;
        } else {
          [this.altCur, this.altNext, this.spareCur, this.spareNext] = [this.spareCur, this.spareNext, this.altCur, this.altNext];
          result = keep;
        }
      });
    }
    ({ lo, hi } = result);
    const { altLL, mainLL, b, frames } = result;
    // 옮겨 갈 곳이 "덜 나쁜" 정도가 아니라 실제로 잘 맞아야 한다 (잡음·박수 속에서 헤매지 않게)
    const altFit = altLL / this.history.length;
    if (!repeatOk && (altLL - mainLL < RELOC_MARGIN || altFit < this.sharpness * (RELOC_MIN_SIM - 1))) {
      this.relocVotes = 0;
      return;
    }

    // 확률이 비슷한 후보가 여럿이면 (같은 선율 반복) 지금 위치에서 (놓쳤으면 시간 힌트에서, 도돌이표면 구간 시작에서) 가까운 쪽을 고른다
    const { bestP } = this.argmax(b, lo, hi);
    const ref = this.repeatNow >= 0 ? this.repeatUnits[this.repeatNow].to : hint >= 0 ? hint : center;
    let best = -1;
    for (let j = lo; j <= hi; j++) {
      const p = b.a[j] + b.s[j];
      if (p >= 0.5 * bestP && (best < 0 || Math.abs(j - ref) < Math.abs(best - ref))) best = j;
    }
    if (best < 0 || Math.abs(best - this.current) <= 2) {
      this.relocVotes = 0;
      return;
    }
    // 잔향이 많은 곳에서는 증거가 출렁이므로, 같은 곳을 연달아 가리킬 때만 옮긴다
    if (this.relocVotes > 0 && Math.abs(best - this.relocCandidate) <= 2) this.relocVotes++;
    else {
      this.relocCandidate = best;
      this.relocVotes = 1;
    }
    if (this.relocVotes < RELOC_CONFIRM) return;
    this.relocVotes = 0;
    if (!free && best < this.current - LOCAL_BACK) {
      // 콩쿠르 모드에서 멀리 뒤로 가는 건 두 경우뿐:
      // 도돌이표에서 실제로 반복할 때, 그리고 추적기가 앞질러 가서 흐른 시간이 가리키는 곳으로 바로잡을 때
      const toHint = hint >= 0 && hint < this.current && Math.abs(best - hint) <= HINT_SPAN;
      if (this.repeatNow < 0 && !toHint) return;
      if (this.repeatNow >= 0) this.repeatUnits[this.repeatNow].used = true;
      this.jumpedBack = true;
    }
    // 재탐색 결과 중 고른 위치 주변만 주 추적기 분포로 채택 (다른 후보로 다시 튀지 않게)
    this.cur.clear();
    let mass = 0;
    for (let j = Math.max(lo, best - 3); j <= Math.min(hi, best + 3); j++) {
      this.cur.a[j] = b.a[j];
      this.cur.s[j] = b.s[j];
      this.cur.e[j] = b.e[j];
      mass += b.a[j] + b.s[j];
    }
    if (mass > 0) {
      for (let j = Math.max(lo, best - 3); j <= Math.min(hi, best + 3); j++) {
        this.cur.a[j] /= mass;
        this.cur.s[j] /= mass;
      }
    }
    // 같은 평가가 반복되지 않도록 기록의 우도를 새 경로 기준으로 맞춘다
    const share = altLL / Math.max(1, frames);
    for (const h of this.history) h.logLik = share;
    this.enteredAt = this.voicedTime;
  }

  /** 한 음씩 순서대로 넘어갈 때 실제 걸린 시간으로 템포를 보정한다. */
  private onAdvance(from: number, to: number): void {
    const now = this.voicedTime;
    if (this.adaptTempo && from >= 0 && to === from + 1) {
      const dur = now - this.enteredAt;
      const beats = this.units[from].beats;
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
