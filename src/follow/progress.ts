import type { ScoreEvent } from './types';

/**
 * 곡 진행률과 남은 시간 추정, 그리고 "시간 검증".
 *
 * 악보 시간표: 이벤트마다 "악보 빠르기대로 치면 걸리는 시간"(명목 시간)을 매긴다.
 * 중간에 빠르기 표시가 바뀌면 그대로 반영한다 (느린 서주 + 빠른 본문 같은 곡도 고르게 계산).
 *
 * - 진행률: 지금 위치까지의 명목 시간 / 전체 명목 시간
 * - 남은 시간: 남은 명목 시간 × 속도 비율(실제 시간 ÷ 명목 시간)
 *   속도 비율은 사전값(예상 연주 시간, 없으면 악보 빠르기)과 지금까지 실제로 걸린 비율을
 *   각자 믿을 만한 정도에 따라 섞는다. 예상 연주 시간을 알려 주면 사전값을 더 오래 믿는다.
 *
 * 시간 검증: 추적 위치가 흐른 시간과 맞게 나아가는지 본다.
 * - 최근 몇 초 동안 소리는 계속 나는데 위치가 거의 나아가지 않았거나 뒤로 돌아갔으면
 *   (인식이 틀린 구간에서 멈추거나, 비슷한 앞 구절로 잘못 옮겨 간 경우) "위치를 놓친" 것으로 본다.
 *   그동안은 마지막으로 믿을 수 있던 지점부터 그때의 속도로 시간에 맞춰 위치를 어림하고,
 *   그 어림 위치를 추적기에 힌트로 줘서 제자리를 다시 찾게 한다.
 *   추적 위치가 어림 위치 근처에서 다시 고르게 나아가면 (또는 다른 곳에서라도 한참 고르게 나아가면) 되돌아온다.
 * - 예상(악보 빠르기 또는 예상 연주 시간)보다 크게 빠르거나 느리면 알려 준다.
 */
export interface ProgressOptions {
  /** 곡 첫 부분의 빠르기 (BPM, 4분음표). 연습 템포를 바꾸면 그 값. */
  scoreBpm: number;
  /** 사용자가 아는 예상 연주 시간(초). 있으면 사전값으로 쓴다. */
  expectedTotalSec?: number;
  /** 빠르기를 믿을 만한지 (악보에 적혀 있거나 사용자가 정했는지). 기본: 이벤트에 빠르기가 있으면 true */
  tempoKnown?: boolean;
}

/**
 * 시간 검증 결과
 * - waiting: 아직 시작 전
 * - ok: 위치와 시간이 서로 맞게 가고 있다
 * - fast / slow: 예상보다 크게 빠르거나 느리다 (예상 시간이 틀렸거나 위치가 어긋났을 수 있다)
 * - lost: 소리는 나는데 위치가 오래 멈춰 있다 → 시간으로 어림하는 중
 */
export type TimeCheck = 'waiting' | 'ok' | 'fast' | 'slow' | 'lost';

export interface ProgressSnapshot {
  /** 0..1 */
  fraction: number;
  /** 첫 음부터 지난 시간(초). 시작 전이면 0 */
  elapsedSec: number;
  /** 남은 시간 추정(초). 시작 전이면 전체 예상 시간 */
  remainingSec: number;
  /** 지금 기준 전체 예상 연주 시간(초) */
  totalSec: number;
  /** 남은 마디 수 */
  measuresLeft: number;
  started: boolean;
  /** 마지막 음까지 연주하고 소리가 그쳤다 */
  finished: boolean;
  /** 악보 빠르기대로 칠 때의 전체 길이(초) */
  scoreTotalSec: number;
  /** 시작 전 예상 길이를 무엇으로 계산했는지 */
  basis: 'expected' | 'score' | 'guess';
  check: TimeCheck;
  /**
   * 사전값(예상 연주 시간 또는 악보 빠르기)보다 얼마나 느리게 가는지. +0.12 = 12% 느림, -0.1 = 10% 빠름.
   * 사전값을 믿을 수 없거나(빠르기 모름) 아직 이르면 null
   */
  deviation: number | null;
}

const FINISH_SILENCE_SEC = 2.5;
/** 사전 속도 비율의 불확실성 (로그 표준편차) */
const PRIOR_SIGMA = { expected: 0.12, score: 0.35, guess: 0.8 };
/** 관측 속도 비율의 불확실성: 15초 연주했을 때의 로그 표준편차 (오래 들을수록 줄어든다) */
const OBS_SIGMA_15S = 0.2;
const CHECK_AFTER_SEC = 15;
const SAMPLE_SEC = 0.25; // 진행 기록 간격
const LOST_WINDOW_SEC = 8; // 이만큼 동안 거의 못 나아가면 놓친 것
const LOST_RATE = 0.3; // 예상 진행의 이 비율보다 덜 나아가면
const BACK_WINDOW_SEC = 5; // 다시 찾았는지 볼 때
const ACCEPT_STEADY_SEC = 25; // 어림 위치와 달라도 이만큼 고르게 나아가면 추적기를 믿는다

interface ProgressSample {
  t: number;
  /** 추적 위치까지의 명목 시간 */
  played: number;
  /** 앞 기록 뒤로 소리가 난 시간 */
  voiced: number;
}

/** 위치와 시간이 맞게 가던 마지막 순간 */
interface GoodPoint {
  t: number;
  played: number;
  pace: number;
}

export class ProgressEstimator {
  private readonly events: ScoreEvent[];
  private readonly lastMeasure: number;
  private opts: ProgressOptions;
  private nom = new Float64Array(0); // 이벤트별 명목 시간(초)
  private cum = new Float64Array(1); // 이벤트 시작까지의 누적 명목 시간
  private totalNominal = 1;

  private startAt: number | null = null;
  private lastSoundAt = 0;
  private now = 0;
  private position = -1;
  private finishedAt: number | null = null;
  private smoothRemaining: number | null = null;
  private lastSnapAt = 0;

  // 시간 검증
  private lastUpdateAt: number | null = null;
  private samples: ProgressSample[] = [];
  private voicedAcc = 0;
  private lost = false;
  private good: GoodPoint | null = null; // 마지막으로 믿을 수 있던 지점 (놓치면 여기서부터 시간으로 어림)

  constructor(events: ScoreEvent[], opts: ProgressOptions) {
    this.events = events;
    this.opts = { ...opts };
    this.lastMeasure = events.reduce((m, e) => Math.max(m, e.measure), 0);
    this.computeNominal();
  }

  /** 악보 빠르기표대로 이벤트마다 명목 시간을 매긴다. 연습 템포를 바꾸면 전체를 같은 비율로 늘이거나 줄인다. */
  private computeNominal(): void {
    const n = this.events.length;
    const ref = this.events.find((e) => e.bpm)?.bpm ?? this.opts.scoreBpm;
    const scale = this.opts.scoreBpm / ref;
    this.nom = new Float64Array(n);
    this.cum = new Float64Array(n + 1);
    let bpm = ref;
    for (let i = 0; i < n; i++) {
      const e = this.events[i];
      if (e.bpm) bpm = e.bpm;
      this.nom[i] = (e.beats * 60) / (bpm * scale);
      this.cum[i + 1] = this.cum[i] + this.nom[i];
    }
    this.totalNominal = this.cum[n] || 1;
  }

  setOptions(opts: Partial<ProgressOptions>): void {
    this.opts = { ...this.opts, ...opts };
    if (opts.scoreBpm !== undefined) this.computeNominal();
    this.smoothRemaining = null;
  }

  reset(): void {
    this.startAt = null;
    this.finishedAt = null;
    this.position = -1;
    this.smoothRemaining = null;
    this.lastUpdateAt = null;
    this.clearCheck();
  }

  /** 사용자가 위치를 옮겼을 때: 시작 시각은 그대로 두고 위치만 바꾼다. */
  jumpTo(position: number): void {
    this.position = position;
    this.finishedAt = null;
    this.smoothRemaining = null;
    this.clearCheck();
  }

  private clearCheck(): void {
    this.samples = [];
    this.voicedAcc = 0;
    this.lost = false;
    this.good = null;
  }

  /** 프레임마다 호출. nowSec 는 단조 증가하는 시계(초). */
  update(nowSec: number, position: number, voiced: boolean): void {
    const dt = this.lastUpdateAt === null ? 0 : Math.max(0, Math.min(1, nowSec - this.lastUpdateAt));
    this.lastUpdateAt = nowSec;
    this.now = nowSec;
    if (voiced) this.lastSoundAt = nowSec;
    if (position >= 0 && this.startAt === null && voiced) {
      // 첫 음이 들린 시각. 중간부터 시작했다면 그만큼 이미 지난 것으로 본다.
      this.startAt = nowSec - this.cum[position] * this.priorPace();
      this.clearCheck();
    }
    this.position = position;

    const last = this.events.length - 1;
    const silentLong = !voiced && nowSec - this.lastSoundAt > FINISH_SILENCE_SEC;
    if (this.startAt !== null && silentLong && (position === last || (this.lost && this.played() >= this.totalNominal - 1e-6))) {
      this.finishedAt ??= this.lastSoundAt;
    } else if (position !== last && !(this.lost && silentLong)) {
      this.finishedAt = null;
    }

    if (this.startAt === null || this.finishedAt !== null || position < 0) return;
    if (voiced) this.voicedAcc += dt;
    const prev = this.samples[this.samples.length - 1];
    if (prev && nowSec - prev.t < SAMPLE_SEC) return;
    this.samples.push({ t: nowSec, played: this.trackedPlayed(), voiced: this.voicedAcc });
    this.voicedAcc = 0;
    while (this.samples.length && this.samples[0].t < nowSec - ACCEPT_STEADY_SEC - 1) this.samples.shift();
    this.checkProgress();
  }

  /** windowSec 전 기록과 그 뒤로 소리가 난 시간 */
  private since(windowSec: number): { old: ProgressSample; voiced: number; span: number } | null {
    const from = this.now - windowSec;
    const i = this.samples.findIndex((x) => x.t >= from);
    if (i < 0 || this.now - this.samples[i].t < windowSec * 0.9) return null;
    let voiced = 0;
    for (let k = i + 1; k < this.samples.length; k++) voiced += this.samples[k].voiced;
    return { old: this.samples[i], voiced, span: this.now - this.samples[i].t };
  }

  /** 추적 위치가 흐른 시간만큼 나아갔는지 본다. */
  private checkProgress(): void {
    const tracked = this.trackedPlayed();
    const last = this.events.length - 1;
    // 최근 sec 초 동안의 진행 속도 (1 = 믿던 속도대로). 소리가 거의 없었으면 null
    const rateOver = (sec: number, pace: number, minVoiced: number): number | null => {
      const w = this.since(sec);
      if (!w || w.voiced < minVoiced * w.span) return null;
      return (tracked - w.old.played) / (w.span / pace);
    };
    if (!this.lost) {
      const pace = this.good?.pace ?? this.pace();
      const r = rateOver(LOST_WINDOW_SEC, pace, 0.7);
      if (r === null) return;
      const recent = rateOver(3, pace, 0.7);
      if (r > 0.6 && r < 1.7 && recent !== null && recent > 0.5 && recent < 2) {
        // 고르게 나아가는 중 (지금도 움직이고 있다): 믿을 수 있는 지점으로 기억
        this.good = { t: this.now, played: tracked, pace: this.pace() };
        return;
      }
      // 긴 음(늘임표 등)을 누르고 있는 중이면 멈춰 있는 게 당연하다
      const longNote = this.nom[this.position] * pace > 0.5 * LOST_WINDOW_SEC;
      if (r < LOST_RATE && !longNote && this.position < last) {
        this.lost = true;
        if (!this.good) {
          const w = this.since(LOST_WINDOW_SEC)!;
          this.good = { t: w.old.t, played: w.old.played, pace };
        }
      }
      return;
    }
    // 놓친 상태: 어림 위치 근처에서 다시 고르게 나아가거나, 다른 곳에서라도 한참 고르게 나아가면 돌아온다
    const pace = this.good!.pace;
    const r = rateOver(BACK_WINDOW_SEC, pace, 0.5);
    if (r === null || r < 0.5 || r > 2) return;
    // 시간 어림은 놓친 뒤 오래될수록 빗나가므로 그만큼 너그럽게 본다
    const since = (this.now - this.good!.t) / pace;
    const near = Math.abs(tracked - this.played()) < Math.max(6, 0.06 * this.totalNominal, 0.25 * since);
    const steady = rateOver(ACCEPT_STEADY_SEC, pace, 0.5);
    if (near || (steady !== null && steady > 0.6 && steady < 1.7)) {
      this.lost = false;
      this.good = { t: this.now, played: tracked, pace };
    }
  }

  private basis(): ProgressSnapshot['basis'] {
    if (this.opts.expectedTotalSec && this.opts.expectedTotalSec > 0) return 'expected';
    const known = this.opts.tempoKnown ?? this.events.some((e) => e.bpm);
    return known ? 'score' : 'guess';
  }

  /** 사전 속도 비율 (실제 시간 ÷ 명목 시간) */
  private priorPace(): number {
    const exp = this.opts.expectedTotalSec;
    return exp && exp > 0 ? exp / this.totalNominal : 1;
  }

  private elapsed(): number {
    if (this.startAt === null) return 0;
    return Math.max(0, (this.finishedAt ?? this.now) - this.startAt);
  }

  /** 추적 위치까지 연주한 명목 시간 (현재 음의 절반을 지난 것으로 본다) */
  private trackedPlayed(): number {
    if (this.position < 0) return 0;
    return this.cum[this.position] + 0.5 * this.nom[this.position];
  }

  /** 지금까지 실제로 걸린 속도 비율. 아직 이르면 null */
  private observedPace(): number | null {
    const played = this.trackedPlayed();
    const elapsed = this.elapsed();
    if (played <= 0 || elapsed <= 3 || this.lost) return null;
    return elapsed / played;
  }

  /** 사전값과 관측값을 섞은 속도 비율 (위치를 놓친 동안은 그 전까지 믿던 값) */
  private pace(): number {
    if (this.lost && this.good) return this.good.pace;
    const prior = this.priorPace();
    const obs = this.observedPace();
    if (obs === null) return prior;
    const sp = PRIOR_SIGMA[this.basis()];
    const so = OBS_SIGMA_15S * Math.sqrt(15 / Math.max(1, this.elapsed()));
    const w = (sp * sp) / (sp * sp + so * so);
    return Math.exp((1 - w) * Math.log(prior) + w * Math.log(obs));
  }

  /** 연주한 명목 시간: 위치를 놓쳤으면 마지막으로 믿을 수 있던 지점부터 흐른 시간으로 어림한다. */
  private played(pace = this.pace()): number {
    if (!this.lost || !this.good) return this.trackedPlayed();
    return Math.min(this.totalNominal, this.good.played + (this.now - this.good.t) / pace);
  }

  /** 위치를 놓쳤을 때 시간으로 어림한 이벤트 번호 (추적기에 주는 힌트). 놓치지 않았으면 null */
  timeHint(): number | null {
    if (!this.lost) return null;
    const p = this.played();
    let lo = 0;
    let hi = this.events.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cum[mid] <= p) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private checkResult(): { check: TimeCheck; deviation: number | null } {
    if (this.startAt === null) return { check: 'waiting', deviation: null };
    if (this.finishedAt !== null) return { check: 'ok', deviation: null };
    if (this.lost) return { check: 'lost', deviation: null };
    const basis = this.basis();
    const obs = this.observedPace();
    const elapsed = this.elapsed();
    if (basis === 'guess' || obs === null || elapsed < CHECK_AFTER_SEC) return { check: 'ok', deviation: null };
    const prior = this.priorPace();
    const deviation = obs / prior - 1;
    const sp = PRIOR_SIGMA[basis];
    const so = OBS_SIGMA_15S * Math.sqrt(15 / elapsed);
    const z = Math.abs(Math.log(obs / prior)) / Math.sqrt(sp * sp + so * so);
    if (z > 2 && Math.abs(deviation) > 0.15) return { check: deviation > 0 ? 'slow' : 'fast', deviation };
    return { check: 'ok', deviation };
  }

  snapshot(): ProgressSnapshot {
    const started = this.startAt !== null;
    const basis = this.basis();
    const scoreTotalSec = this.totalNominal;
    const prior = this.priorPace();
    const at = this.timeHint() ?? this.position;
    const ev = at >= 0 ? this.events[at] : null;
    const measuresLeft = ev ? Math.max(0, this.lastMeasure - ev.measure) : this.lastMeasure;
    const base = { scoreTotalSec, basis };
    if (!started) {
      const total = this.totalNominal * prior;
      return { ...base, fraction: 0, elapsedSec: 0, remainingSec: total, totalSec: total, measuresLeft, started, finished: false, check: 'waiting', deviation: null };
    }
    const elapsed = this.elapsed();
    if (this.finishedAt !== null) {
      return { ...base, fraction: 1, elapsedSec: elapsed, remainingSec: 0, totalSec: elapsed, measuresLeft: 0, started, finished: true, check: 'ok', deviation: null };
    }
    const pace = this.pace();
    const played = this.played(pace);
    const fraction = Math.min(1, played / this.totalNominal);
    const raw = Math.max(0, (this.totalNominal - played) * pace);
    // 화면 숫자가 출렁이지 않게: 흐른 시간만큼 줄인 이전 값과 새 추정을 (시간 기준으로) 섞는다
    const dt = Math.max(0, this.now - this.lastSnapAt);
    this.lastSnapAt = this.now;
    if (this.smoothRemaining === null) this.smoothRemaining = raw;
    else {
      const decayed = Math.max(0, this.smoothRemaining - dt);
      this.smoothRemaining = decayed + (1 - Math.exp(-dt / 2.5)) * (raw - decayed);
    }
    const remaining = this.smoothRemaining;
    return {
      ...base,
      fraction,
      elapsedSec: elapsed,
      remainingSec: remaining,
      totalSec: elapsed + remaining,
      measuresLeft,
      started,
      finished: false,
      ...this.checkResult(),
    };
  }
}

/** 3:05 같은 표기. 1분이 넘으면 5초 단위로 반올림해서 덜 출렁이게. */
export function formatDuration(sec: number, coarse = false): string {
  let s = Math.max(0, sec);
  if (coarse && s >= 60) s = Math.round(s / 5) * 5;
  else s = Math.round(s);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
