/// <reference lib="webworker" />
/**
 * AI 피아노 음 인식 모델(basic-pitch)을 화면과 따로 돌리는 웹 워커.
 *   ← {type:'init', modelUrl, wasmBase}      → {type:'ready'} | {type:'error', message}
 *   ← {type:'run', id, window: Float32Array}  → {type:'result', id, note, onset} | {type:'error', id, message}
 */
import * as ort from 'onnxruntime-web/wasm';

let session: ort.InferenceSession | null = null;
const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      ort.env.wasm.wasmPaths = msg.wasmBase;
      ort.env.wasm.numThreads = 1; // 여러 스레드는 사이트 격리 설정이 필요하다. 한 스레드로도 실시간보다 충분히 빠르다
      session = await ort.InferenceSession.create(msg.modelUrl, { executionProviders: ['wasm'] });
      scope.postMessage({ type: 'ready' });
    } else if (msg.type === 'run') {
      if (!session) throw new Error('모델이 아직 준비되지 않았습니다');
      const input = new ort.Tensor('float32', msg.window as Float32Array, [1, (msg.window as Float32Array).length, 1]);
      const out = await session.run({ [session.inputNames[0]]: input });
      const note = (out['StatefulPartitionedCall:1'].data as Float32Array).slice();
      const onset = (out['StatefulPartitionedCall:2'].data as Float32Array).slice();
      scope.postMessage({ type: 'result', id: msg.id, note, onset }, [note.buffer, onset.buffer]);
    }
  } catch (err) {
    scope.postMessage({ type: 'error', id: msg.id, message: (err as Error).message ?? String(err) });
  }
};
