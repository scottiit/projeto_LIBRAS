import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { readTraining } from './training-csv.js';
import { GLOBAL_TRAINING_PROFILE } from '../js/example-policy.js';
import { SIGN_REFERENCES } from '../js/dataset.js';

const root = new URL('../', import.meta.url);
const destination = new URL('dist/', root);
await mkdir(new URL('data/', destination), { recursive: true });
const training = await readTraining(GLOBAL_TRAINING_PROFILE);
// Provisional captures are not recognition examples and need not be published.
training.pendingExamples = {};
await writeFile(new URL('data/training.json', destination), JSON.stringify(training));
for (const name of ['js', 'assets', 'styles.css']) {
  await cp(new URL(name, root), new URL(name, destination), { recursive: true });
}
for (const path of new Set(Object.values(SIGN_REFERENCES))) {
  const target = new URL(path, destination);
  await mkdir(new URL('./', target), { recursive: true });
  await cp(new URL(path, root), target);
}
const html = (await readFile(new URL('index.html', root), 'utf8')).replace('<head>', '<head>\n  <meta name="libras-mode" content="static">');
await writeFile(new URL('index.html', destination), html);
await writeFile(new URL('.nojekyll', destination), '');
console.log('Publicação pronta em dist/. Inclui exemplos estáticos, movimentos e tolerâncias; sem API ou CSV privado.');
