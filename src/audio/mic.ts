/**
 * 마이크 입력을 받아 PCM 블록을 콜백으로 넘겨준다.
 * AudioWorklet을 우선 쓰고, 지원하지 않는 브라우저에서는 ScriptProcessor로 대체한다.
 */
export interface MicHandle {
  sampleRate: number;
  stop(): void;
}

const WORKLET_SRC = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1024); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('rc-tap', Tap);
`;

export async function startMic(onSamples: (block: Float32Array) => void): Promise<MicHandle> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('이 브라우저는 마이크 입력을 지원하지 않습니다. (HTTPS 또는 localhost에서 열어 주세요)');
  }
  // iOS Safari 등은 사용자 클릭 직후에 만든 AudioContext 만 소리를 받으므로 먼저 만든다
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // 악기 소리를 그대로 받기 위해 통화용 처리를 끈다
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
  } catch (e) {
    void ctx.close();
    throw e;
  }
  if (ctx.state === 'suspended') await ctx.resume();
  const source = ctx.createMediaStreamSource(stream);
  let cleanup: () => void;

  if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(ctx, 'rc-tap', { numberOfInputs: 1, numberOfOutputs: 0 });
    node.port.onmessage = (e: MessageEvent<Float32Array>) => onSamples(e.data);
    source.connect(node);
    cleanup = () => {
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
    };
  } else {
    const proc = ctx.createScriptProcessor(2048, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    proc.onaudioprocess = (e) => onSamples(new Float32Array(e.inputBuffer.getChannelData(0)));
    source.connect(proc);
    proc.connect(mute);
    mute.connect(ctx.destination);
    cleanup = () => {
      proc.onaudioprocess = null;
      source.disconnect();
      proc.disconnect();
      mute.disconnect();
    };
  }

  return {
    sampleRate: ctx.sampleRate,
    stop() {
      cleanup();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}
