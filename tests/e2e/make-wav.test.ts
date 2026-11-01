// e2e 용 합성 연주 WAV 와 정답 타임라인을 만든다 (npm run e2e 가 먼저 실행).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { loadSample } from '../harness';
import { encodeWav, synthesize } from '../synth';

const here = dirname(fileURLToPath(import.meta.url));

test('make e2e audio', () => {
  const out = join(here, '..', 'fixtures');
  mkdirSync(out, { recursive: true });
  for (const [id, timbre] of [['ode-to-joy', 'piano'], ['bach-prelude-c', 'piano']] as const) {
    const s = loadSample(id);
    const { samples, timeOf, sampleRate } = synthesize(s.notes, { bpm: s.bpm * 0.9, timbre, tempoWobble: 0.08, seed: 11, leadIn: 1.5 });
    writeFileSync(join(out, `${id}.wav`), encodeWav(samples, sampleRate));
    const onsets = [...new Set(s.notes.map((n) => n.onset))].sort((a, b) => a - b);
    const timeline = s.events.map((e, j) => ({ index: j, measure: e.measure, time: timeOf(onsets[e.cursorStep]) }));
    writeFileSync(join(out, `${id}.json`), JSON.stringify({ duration: samples.length / sampleRate, timeline }));
  }
});
