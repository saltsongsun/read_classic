/**
 * AI 피아노 음 인식 엔진: 웹 워커를 띄우고 모델을 올린 뒤, KeyStream 이 쓸 실행 함수(ModelRunner)를 준다.
 * 모델(public/models/basic-pitch.onnx, 230KB)과 실행기(public/ort/*.wasm)는 앱과 함께 배포된다 (인터넷 불필요).
 */
import type { ModelRunner } from './keyModel';

export class KeyEngine {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: { note: Float32Array; onset: Float32Array }) => void; reject: (e: Error) => void }>();

  private constructor(worker: Worker) {
    this.worker = worker;
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'result' || (m.type === 'error' && m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.type === 'result') p?.resolve({ note: m.note, onset: m.onset });
        else p?.reject(new Error(m.message));
      }
    };
  }

  /** 워커를 띄우고 모델을 올린다 (처음 한 번 1초 안팎) */
  static async create(): Promise<KeyEngine> {
    const worker = new Worker(new URL('./keyWorker.ts', import.meta.url), { type: 'module' });
    const base = new URL('./', document.baseURI).href;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('AI 음 인식 모델을 올리지 못했어요 (시간 초과)')), 30000);
      worker.onmessage = (e: MessageEvent) => {
        if (e.data.type === 'ready') {
          clearTimeout(timer);
          resolve();
        } else if (e.data.type === 'error') {
          clearTimeout(timer);
          reject(new Error(e.data.message));
        }
      };
      worker.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error(e.message || 'AI 음 인식 워커를 띄우지 못했어요'));
      };
      worker.postMessage({ type: 'init', modelUrl: `${base}models/basic-pitch.onnx`, wasmBase: `${base}ort/` });
    });
    return new KeyEngine(worker);
  }

  readonly run: ModelRunner = (window) =>
    new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'run', id, window }, [window.buffer]);
    });

  dispose(): void {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('closed'));
    this.pending.clear();
  }
}
