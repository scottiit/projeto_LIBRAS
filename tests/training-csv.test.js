import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readTraining, writeTraining } from '../scripts/training-csv.js';
import { CsvTrainingRepository, SplitProfileStorage, trainingFromBrowserProfiles } from '../js/csv-training.js';
import { ProfileStore } from '../js/storage.js';
import { normalizeHand, coordinatesToHand } from '../js/classifier.js';
import { SIGN_EXAMPLES } from '../js/dataset.js';

const example = SIGN_EXAMPLES.find(value => value.label === 'A');
const features = normalizeHand(coordinatesToHand(example.coordinates), example.aspectRatio);
const clip = () => ({ version: 2, durationMs: 1000, frames: Array.from({ length: 32 }, (_, index) => [...features, 0, -index / 31, 0]) });
const backup = () => ({
  version: 1, kind: 'libras-training',
  signExamples: { A: [{ features, confidenceProbability: .91, capturedAt: 10, comparisonSource: 'reference' }] },
  motionExamples: { K: [{ ...clip(), confidenceProbability: .97, capturedAt: 11, comparisonSource: 'repeatability' }] },
  legacyReferences: { signExamples: {}, motionExamples: {} },
  exampleOrder: { signExamples: { A: ['approved'] }, motionExamples: { K: ['approved'] } },
  pendingExamples: { J: { kind: 'motion', clip: clip(), createdAt: 12 } },
});
const browserStorage = () => {
  const data = new Map();
  return { data, get length() { return data.size; }, key: index => [...data.keys()][index], getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
};

test('CSV stores one row per approved capture, retains original references and restores motion/provisional data', async () => {
  const csvFile = pathToFileURL(join(tmpdir(), `libras-training-${randomUUID()}.csv`));
  const original = `${Array.from({ length: 63 }, (_, index) => index).join(',')},label\n${Array(63).fill(0).join(',')},A\n`;
  await writeFile(csvFile, original);
  try {
    await writeTraining('Ana', backup(), csvFile);
    const contents = await readFile(csvFile, 'utf8');
    assert.equal(contents.split('\n').filter(Boolean).length, 5); // header, original, A, K, provisional J
    assert.ok(contents.includes(`${Array(63).fill(0).join(',')},A,,,,,,`));
    const restored = await readTraining('Ana', csvFile);
    assert.equal(restored.signExamples.A.length, 1);
    assert.equal(restored.signExamples.A[0].confidenceProbability, .91);
    assert.equal(restored.motionExamples.K[0].frames.length, 32);
    assert.equal(restored.pendingExamples.J.createdAt, 12);
    assert.deepEqual((await readTraining('Bia', csvFile)).signExamples, {});
    const before = await readFile(csvFile, 'utf8');
    const invalid = backup(); invalid.signExamples.A[0].confidenceProbability = .85;
    await assert.rejects(writeTraining('Ana', invalid, csvFile));
    assert.equal(await readFile(csvFile, 'utf8'), before);
  } finally { await unlink(csvFile).catch(() => {}); }
});

test('browser metadata excludes training and old examples migrate once to CSV', async () => {
  const local = browserStorage();
  const oldStore = new ProfileStore(local);
  oldStore.login('Ana');
  oldStore.saveExamples('Ana', 'A', backup().signExamples.A);
  const split = new SplitProfileStorage(local), store = new ProfileStore(split);
  let onDisk = { version: 1, kind: 'libras-training', signExamples: {}, motionExamples: {}, legacyReferences: { signExamples: {}, motionExamples: {} }, exampleOrder: { signExamples: {}, motionExamples: {} }, pendingExamples: {} };
  const formerFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => ({ ok: true, json: async () => {
    if (options?.method === 'PUT') onDisk = JSON.parse(options.body).training;
    return onDisk;
  } });
  try {
    const repository = new CsvTrainingRepository(store, split, local);
    const first = await repository.load('Ana');
    assert.equal(first.signExamples.A.length, 1);
    assert.equal(onDisk.signExamples.A.length, 1);
    const raw = JSON.parse(local.getItem(store.key('Ana')));
    assert.equal(raw.signExamples, undefined);
    assert.equal(raw.motionExamples, undefined);
    assert.equal(raw.pendingExamples, undefined);
    await repository.load('Ana');
    assert.equal(store.read('Ana').signExamples.A.length, 1);
    store.saveExamples('Ana', 'A', [{ ...backup().signExamples.A[0], capturedAt: 20 }]);
    await repository.persist('Ana');
    assert.equal(onDisk.signExamples.A.length, 2);
    assert.equal(JSON.parse(local.getItem(store.key('Ana'))).signExamples, undefined);
  } finally { globalThis.fetch = formerFetch; }
});

test('failed CSV write restores the last confirmed examples without saving new ones in browser storage', async () => {
  const local = browserStorage();
  const split = new SplitProfileStorage(local), store = new ProfileStore(split);
  store.login('Ana');
  let current = backup();
  const formerFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => options?.method === 'PUT'
    ? { ok: false, status: 503, json: async () => ({ error: 'CSV indisponível' }) }
    : { ok: true, json: async () => current };
  try {
    const repository = new CsvTrainingRepository(store, split, local);
    await repository.load('Ana');
    store.saveExamples('Ana', 'A', [{ ...backup().signExamples.A[0], capturedAt: 21 }]);
    assert.equal(store.read('Ana').signExamples.A.length, 2);
    await assert.rejects(repository.persist('Ana'), /CSV indisponível/);
    assert.equal(store.read('Ana').signExamples.A.length, 1);
    assert.equal(JSON.parse(local.getItem(store.key('Ana'))).signExamples, undefined);
  } finally { globalThis.fetch = formerFetch; }
});

test('failed migration leaves pre-existing browser examples intact for retry', async () => {
  const local = browserStorage();
  const legacy = new ProfileStore(local);
  legacy.login('Ana'); legacy.saveExamples('Ana', 'A', backup().signExamples.A);
  const key = legacy.key('Ana'), original = local.getItem(key);
  const split = new SplitProfileStorage(local), store = new ProfileStore(split);
  const formerFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => options?.method === 'PUT'
    ? { ok: false, status: 503, json: async () => ({ error: 'Sem gravação' }) }
    : { ok: true, json: async () => ({ ...backup(), signExamples: {}, motionExamples: {}, pendingExamples: {}, exampleOrder: { signExamples: {}, motionExamples: {} } }) };
  try {
    await assert.rejects(new CsvTrainingRepository(store, split, local).load('Ana'), /Não foi possível migrar/);
    assert.equal(local.getItem(key), original);
  } finally { globalThis.fetch = formerFetch; }
});

test('file-page export transfers only training for the matching profile', () => {
  const previous = browserStorage(), store = new ProfileStore(previous);
  store.login('Ana'); store.saveExamples('Ana', 'A', backup().signExamples.A);
  const profile = JSON.parse(previous.getItem(store.key('Ana')));
  const payload = { version: 1, kind: 'libras-browser-profiles', profiles: [{
    name: profile.name, signExamples: profile.signExamples, motionExamples: profile.motionExamples, pendingExamples: profile.pendingExamples,
  }] };
  const restored = trainingFromBrowserProfiles(payload, 'ANA');
  assert.equal(restored.signExamples.A.length, 1);
  assert.equal(restored.signExamples.A[0].confidenceProbability, .91);
  assert.ok(!Object.hasOwn(payload.profiles[0], 'bestTimes'));
  assert.throws(() => trainingFromBrowserProfiles(payload, 'Bia'), /não contém exemplos/);
});
