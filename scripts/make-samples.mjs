// samples/scores.mjs 의 정의로 public/samples/*.musicxml 과 index.json 을 만든다.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCORES, toMusicXML } from '../samples/scores.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'samples');
mkdirSync(outDir, { recursive: true });
const index = [];
for (const s of SCORES) {
  const file = `${s.id}.musicxml`;
  writeFileSync(join(outDir, file), toMusicXML(s));
  index.push({ id: s.id, title: s.title, composer: s.composer, file });
}
writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
console.log(`wrote ${index.length} samples to ${outDir}`);
