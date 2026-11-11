import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ProfileStore } from '../js/storage.js';
import { SplitProfileStorage, StaticTrainingRepository } from '../js/csv-training.js';
import { readTraining } from '../scripts/training-csv.js';
import { GLOBAL_TRAINING_PROFILE } from '../js/example-policy.js';

test('published snapshot preserves accepted banks, ordering and thresholds from CSV', async () => {
  const expected = await readTraining(GLOBAL_TRAINING_PROFILE);
  expected.pendingExamples = {};
  const snapshot = JSON.parse(await readFile(new URL('../dist/data/training.json', import.meta.url)));
  assert.deepEqual(snapshot, expected);
});

test('static login loads shared examples, keeps profiles local and refuses writes', async () => {
  const snapshot = JSON.parse(await readFile(new URL('../dist/data/training.json', import.meta.url)));
  const values = new Map();
  const browser = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const split = new SplitProfileStorage(browser), store = new ProfileStore(split);
  const calls = [];
  const repository = new StaticTrainingRepository(store, split, 'https://example.test/repository/data/training.json', async (...args) => {
    calls.push(args); return { ok: true, json: async () => snapshot };
  });
  for (const name of ['First', 'Second']) { store.login(name); await repository.load(name); }
  assert.deepEqual(store.read('First').signExamples, store.read('Second').signExamples);
  assert.deepEqual(store.read('First').motionExamples, store.read('Second').motionExamples);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://example.test/repository/data/training.json');
  await assert.rejects(repository.persist('First'), /servidor local/);
  assert.equal(calls.length, 1);
  assert.equal(Object.hasOwn(JSON.parse(values.get(store.key('First'))), 'signExamples'), false);
});

test('missing or invalid static base fails visibly instead of entering with an empty dataset', async () => {
  for (const response of [{ ok: false }, { ok: true, json: async () => ({}) }]) {
    const repository = new StaticTrainingRepository({}, {}, 'data/training.json', async () => response);
    await assert.rejects(repository.load('User'), /publicad/);
  }
});
