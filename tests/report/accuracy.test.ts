// 추적 정확도 리포트 (npm run report). 합성 연주로 여러 상황을 돌려 표로 출력한다.
import { test } from 'vitest';
import { loadSample, run, summarize } from '../harness';
import { playSegments, withWrongNotes } from '../scenarios';

const show = (label: string, r: ReturnType<typeof run>, linear = true) => console.log(label.padEnd(36), summarize(r, linear));

test('tempo × timbre', () => {
  for (const id of ['ode-to-joy', 'twinkle', 'bach-prelude-c']) {
    const s = loadSample(id);
    for (const timbre of ['piano', 'strings'] as const) {
      for (const [label, f] of [['악보 템포', 1], ['0.7배', 0.7], ['0.55배', 0.55], ['1.35배', 1.35]] as const) {
        show(`${id} ${timbre} ${label}`, run(s, { timbre, bpm: s.bpm * f, tempoWobble: 0.1, seed: 3 }));
      }
    }
  }
}, 600000);

test('콩쿠르 홀 (잔향·페달·박수)', () => {
  const ode = loadSample('ode-to-joy');
  const bach = loadSample('bach-prelude-c');
  show('바흐 마른 소리', run(bach, { timbre: 'piano', tempoWobble: 0.1, seed: 4 }));
  show('바흐 페달', run(bach, { timbre: 'piano', pedalBeats: 2, tempoWobble: 0.1, seed: 4 }));
  show('바흐 홀 잔향', run(bach, { timbre: 'piano', reverb: 0.5, tempoWobble: 0.1, seed: 4 }));
  show('바흐 페달 + 홀 잔향', run(bach, { timbre: 'piano', reverb: 0.5, pedalBeats: 2, tempoWobble: 0.1, seed: 4 }));
  show('환희의 송가 페달 + 홀', run(ode, { timbre: 'piano', reverb: 0.5, pedalBeats: 4, tempoWobble: 0.08, seed: 3 }));
  show('환희의 송가 느리게 + 페달 + 홀', run(ode, { timbre: 'piano', bpm: 75, reverb: 0.6, pedalBeats: 2, tempoWobble: 0.08, seed: 6 }));
  show('박수 뒤 시작', run(ode, { timbre: 'piano', leadIn: 4, applause: [[0.3, 3.2, 0.08]], reverb: 0.4, tempoWobble: 0.08, seed: 3 }));
}, 900000);

test('연습 상황', () => {
  const ode = loadSample('ode-to-joy');
  const all = playSegments(ode, [[0, 64]]);
  show('3초 멈춤', run(ode, { timbre: 'piano', pauses: [[16, 3]], tempoWobble: 0.05, seed: 2 }));
  show('6마디 치다가 처음부터 (연습 모드)', run(ode, { timbre: 'piano', play: playSegments(ode, [[0, 24], [0, 64]]), tempoWobble: 0.05, seed: 2, backward: 'free' }), false);
  show('10마디 치다가 9마디로 (연습 모드)', run(ode, { timbre: 'piano', play: playSegments(ode, [[0, 40], [32, 64]]), tempoWobble: 0.05, seed: 2, backward: 'free' }), false);
  show('틀린 음 10%', run(ode, { timbre: 'piano', play: withWrongNotes(all, 0.1), tempoWobble: 0.05, seed: 2 }), false);
  const m9 = ode.events.findIndex((e) => e.measure === 9);
  show('9마디부터 (위치 지정)', run(ode, { timbre: 'piano', play: playSegments(ode, [[32, 64]]), startAt: m9, tempoWobble: 0.05, seed: 2 }), false);
  show('시끄러운 환경', run(ode, { timbre: 'strings', noise: 0.02, tempoWobble: 0.05, seed: 2 }));
  show('설정 템포가 2배로 틀림', run(ode, { timbre: 'piano', bpm: 70, trackerBpm: 140, tempoWobble: 0.05, seed: 2 }));
}, 600000);
