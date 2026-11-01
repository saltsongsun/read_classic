import type { ScoreEvent } from './types';

/**
 * 곡 진행률과 남은 시간 추정.
 *
 * - 진행률: 지금 위치까지의 박 수 / 전체 박 수
 * - 남은 시간: 남은 박 수 × (초/박)
 *   초/박은 처음에는 사전값(예상 연주 시간 또는 악보 템포)을 쓰고,
 *   연주가 진행될수록 "실제로 걸린 시간 ÷ 연주한 박 수"(쉼·늘임표 포함 평균 속도) 쪽으로 옮겨 간다.
 *   한 곡 안에서도 빠르기가 바뀌므로 국소 템포보다 전체 평균이 남은 시간 예측에 더 안정적이다.
 */
export interface ProgressOptions {
  /** 악보 템포 (BPM, 4분음표). */
  scoreBpm: number;
  /** 사용자가 아는 예상 연주 시간(초). 있으면 사전값으로 쓴다. */
  expectedTotalSec?: number;
}

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
}

const TRUST_AFTER_SEC = 40; // 이만큼 연주하면 실제 속도를 완전히 믿는다
const FINISH_SILENCE_SEC = 2.5;

export class ProgressEstimator {
  private readonly cum: Float64Array; // 이벤트 시작까지의 누적 박
  private readonly totalBeats: number;
  private readonly lastMeasure: number;
  private readonly events: ScoreEvent[];
  private opts: ProgressOptions;

  private startAt: number | null = null;
  private lastSoundAt = 0;
  private now = 0;
  private position = -1;
  private finishedAt: number | null = null;
  private smoothRemaining: number | null = null;
  private lastSnapAt = 0;

  constructor(events: ScoreEvent[], opts: ProgressOptions) {
    this.events = events;
    this.opts = { ...opts };
    this.cum = new Float64Array(events.length + 1);
    for (let i = 0; i < events.length; i++) this.cum[i + 1] = this.cum[i] + events[i].beats;
    this.totalBeats = this.cum[events.length] || 1;
    this.lastMeasure = events.reduce((m, e) => Math.max(m, e.measure), 0);
  }

  setOptions(opts: Partial<ProgressOptions>): void {
    this.opts = { ...this.opts, ...opts };
    this.smoothRemaining = null;
  }

  reset(): void {
    this.startAt = null;
    this.finishedAt = null;
    this.position = -1;
    this.smoothRemaining = null;
  }

  /** 사용자가 위치를 옮겼을 때: 시작 시각은 그대로 두고 위치만 바꾼다. */
  jumpTo(position: number): void {
    this.position = position;
    this.finishedAt = null;
    this.smoothRemaining = null;
  }

  /** 프레임마다 호출. nowSec 는 단조 증가하는 시계(초). */
  update(nowSec: number, position: number, voiced: boolean): void {
    this.now = nowSec;
    if (voiced) this.lastSoundAt = nowSec;
    if (position >= 0 && this.startAt === null && voiced) {
      // 첫 음이 들린 시각. 중간부터 시작했다면 그만큼 이미 지난 것으로 본다.
      this.startAt = nowSec - this.cum[position] * this.priorSecPerBeat();
    }
    this.position = position;
    const last = this.events.length - 1;
    if (position === last && this.startAt !== null && !voiced && nowSec - this.lastSoundAt > FINISH_SILENCE_SEC) {
      this.finishedAt ??= this.lastSoundAt;
    } else if (position !== last) {
      this.finishedAt = null;
    }
  }

  private priorSecPerBeat(): number {
    if (this.opts.expectedTotalSec && this.opts.expectedTotalSec > 0) return this.opts.expectedTotalSec / this.totalBeats;
    return 60 / this.opts.scoreBpm;
  }

  /** 지금 위치까지 연주한 박 수 (현재 음의 절반을 지난 것으로 본다). */
  private playedBeats(): number {
    if (this.position < 0) return 0;
    return this.cum[this.position] + 0.5 * this.events[this.position].beats;
  }

  snapshot(): ProgressSnapshot {
    const started = this.startAt !== null;
    const prior = this.priorSecPerBeat();
    const played = this.playedBeats();
    const fraction = Math.min(1, played / this.totalBeats);
    const ev = this.position >= 0 ? this.events[this.position] : null;
    const measuresLeft = ev ? Math.max(0, this.lastMeasure - ev.measure) : this.lastMeasure;
    if (!started) {
      const total = this.totalBeats * prior;
      return { fraction: 0, elapsedSec: 0, remainingSec: total, totalSec: total, measuresLeft, started, finished: false };
    }
    const end = this.finishedAt ?? this.now;
    const elapsed = Math.max(0, end - (this.startAt as number));
    if (this.finishedAt !== null) {
      return { fraction: 1, elapsedSec: elapsed, remainingSec: 0, totalSec: elapsed, measuresLeft: 0, started, finished: true };
    }
    let secPerBeat = prior;
    if (played > 0 && elapsed > 3) {
      const observed = elapsed / played;
      // 실제 속도를 믿는 정도: 연주한 시간이 길수록, 곡의 많은 부분을 연주했을수록
      const w = Math.min(1, Math.max(elapsed / TRUST_AFTER_SEC, fraction * 3));
      secPerBeat = Math.exp((1 - w) * Math.log(prior) + w * Math.log(observed));
    }
    const raw = Math.max(0, (this.totalBeats - played) * secPerBeat);
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
      fraction,
      elapsedSec: elapsed,
      remainingSec: remaining,
      totalSec: elapsed + remaining,
      measuresLeft,
      started,
      finished: false,
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
