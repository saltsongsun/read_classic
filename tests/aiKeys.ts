// 시험용: 합성한 연주 전체에 AI 음 인식(basic-pitch)을 실시간과 같은 방식(HOP 마다 최근 2초)으로 미리 돌려 둔다.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web';
import { HOP_SEC, KeyStream, MODEL_RATE, MODEL_SAMPLES, Resampler } from '../src/audio/keyModel';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let session: ort.InferenceSession | null = null;

export async function modelSession(): Promise<ort.InferenceSession> {
  if (!session) {
    ort.env.wasm.numThreads = 1;
    session = await ort.InferenceSession.create(readFileSync(join(root, 'public', 'models', 'basic-pitch.onnx')));
  }
  return session;
}

export async function runModel(window: Float32Array): Promise<{ note: Float32Array; onset: Float32Array }> {
  const s = await modelSession();
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', window, [1, MODEL_SAMPLES, 1]) });
  return { note: out['StatefulPartitionedCall:1'].data as Float32Array, onset: out['StatefulPartitionedCall:2'].data as Float32Array };
}

/** 연주 전체 → 시각별 AI 음 인식 결과 */
export async function aiKeyStream(samples: Float32Array, sampleRate: number): Promise<KeyStream> {
  const y = new Resampler(sampleRate).push(samples);
  const stream = new KeyStream(sampleRate, runModel);
  stream.keepSec = Infinity; // 연주 전체를 들고 있는다
  const hop = Math.round(HOP_SEC * MODEL_RATE);
  for (let end = hop; end < y.length + hop; end += hop) {
    const win = new Float32Array(MODEL_SAMPLES);
    const from = end - MODEL_SAMPLES;
    for (let i = 0; i < MODEL_SAMPLES; i++) {
      const k = from + i;
      win[i] = k >= 0 && k < y.length ? y[k] : 0;
    }
    const { note, onset } = await runModel(win);
    stream.accept(note, onset, end);
  }
  return stream;
}
