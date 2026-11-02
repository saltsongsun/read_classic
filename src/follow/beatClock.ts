import { nominalTimeline, type ProgressOptions, type ProgressSnapshot } from './progress';
import type { ScoreEvent } from './types';

/**
 * 마디·박자로 계산하기 (콩쿠르 기본 방식).
 *
 * 음을 하나하나 알아듣는 대신, 악보의 마디와 박자표·빠르기로 "악보대로 치면 걸리는 시간"을 계산하고
 * 첫 소리가 난 뒤 흐른 시간만큼 위치를 옮긴다. 악보 인식이 조금 틀려도, 연주 소리가 어떻든
 * 흔들리지 않는다.
 *
 * - 속도: 예상 연주 시간을 알면 그 비율로, 모르면 악보 빠르기(또는 연습 템포)대로.
 * - 멈춤: PAUSE_SEC 넘게 조용하면(악장 사이, 연주 중단) 마지막 소리가 난 때로 시계를 되돌려 멈추고,
 *   소리가 다시 나면 이어 간다. 그보다 짧은 쉼표·늘임표는 음악의 일부로 그대로 센다.
 * - 보정: 사용자가 "지금 여기"를 짚으면 그 자리로 맞추고, 그때까지 실제로 걸린 시간으로 속도를 다시 잡는다.
 * - 끝: 계산상 끝에 닿은 뒤 소리가 FINISH_SEC 넘게 그치면 끝난 것으로 본다.
 */
const PAUSE_SEC = 3;
const FINISH_SEC = 2.5;
/** 이만큼 지난 뒤에 짚은 위치로는 속도도 다시 계산한다 (너무 이르면 오차가 커서 위치만 맞춘다) */
const RECALIBRATE_AFTER_SEC = 8;

export class BeatClock {
  private readonly events: ScoreEvent[];
  private readonly lastMeasure: number;
  private opts: ProgressOptions;
  private cum = new Float64Array(1);
  private total = 1;
  private pace = 1; // 실제 초 ÷ 명목 초

  private startAt: number | null = null; // 첫 소리
  private run = 0; // 멈춘 시간을 뺀, 연주가 이어진 시간 (초)
  private offset = 0; // 짚어서 맞춘 위치 (명목 초)
  private runAtOffset = 0; // 그때의 run
  private travelled = 0; // offset 전까지 실제로 연주해 온 명목 거리 (반복해서 돌아간 만큼도 더한다)
  private lastNow = 0;
  private lastSoundAt = 0;
  private paused = false;
  private finishedAt: number | null = null;
  private wallAtFinish = 0;

  constructor(events: ScoreEvent[], opts: ProgressOptions) {
    this.events = events;
    this.opts = { ...opts };
    this.lastMeasure = events.reduce((m, e) => Math.max(m, e.measure), 0);
    this.recompute();
  }

  private recompute(): void {
    const t = nominalTimeline(this.events, this.opts.scoreBpm);
    this.cum = t.cum;
    this.total = t.total;
    const exp = this.opts.expectedTotalSec;
    this.pace = exp && exp > 0 ? exp / this.total : 1;
  }

  setOptions(opts: Partial<ProgressOptions>): void {
    // 연주 중에 바꿔도 지금 위치는 그대로 두고 속도만 바꾼다
    const played = this.played();
    this.opts = { ...this.opts, ...opts };
    this.recompute();
    this.travelled += Math.min(played, this.total) - this.offset;
    this.offset = Math.min(played, this.total);
    this.runAtOffset = this.run;
  }

  reset(): void {
    this.startAt = null;
    this.run = 0;
    this.offset = 0;
    this.runAtOffset = 0;
    this.travelled = 0;
    this.paused = false;
    this.finishedAt = null;
  }

  get started(): boolean {
    return this.startAt !== null;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** 지금 빠르기 (♩/분, 곡 첫 부분 기준) */
  get bpm(): number {
    return this.opts.scoreBpm / this.pace;
  }

  /** 프레임마다: 소리가 나는지만 본다 */
  update(now: number, voiced: boolean): void {
    const dt = this.startAt === null ? 0 : Math.max(0, Math.min(1, now - this.lastNow));
    this.lastNow = now;
    if (this.startAt === null) {
      if (!voiced) return;
      this.startAt = now;
      this.lastSoundAt = now;
      return;
    }
    if (voiced) {
      if (this.paused) this.paused = false;
      this.lastSoundAt = now;
      if (this.finishedAt !== null) this.finishedAt = null; // 끝난 줄 알았는데 계속 친다
    }
    if (!this.paused) this.run += dt;
    const silence = now - this.lastSoundAt;
    if (!this.paused && silence > PAUSE_SEC && this.played() < this.total - 1e-6) {
      // 오래 조용하다: 마지막 소리가 난 때로 되돌려 멈춘다
      this.run = Math.max(this.runAtOffset, this.run - silence);
      this.paused = true;
    }
    if (this.finishedAt === null && silence > FINISH_SEC && this.played() >= this.total - 1e-6) {
      this.finishedAt = this.lastSoundAt;
      this.wallAtFinish = this.lastSoundAt - (this.startAt ?? this.lastSoundAt);
    }
  }

  /** 연주한 명목 시간 */
  private played(): number {
    return Math.min(this.total, this.offset + (this.run - this.runAtOffset) / this.pace);
  }

  /** 지금 이벤트 번호 (시작 전 -1) */
  position(): number {
    if (this.startAt === null && this.offset === 0) return -1;
    const p = this.played();
    let lo = 0;
    let hi = this.events.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cum[mid] <= p + 1e-9) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * 사용자가 "지금 여기"를 짚었다: 위치를 맞추고, 충분히 연주했으면 속도도 다시 잡는다.
   * 계산 위치 근처를 짚으면 "계산이 조금 어긋났다"로 보고 속도를 고친다. 멀리 뒤로 짚으면(도돌이표 반복,
   * 다시 치기) 그때까지는 계산대로 쳤다고 보고 위치만 옮긴다.
   */
  setPosition(index: number, now: number): void {
    const target = this.cum[Math.max(0, Math.min(this.events.length - 1, index))];
    if (this.startAt === null) {
      // 시작 전: 여기서부터 시작
      this.offset = target;
      this.runAtOffset = 0;
      return;
    }
    this.lastNow = now;
    const played = this.played();
    const sofar = this.travelled + (played - this.offset);
    const correction = Math.abs(target - played) <= Math.max(4, 0.35 * sofar);
    if (correction) {
      this.travelled += target - this.offset;
      if (this.run >= RECALIBRATE_AFTER_SEC && this.travelled > 1) {
        // 지금까지 실제로 걸린 시간 ÷ 그동안 악보상 시간 = 속도
        const pace = this.run / this.travelled;
        if (pace > 0.3 && pace < 3) this.pace = pace;
      }
    } else {
      this.travelled = sofar;
    }
    this.offset = target;
    this.runAtOffset = this.run;
    this.finishedAt = null;
  }

  snapshot(): ProgressSnapshot {
    const exp = this.opts.expectedTotalSec;
    const basis: ProgressSnapshot['basis'] = exp && exp > 0 ? 'expected' : (this.opts.tempoKnown ?? this.events.some((e) => e.bpm)) ? 'score' : 'guess';
    const played = this.played();
    const pos = this.position();
    const measuresLeft = pos >= 0 ? Math.max(0, this.lastMeasure - this.events[pos].measure) : this.lastMeasure;
    const base = { scoreTotalSec: this.total, basis, check: 'ok' as const, deviation: null };
    if (this.startAt === null) {
      const total = (this.total - this.offset) * this.pace;
      return { ...base, check: 'waiting', fraction: this.offset / this.total, elapsedSec: 0, remainingSec: total, totalSec: total, measuresLeft, started: false, finished: false };
    }
    if (this.finishedAt !== null) {
      return { ...base, fraction: 1, elapsedSec: this.wallAtFinish, remainingSec: 0, totalSec: this.wallAtFinish, measuresLeft: 0, started: true, finished: true };
    }
    const elapsed = this.lastNow - this.startAt;
    const remaining = Math.max(0, (this.total - played) * this.pace);
    return { ...base, fraction: played / this.total, elapsedSec: elapsed, remainingSec: remaining, totalSec: elapsed + remaining, measuresLeft, started: true, finished: false };
  }
}
