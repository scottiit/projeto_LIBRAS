import test from 'node:test';
import assert from 'node:assert/strict';
import { TrainingManager } from '../js/training.js';
import { ProfileStore } from '../js/storage.js';
import { SignClassifier, normalizeHand, coordinatesToHand, CalibrationSession } from '../js/classifier.js';
import { MotionClassifier, MOTION_VERSION, validMotionClip } from '../js/dynamic.js';
import { SIGN_EXAMPLES } from '../js/dataset.js';

class MemoryStorage {
  data = new Map();
  writes = 0;
  get length() { return this.data.size; }
  key(index) { return [...this.data.keys()][index]; }
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) { this.data.set(key, String(value)); this.writes++; }
}

const referenceFeatures = label => {
  const example = SIGN_EXAMPLES.find(record => record.label === label);
  return normalizeHand(coordinatesToHand(example.coordinates), example.aspectRatio ?? 1);
};
const perturbedFeatures = (features, amount = 0.015) => features.map((value, index) =>
  index < 3 ? value : value + amount * Math.sin(index));
const scoreMetadata = (index = 0) => ({
  confidenceProbability: [0.88, 0.93, 0.98][index % 3],
  capturedAt: 1000 + index,
  comparisonSource: 'reference',
});

// Persisted coordinates use Float32. Check bounded numeric error while keeping
// dimensions exact; admission scores, labels and timestamps remain exact.
function assertCoordinatesClose(actual, expected) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => {
    if (Array.isArray(expected[index])) assertCoordinatesClose(value, expected[index]);
    else assert.ok(Math.abs(value - expected[index]) < 1e-6, `Coordinate ${index} changed beyond storage precision`);
  });
}

// Synthetic features exercise temporal admission and persistence, not the
// linguistic correctness or webcam accuracy of K or rejection examples.
function motionClip({ negative = false, variation = 0, version = MOTION_VERSION } = {}) {
  const pose = perturbedFeatures(referenceFeatures('I'), variation);
  return {
    version, durationMs: 1000,
    frames: Array.from({ length: 32 }, (_, index) => {
      const progress = index / 31;
      const path = negative ? [1.6 * progress, 0.7 * progress] : [0, -1.4 * progress];
      return [...pose, ...path, ...(version === 1 ? [] : [0])];
    }),
  };
}

function fixture() {
  const storage = new MemoryStorage();
  const store = new ProfileStore(storage);
  store.login('Ana');
  return { storage, store, manager: new TrainingManager(store, () => 123456) };
}

test('first static capture stays provisional across restart; a separate matching execution seeds the bank', () => {
  const { storage, store, manager } = fixture();
  const first = referenceFeatures('A');
  const initialClassifier = new SignClassifier([]);
  const pending = manager.recordStatic('Ana', '0', [first], initialClassifier);
  assert.equal(pending.state, 'pending');
  assert.equal(pending.savedCount, 0);
  assert.equal(store.read('Ana').signExamples?.['0']?.length ?? 0, 0);
  assert.equal(initialClassifier.hasClass('0'), false);
  const persistedPending = store.read('Ana').pendingExamples['0'];
  assert.equal(persistedPending.kind, 'static');
  assertCoordinatesClose(persistedPending.samples, [first]);
  assert.ok(Number.isFinite(persistedPending.createdAt));
  assert.equal(Object.hasOwn(persistedPending, 'confidenceProbability'), false);

  const reopenedStore = new ProfileStore(storage);
  const reopenedClassifier = new SignClassifier([]);
  reopenedClassifier.setPersonalExamples(reopenedStore.read('Ana').signExamples);
  assert.equal(reopenedClassifier.hasClass('0'), false);
  const second = perturbedFeatures(first);
  const saved = new TrainingManager(reopenedStore, () => 234567)
    .recordStatic('Ana', '0', [second], reopenedClassifier);
  assert.equal(saved.state, 'saved');
  assert.equal(saved.savedCount, 2);
  assert.equal(saved.comparisonSource, 'repeatability');
  assert.ok(saved.confidence > 0.85 && saved.confidence < 1);
  const restored = new ProfileStore(storage).read('Ana');
  assert.equal(restored.signExamples['0'].length, 2);
  assertCoordinatesClose(restored.signExamples['0'].map(record => record.features), [first, second]);
  assert.ok(restored.signExamples['0'].every(record => record.comparisonSource === 'repeatability'));
  assert.equal(restored.signExamples['0'][0].capturedAt, persistedPending.createdAt);
  assert.equal(restored.signExamples['0'][1].capturedAt, 234567);
  assert.equal(restored.pendingExamples?.['0'], undefined);

  const activeClassifier = new SignClassifier([]);
  activeClassifier.setPersonalExamples(restored.signExamples);
  assert.equal(activeClassifier.predictFeatures(second, 'numbers').targetClass, '0');
  assert.equal(initialClassifier.personal.length, 0);
  assert.equal(reopenedClassifier.personal.length, 0);
});

test('inconsistent bootstrap repetition leaves the provisional execution and dataset unchanged', () => {
  const { storage, store, manager } = fixture();
  const classifier = new SignClassifier([]);
  manager.recordStatic('Ana', '0', [referenceFeatures('A')], classifier);
  const before = storage.getItem(store.key('Ana'));
  const writes = storage.writes;
  const unlike = Array.from({ length: 63 }, (_, index) => index < 3 ? 0 : 15);
  const rejected = manager.recordStatic('Ana', '0', [unlike], classifier);
  assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.provisional, true);
  assert.equal(rejected.savedCount, 0);
  assert.equal(storage.writes, writes);
  assert.equal(storage.getItem(store.key('Ana')), before);
  assert.equal(classifier.hasClass('0'), false);
});

test('mutual bootstrap validates all observations, not only the easiest frame', () => {
  const { storage, store, manager } = fixture();
  const classifier = new SignClassifier([]);
  const first = referenceFeatures('A');
  const distant = Array.from({ length: 63 }, (_, index) => index < 3 ? 0 : 10);
  manager.recordStatic('Ana', '0', [first, distant], classifier);
  const before = storage.getItem(store.key('Ana'));
  const result = manager.recordStatic('Ana', '0', [perturbedFeatures(first)], classifier);
  assert.equal(result.state, 'rejected');
  assert.equal(storage.getItem(store.key('Ana')), before);
});

test('static examples use the existing reference confidence and persist admission metadata', () => {
  const { store, manager } = fixture();
  const classifier = new SignClassifier();
  const samples = [referenceFeatures('A'), perturbedFeatures(referenceFeatures('A'))];
  const expected = samples.map(features => classifier.predictFeatures(features).confidenceProbability);
  assert.ok(expected.every(value => value > 0.85));
  const result = manager.recordStatic('Ana', 'A', samples, classifier);
  assert.equal(result.state, 'saved');
  assert.equal(result.savedCount, 1);
  assert.equal(result.comparisonSource, 'reference');
  assert.equal(result.confidence, Math.min(...expected));
  const records = store.read('Ana').signExamples.A;
  assert.deepEqual(records.map(record => record.confidenceProbability), [Math.min(...expected)]);
  assertCoordinatesClose(records[0].features, samples[0]);
  assert.ok(records.every(record => record.capturedAt === 123456 && record.comparisonSource === 'reference'));
  assert.equal(classifier.personal.length, 0);
});

test('one complete static calibration saves one example, not its five internal frames', () => {
  const { storage, manager, store } = fixture();
  const reference = SIGN_EXAMPLES.find(record => record.label === 'A');
  const hand = coordinatesToHand(reference.coordinates);
  const capture = new CalibrationSession('A', 0);
  let status;
  for (let time = 2000; time <= 3200; time += 100) status = capture.observe(hand, time, reference.aspectRatio);
  assert.equal(status.state, 'complete');
  assert.equal(status.samples.length, 5);
  const result = manager.recordStatic('Ana', status.label, status.samples, new SignClassifier());
  assert.equal(result.savedCount, 1);
  assert.equal(result.profile.signExamples.A.length, 1);
  assert.equal(new ProfileStore(storage).read('Ana').signExamples.A.length, 1);
  assert.equal(store.read('Ana').pendingExamples?.A, undefined);
});

test('five-frame captures keep an observed central pose and the weakest confidence; FIFO evicts one record', () => {
  const { store, manager } = fixture();
  const center = referenceFeatures('A');
  const samples = [-.02, -.01, 0, .01, .02].map(offset => perturbedFeatures(center, offset));
  const classifier = new SignClassifier();
  const weakest = Math.min(...samples.map(features => classifier.predictFeatures(features).confidenceProbability));
  store.saveExamples('Ana', 'A', [.88, .89, .92, .94, ...Array(26).fill(.99)].map((score, index) => ({
    features: center, confidenceProbability: score, capturedAt: index + 1, comparisonSource: 'reference',
  })));
  const result = manager.recordStatic('Ana', 'A', samples, classifier);
  assert.equal(result.savedCount, 1);
  const records = store.read('Ana').signExamples.A;
  assert.equal(records.length, 30);
  assert.deepEqual(records.slice(0, 4).map(record => record.capturedAt), [1, 2, 3, 4]);
  assert.equal(records.filter(record => record.capturedAt <= 30).length, 29);
  assert.ok(!records.some(record => record.capturedAt === 5));
  assertCoordinatesClose(records.at(-1).features, center);
  assert.equal(records.at(-1).confidenceProbability, weakest);
});

test('two independent five-frame bootstrap captures become exactly two stored examples after reload', () => {
  const { storage, manager } = fixture();
  const first = Array.from({ length: 5 }, (_, index) => perturbedFeatures(referenceFeatures('A'), index * .002));
  const classifier = new SignClassifier([]);
  assert.equal(manager.recordStatic('Ana', '0', first, classifier).state, 'pending');
  const reloadedStore = new ProfileStore(storage);
  assert.equal(reloadedStore.read('Ana').pendingExamples['0'].samples.length, 5);
  const second = first.map(features => perturbedFeatures(features, .01));
  const result = new TrainingManager(reloadedStore).recordStatic('Ana', '0', second, classifier);
  assert.equal(result.state, 'saved');
  assert.equal(result.savedCount, 2);
  assert.equal(new ProfileStore(storage).read('Ana').signExamples['0'].length, 2);
  assert.equal(reloadedStore.read('Ana').pendingExamples['0'], undefined);
});

test('wrong class, the exact 85% boundary and invalid scores reject atomically without storage writes', () => {
  const { storage, store, manager } = fixture();
  const features = referenceFeatures('A');
  for (const [targetClass, confidenceProbability] of [
    ['B', 0.99], ['A', 0.85], ['A', 0.84], ['A', NaN], ['A', Infinity], ['A', 1.1],
  ]) {
    let calls = 0;
    const classifier = {
      hasClass: () => true,
      predictFeatures(observed, domain) {
        assert.equal(observed, features);
        assert.equal(domain, 'alphabet');
        // A later observation can reject the entire capture: the first cannot
        // be persisted optimistically while the others are still evaluated.
        return ++calls === 1 ? { targetClass: 'A', confidenceProbability: 0.99 } : { targetClass, confidenceProbability };
      },
    };
    const before = storage.getItem(store.key('Ana'));
    const writes = storage.writes;
    const result = manager.recordStatic('Ana', 'A', [features, features], classifier);
    assert.equal(result.state, 'rejected');
    assert.equal(result.savedCount, 0);
    assert.equal(calls, 2);
    assert.equal(storage.writes, writes);
    assert.equal(storage.getItem(store.key('Ana')), before);
  }
});

test('an outlier is evaluated before insertion and cannot authorize itself with a perfect self-match', () => {
  const { storage, store, manager } = fixture();
  const classifier = new SignClassifier();
  const candidate = Array.from({ length: 63 }, (_, index) => index < 3 ? 0 : 15);
  const originalBase = classifier.base.slice();
  const predict = classifier.predictFeatures.bind(classifier);
  let evaluated = false;
  classifier.predictFeatures = (features, domain) => {
    evaluated = true;
    assert.equal(classifier.personal.length, 0);
    assert.deepEqual(classifier.base, originalBase);
    assert.equal(classifier.base.some(record => record.features === candidate), false);
    return predict(features, domain);
  };
  const before = storage.getItem(store.key('Ana'));
  const result = manager.recordStatic('Ana', 'A', [candidate], classifier);
  assert.equal(evaluated, true);
  assert.equal(result.state, 'rejected');
  assert.equal(storage.getItem(store.key('Ana')), before);
  assert.equal(classifier.personal.length, 0);
});

test('competing classes remain active while checking a provisional pair', () => {
  const { storage, store, manager } = fixture();
  const features = referenceFeatures('A');
  const classifier = new SignClassifier([]);
  classifier.setPersonalExamples({ '1': [{ features, ...scoreMetadata() }] });
  assert.equal(manager.recordStatic('Ana', '0', [features], classifier).state, 'pending');
  const before = storage.getItem(store.key('Ana'));
  const result = manager.recordStatic('Ana', '0', [perturbedFeatures(features)], classifier);
  assert.equal(result.state, 'rejected');
  assert.equal(storage.getItem(store.key('Ana')), before);
  assert.equal(classifier.hasClass('0'), false);
});

test('dynamic bootstrap persists across restart and admits two distinct mutually matching clips', () => {
  const { storage, store, manager } = fixture();
  const first = motionClip();
  assert.equal(validMotionClip(first), true);
  const classifier = new MotionClassifier();
  const pending = manager.recordMotion('Ana', 'K', first, classifier);
  assert.equal(pending.state, 'pending');
  assert.equal(classifier.hasClass('K'), false);
  assert.equal(store.read('Ana').motionExamples?.K?.length ?? 0, 0);

  const reloadedStore = new ProfileStore(storage);
  const reloadedClassifier = new MotionClassifier(reloadedStore.read('Ana').motionExamples);
  const second = motionClip({ variation: 0.02 });
  const result = new TrainingManager(reloadedStore, () => 234567)
    .recordMotion('Ana', 'K', second, reloadedClassifier);
  assert.equal(result.state, 'saved');
  assert.equal(result.savedCount, 2);
  assert.equal(result.comparisonSource, 'repeatability');
  assert.ok(result.confidence > 0.85 && result.confidence < 1);
  const restored = new ProfileStore(storage).read('Ana');
  assert.equal(restored.motionExamples.K.length, 2);
  assertCoordinatesClose(restored.motionExamples.K.map(record => record.frames), [first.frames, second.frames]);
  assert.equal(restored.pendingExamples?.K, undefined);
  assert.equal(new MotionClassifier(restored.motionExamples).predict(second).targetClass, 'K');
  assert.equal(reloadedClassifier.hasClass('K'), false);
});

test('UNKNOWN can be admitted by repeatability and reference without becoming positive game evidence', () => {
  const { store, manager } = fixture();
  const classifier = new MotionClassifier({ K: [motionClip()] });
  const negative = motionClip({ negative: true });
  assert.equal(manager.recordMotion('Ana', 'UNKNOWN', negative, classifier).state, 'pending');
  const repeated = motionClip({ negative: true, variation: 0.02 });
  const result = manager.recordMotion('Ana', 'UNKNOWN', repeated, classifier);
  assert.equal(result.state, 'saved');
  assert.equal(result.savedCount, 2);
  assert.equal(result.comparisonSource, 'repeatability');

  const restored = new MotionClassifier({ ...store.read('Ana').motionExamples, K: [motionClip()] });
  const prediction = restored.predict(repeated);
  assert.equal(prediction.reason, 'negative');
  assert.equal(prediction.targetClass, null);
  assert.equal(prediction.confidenceProbability, 0);
  assert.ok(prediction.similarityScore > 0.85);
  const third = manager.recordMotion('Ana', 'UNKNOWN', motionClip({ negative: true, variation: 0.01 }), restored);
  assert.equal(third.state, 'saved');
  assert.equal(third.comparisonSource, 'reference');
  assert.equal(store.read('Ana').motionExamples.UNKNOWN.length, 3);
  assert.equal(restored.predict(motionClip()).targetClass, 'K');
});

test('reference-based motion rejects wrong class and negative evidence without changing storage', () => {
  const { storage, store, manager } = fixture();
  const negative = motionClip({ negative: true });
  const classifier = new MotionClassifier({ K: [motionClip()], J: [negative] });
  const before = storage.getItem(store.key('Ana'));
  const writes = storage.writes;
  const wrongClass = manager.recordMotion('Ana', 'K', negative, classifier);
  assert.equal(wrongClass.state, 'rejected');
  assert.equal(wrongClass.matchedLabel, 'J');
  const withUnknown = new MotionClassifier({ K: [motionClip()], UNKNOWN: [negative] });
  assert.equal(manager.recordMotion('Ana', 'K', negative, withUnknown).state, 'rejected');
  assert.equal(manager.recordMotion('Ana', 'UNKNOWN', motionClip(), withUnknown).state, 'rejected');
  assert.equal(storage.writes, writes);
  assert.equal(storage.getItem(store.key('Ana')), before);
});

test('a fresh store and fresh classifiers restore all 30 examples beyond old static and motion caps', () => {
  const { storage, store } = fixture();
  const staticRecords = Array.from({ length: 30 }, (_, index) => ({
    features: perturbedFeatures(referenceFeatures('A'), index / 10000),
    ...scoreMetadata(index),
  }));
  const motionRecords = Array.from({ length: 30 }, (_, index) => ({
    ...motionClip({ variation: index / 10000, version: index % 2 === 0 ? 1 : MOTION_VERSION }),
    ...scoreMetadata(index),
  }));
  store.saveExamples('Ana', 'A', staticRecords);
  store.saveMotions('Ana', 'K', motionRecords);

  const reopenedStore = new ProfileStore(storage);
  const profile = reopenedStore.read('Ana');
  const staticClassifier = new SignClassifier([]);
  staticClassifier.setPersonalExamples(profile.signExamples);
  const motionClassifier = new MotionClassifier(profile.motionExamples);
  assert.equal(staticClassifier.personal.length, 30);
  assert.equal(motionClassifier.examples.K.length, 30);
  assertCoordinatesClose(staticClassifier.personal.map(record => record.features), staticRecords.map(record => record.features));
  assertCoordinatesClose(motionClassifier.examples.K.map(record => record.frames), motionRecords.map(record => record.frames));
  assert.equal(staticClassifier.predictFeatures(staticRecords[0].features).targetClass, 'A');
  assert.equal(motionClassifier.predict(motionRecords[0]).targetClass, 'K');
  reopenedStore.login('Bruno');
  assert.equal(new SignClassifier([]).personal.length, 0);
  assert.equal(reopenedStore.read('Bruno').signExamples, undefined);
  assert.equal(new MotionClassifier(reopenedStore.read('Bruno').motionExamples).hasClass('K'), false);
});
