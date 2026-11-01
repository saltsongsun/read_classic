// 합성 오디오로 추적기를 돌려 정확도를 재는 도구.
import { FeatureExtractor, LevelGate } from '../src/audio/features';
import { buildEvents, type RawNote, type RawStep } from '../src/follow/build';
import { ProgressEstimator } from '../src/follow/progress';
import { ScoreFollower } from '../src/follow/tracker';
import type { ScoreEvent } from '../src/follow/types';
// @ts-expect-error -- 순수 JS 모듈
import { SCORES, toRawNotes } from '../samples/scores.mjs';
import { synthesize, type SynthOptions } from './synth';

export interface SampleScore {
  id: string;
  bpm: number;
  notes: RawNote[];
  events: ScoreEvent[];
}

export function loadSample(id: string): SampleScore {
  const def = (SCORES as Array<{ id: string; bpm: number }>).find((s) => s.id === id);
  if (!def) throw new Error(id);
  const notes = (toRawNotes(def) as Array<RawNote & { measure: number }>).map((n) => ({ ...n }));
  return { id, bpm: def.bpm, notes, events: notesToEvents(notes as Array<RawNote & { measure: number }>) };
}

export function notesToEvents(notes: Array<RawNote & { measure: number }>): ScoreEvent[] {
  const byOnset = new Map<number, RawStep>();
  let step = 0;
  for (const n of notes) {
    const key = Math.round(n.onset * 1000);
    let s = byOnset.get(key);
    if (!s) {
      s = { onset: n.onset, notes: [], measure: n.measure, cursorStep: step++ };
      byOnset.set(key, s);
    }
    s.notes.push(n);
  }
  return buildEvents([...byOnset.values()]);
}

export interface RunResult {
  /** 이벤트별: 추적기가 처음 그 이벤트(이상)에 도달한 시각 - 실제 시각 (초). 도달 못하면 NaN */
  lags: number[];
  /** 소리 나는 프레임 중 위치가 정확(±0)했던 비율 */
  exact: number;
  /** ±1 이벤트 이내 비율 */
  near: number;
  /** 마디가 맞은 비율 */
  measureNear: number;
  finalIndex: number;
  maxIndex: number;
  trace: Array<{ t: number; idx: number; truth: number }>;
  /** 남은 시간 추정 기록: 추정값과 실제 남은 시간 (초) */
  remaining: Array<{ t: number; est: number; truth: number; started: boolean }>;
  /** 실제 연주 끝 시각 (마지막 음이 끝나는 때) */
  endTime: number;
}

/** 실제로 연주할 음. origOnset 은 악보상의 위치 (정답 계산용). */
export type PlayedNote = RawNote & { origOnset: number };

export interface RunOptions extends Partial<SynthOptions> {
  /** 악보와 다르게 연주할 때 (반복 연습, 틀린 음 등). */
  play?: PlayedNote[];
  trackerBpm?: number;
  startAt?: number;
  /** 남은 시간 추정에 줄 예상 연주 시간 (초) */
  expectedTotalSec?: number;
}

export function run(score: SampleScore, opts: RunOptions): RunResult {
  const { events } = score;
  const play: PlayedNote[] = opts.play ?? score.notes.map((n) => ({ ...n, origOnset: n.onset }));
  const { samples, timeOf, sampleRate } = synthesize(play, { bpm: score.bpm, ...opts } as SynthOptions);
  const fx = new FeatureExtractor(sampleRate);
  const gate = new LevelGate();
  const tracker = new ScoreFollower(events, { hopSec: fx.hopSec, bpm: opts.trackerBpm ?? score.bpm });
  if (opts.startAt !== undefined) tracker.setPosition(opts.startAt);
  const progress = new ProgressEstimator(events, { scoreBpm: opts.trackerBpm ?? score.bpm, expectedTotalSec: opts.expectedTotalSec });
  const lastPlayed = play.reduce((m, n) => Math.max(m, n.onset + n.duration), 0);
  const endTime = timeOf(lastPlayed);
  const remaining: RunResult['remaining'] = [];
  const onsetTimes = events.map((e) => timeOfEvent(e, score, timeOf));
  // 연주된 음 시작 시각 → 악보 이벤트 번호
  const scoreOnsets = [...new Set(score.notes.map((n) => n.onset))].sort((a, b) => a - b);
  const eventOfOnset = new Map<number, number>();
  events.forEach((e, j) => eventOfOnset.set(scoreOnsets[e.cursorStep], j));
  const playedTimeline = [...new Set(play.map((n) => n.onset))]
    .sort((a, b) => a - b)
    .map((on) => {
      const orig = play.find((n) => n.onset === on)!.origOnset;
      return { t: timeOf(on), ev: eventOfOnset.get(orig) ?? -1 };
    });
  const truthOf = (t: number) => {
    let ev = opts.startAt !== undefined ? opts.startAt : -1;
    for (const p of playedTimeline) if (p.t <= t && p.ev >= 0) ev = p.ev;
    return ev;
  };

  const reached = new Array<number>(events.length).fill(NaN);
  const trace: RunResult['trace'] = [];
  let exact = 0;
  let near = 0;
  let measureOk = 0;
  let voicedCount = 0;
  let idx = -1;
  let maxIndex = -1;
  const block = 128;
  for (let off = 0; off < samples.length; off += block) {
    const frames = fx.push(samples.subarray(off, off + block));
    for (const f of frames) {
      const voiced = gate.update(f.rms, f.flatness);
      const st = tracker.update(f, voiced);
      idx = st.index;
      progress.update(f.time, st.index, voiced);
      const snap = progress.snapshot();
      remaining.push({ t: f.time, est: snap.remainingSec, truth: Math.max(0, endTime - f.time), started: snap.started });
      maxIndex = Math.max(maxIndex, idx);
      for (let j = 0; j <= idx; j++) if (Number.isNaN(reached[j])) reached[j] = f.time;
      const truth = truthOf(f.time - 0.05);
      trace.push({ t: f.time, idx, truth });
      if (voiced && truth >= 0) {
        voicedCount++;
        if (idx === truth) exact++;
        if (Math.abs(idx - truth) <= 1) near++;
        if (idx >= 0 && events[idx].measure === events[truth].measure) measureOk++;
      }
    }
  }
  return {
    lags: reached.map((t, j) => t - onsetTimes[j]),
    exact: exact / Math.max(1, voicedCount),
    near: near / Math.max(1, voicedCount),
    measureNear: measureOk / Math.max(1, voicedCount),
    finalIndex: idx,
    maxIndex,
    trace,
    remaining,
    endTime,
  };
}

function timeOfEvent(e: ScoreEvent, score: SampleScore, timeOf: (b: number) => number): number {
  // cursorStep 순서는 notesToEvents 에서 onset 순서와 같다
  const onsets = [...new Set(score.notes.map((n) => n.onset))].sort((a, b) => a - b);
  return timeOf(onsets[e.cursorStep]);
}

export function median(xs: number[]): number {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return NaN;
  return v[Math.floor(v.length / 2)];
}

/** 한 줄 요약. linear=false 면 (되돌아가기 등) 악보 순서 기준 지연 통계는 의미가 없어 뺀다. */
export function summarize(r: RunResult, linear = true): string {
  const base = `exact=${(r.exact * 100).toFixed(1)}% near=${(r.near * 100).toFixed(1)}% measure=${(r.measureNear * 100).toFixed(1)}%`;
  const fin = `final=${r.finalIndex}/${r.lags.length - 1}`;
  if (!linear) return `${base} ${fin}`;
  const lags = r.lags.filter((x) => Number.isFinite(x));
  const late = lags.filter((x) => x > 0.35).length;
  const early = lags.filter((x) => x < -0.1).length;
  return `${base} medLag=${(median(lags) * 1000).toFixed(0)}ms late=${late} early=${early} ${fin}`;
}
