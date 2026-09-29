import test from 'node:test';
import assert from 'node:assert/strict';
import { ProfileStore } from '../js/storage.js';
import { SignClassifier, normalizeHand, coordinatesToHand } from '../js/classifier.js';
import { MotionClassifier } from '../js/dynamic.js';
import { SIGN_EXAMPLES, DATASET_METADATA } from '../js/dataset.js';
import { summarizeExamples } from '../js/example-policy.js';

function memoryStorage(limit = Infinity) {
  const data = new Map();
  return { data, getItem: key => data.get(key) ?? null, setItem(key, value) {
    const next = new Map(data); next.set(key, value);
    const bytes = [...next].reduce((sum, [key, value]) => sum + 2 * (key.length + value.length), 0);
    if (bytes > limit) { const error = new Error('quota'); error.name = 'QuotaExceededError'; throw error; }
    data.set(key, value);
  } };
}
const example = SIGN_EXAMPLES.find(item => item.label === 'A');
const features = normalizeHand(coordinatesToHand(example.coordinates), example.aspectRatio);
const staticRecord = (confidenceProbability, capturedAt) => ({ features: [...features], confidenceProbability, capturedAt, comparisonSource: 'reference' });
const motionRecord = (confidenceProbability, capturedAt) => ({
  version: 2, durationMs: 1000,
  frames: Array.from({ length: 32 }, (_, index) => [...features, 0, -index / 31, .3 * index / 31]),
  confidenceProbability, capturedAt, comparisonSource: 'repeatability',
});
const provisionalMotion = () => {
  const { version, durationMs, frames } = motionRecord(.99, 0);
  return { version, durationMs, frames };
};

test('stratified anchors and confidence metadata survive a fresh store and FIFO continues on reload', () => {
  const storage = memoryStorage();
  let store = new ProfileStore(storage);
  store.login('Ana'); store.login('Bia');
  const records = [.88, .89, .92, .94, ...Array(26).fill(.99)].map((score, index) => staticRecord(score, index + 1));
  store.saveExamples('Ana', 'A', records);
  store = new ProfileStore(storage);
  store.login('Ana');
  store.saveExamples('Ana', 'A', [staticRecord(.98, 31)]);
  const retained = store.read('Ana').signExamples.A;
  assert.equal(retained.length, 30);
  assert.deepEqual(retained.slice(0, 4).map(record => record.capturedAt), [1, 2, 3, 4]);
  assert.ok(!retained.some(record => record.capturedAt === 5));
  assert.equal(summarizeExamples(retained).buckets['85-90'].count, 2);
  assert.equal(store.read('Bia').signExamples, undefined);
  const classifier = new SignClassifier([]); classifier.setPersonalExamples(store.login('Ana').signExamples);
  assert.equal(classifier.personal.length, 30);
  assert.equal(classifier.predictFeatures(features).targetClass, 'A');
});

test('dynamic retention uses the same buckets and reload does not truncate the bank to eight', () => {
  const storage = memoryStorage(), store = new ProfileStore(storage);
  store.login('Ana');
  const scores = [.88, .89, .92, .94, ...Array(26).fill(.99)];
  store.saveMotions('Ana', 'K', scores.map((score, index) => motionRecord(score, index + 1)));
  const restored = new ProfileStore(storage);
  restored.saveMotion('Ana', 'K', motionRecord(.97, 31));
  const bank = restored.read('Ana').motionExamples;
  assert.equal(bank.K.length, 30);
  assert.deepEqual(bank.K.slice(0, 4).map(record => record.capturedAt), [1, 2, 3, 4]);
  assert.ok(!bank.K.some(record => record.capturedAt === 5));
  const classifier = new MotionClassifier(bank);
  assert.equal(classifier.examples.K.length, 30);
  assert.equal(classifier.predict(motionRecord(.97, 99)).targetClass, 'K');
});

test('low, absent and invalid similarity cannot enter either training bank, including imports', () => {
  const storage = memoryStorage(), store = new ProfileStore(storage);
  store.login('Ana');
  const before = storage.getItem(store.key('Ana'));
  for (const score of [.85, .84, 0, 1.01, NaN, Infinity, undefined, '0.99']) {
    assert.throws(() => store.saveExamples('Ana', 'A', [staticRecord(score, 1)]));
    assert.throws(() => store.saveMotion('Ana', 'K', motionRecord(score, 1)));
    assert.throws(() => store.importMotion('Ana', { version: 2, examples: { K: [motionRecord(score, 1)] } }));
    assert.equal(storage.getItem(store.key('Ana')), before);
  }
  assert.throws(() => store.saveExamples('Ana', 'A', [staticRecord(.99, 1), staticRecord(.85, 2)]));
  assert.equal(storage.getItem(store.key('Ana')), before);
});

test('full training backup restores poses, clips, provisional references and their queue order', () => {
  const storage = memoryStorage(), store = new ProfileStore(storage);
  const profile = store.login('Ana'); store.login('Bia');
  profile.signExamples = { A: [[...features]] }; store.write(profile);
  store.saveExamples('Ana', 'A', [staticRecord(.88, 1), staticRecord(.97, 2)]);
  store.saveMotion('Ana', 'K', motionRecord(.92, 3));
  store.stageExample('Ana', 'J', { kind: 'motion', clip: provisionalMotion() });
  const backup = JSON.parse(JSON.stringify(store.exportTraining('Ana')));
  assert.equal(backup.kind, 'libras-training');
  assert.ok(!Object.hasOwn(backup, 'name'));
  new ProfileStore(storage).importTraining('Bia', backup);
  const restored = store.read('Bia'), original = store.read('Ana');
  assert.deepEqual(restored.signExamples, original.signExamples);
  // JSON backups normalize -0 to 0, which has the same geometric meaning.
  assert.deepEqual(restored.motionExamples, JSON.parse(JSON.stringify(original.motionExamples)));
  assert.deepEqual(restored.pendingExamples, JSON.parse(JSON.stringify(original.pendingExamples)));
  assert.equal(restored.name, 'Bia');
  assert.equal(summarizeExamples(restored.signExamples.A).unscored, 1);
});

test('a full scored bank fits a 5 MiB localStorage budget using compact coordinates', () => {
  const storage = memoryStorage(5 * 1024 * 1024), store = new ProfileStore(storage);
  const profile = store.login('Capacity');
  profile.signExamples = Object.fromEntries([...DATASET_METADATA.staticClasses, ...'0123456789'].map(label => [label, Array.from({ length: 30 }, (_, index) => staticRecord(.96, index + 1))]));
  profile.motionExamples = Object.fromEntries(['H', 'J', 'K', 'X', 'Z', 'UNKNOWN'].map(label => [label, Array.from({ length: 30 }, (_, index) => motionRecord(.96, index + 1))]));
  store.write(profile);
  const restored = new ProfileStore(storage).read('Capacity');
  assert.equal(restored.signExamples.A.length, 30);
  assert.equal(restored.motionExamples.X.length, 30);
  restored.signExamples.A[0].features.forEach((value, index) => assert.ok(Math.abs(value - features[index]) < 1e-6));
  assert.ok(storage.getItem(store.key('Capacity')).length * 2 < 5 * 1024 * 1024);
});

test('quota failure never evicts an anchor or removes the saved provisional execution', () => {
  const storage = memoryStorage(), store = new ProfileStore(storage);
  store.login('Ana');
  store.saveExamples('Ana', 'A', [staticRecord(.88, 1), staticRecord(.89, 2)]);
  store.stageExample('Ana', 'K', { kind: 'motion', clip: provisionalMotion() });
  const before = storage.getItem(store.key('Ana'));
  storage.setItem = () => { const error = new Error('quota'); error.name = 'QuotaExceededError'; throw error; };
  assert.throws(() => store.saveMotion('Ana', 'K', motionRecord(.99, 4)));
  assert.equal(storage.getItem(store.key('Ana')), before);
  assert.equal(store.read('Ana').signExamples.A.length, 2);
  assert.ok(store.read('Ana').pendingExamples.K);
});
