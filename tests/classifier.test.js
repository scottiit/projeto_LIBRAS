import test from 'node:test';
import assert from 'node:assert/strict';
import { SignClassifier, normalizeHand, coordinatesToHand, CalibrationSession } from '../js/classifier.js';
import { SIGN_EXAMPLES, DATASET_METADATA } from '../js/dataset.js';
import { GameEngine } from '../js/engine.js';
import { ProfileStore } from '../js/storage.js';

const exampleHand = label => {
  const example = SIGN_EXAMPLES.find(example => example.label === label);
  return coordinatesToHand(example.coordinates).map(point => ({ x: point.x * example.aspectRatio, y: point.y, z: point.z * example.aspectRatio }));
};
test('bundled data covers all 23 static classes including E, T and U', () => {
  assert.equal(DATASET_METADATA.staticClasses.length, 23);
  const classifier = new SignClassifier();
  for (const label of DATASET_METADATA.staticClasses) assert.equal(classifier.hasClass(label), true);
  for (const label of ['J', 'Z', 'X', '0', '9']) assert.equal(classifier.hasClass(label), false);
});
test('all reference examples are classified by their actual class, independent of the game target', () => {
  const classifier = new SignClassifier();
  for (const example of SIGN_EXAMPLES) {
    const result = classifier.predict(coordinatesToHand(example.coordinates), 'alphabet', example.aspectRatio);
    assert.equal(result.targetClass, example.label);
    assert.ok(result.confidenceProbability > .85, `${example.label} below confirmation gate`);
  }
});
test('translation, scale, reflection and modest landmark noise preserve static predictions', () => {
  const classifier = new SignClassifier();
  for (const label of DATASET_METADATA.staticClasses) {
    const original = exampleHand(label);
    for (const scale of [.5, 1, 1.6]) for (const mirror of [-1, 1]) {
      const transformed = original.map((point, index) => ({
        x: .5 + point.x * scale * mirror + Math.sin(index * 2) * .0005,
        y: .5 + point.y * scale + Math.cos(index * 3) * .0005,
        z: point.z * scale + Math.sin(index * 4) * .0005,
      }));
      const result = classifier.predict(transformed);
      assert.equal(result.targetClass, label);
      assert.ok(result.confidenceProbability > .85, `${label}: ${result.confidenceProbability}`);
    }
  }
});
test('out-of-distribution, invalid, degenerate and ambiguous hands cannot be approved', () => {
  const classifier = new SignClassifier();
  for (const hand of [null, [], Array(21).fill({ x: .5, y: .5, z: 0 }), Array(21).fill({ x: NaN, y: 0, z: 0 })]) assert.equal(classifier.predict(hand).confidenceProbability, 0);
  const unusual = exampleHand('A').map((point, index) => index % 4 === 0 && index > 0 ? { ...point, x: point.x + 2 } : point);
  assert.ok(classifier.predict(unusual).confidenceProbability <= .85);
  const coordinates = SIGN_EXAMPLES[0].coordinates;
  const ambiguous = new SignClassifier([{ label: 'A', coordinates }, { label: 'B', coordinates }]);
  assert.equal(ambiguous.predict(coordinatesToHand(coordinates)).confidenceProbability, .5);
});
test('portrait training and landscape camera use the same aspect-corrected geometry', () => {
  const classifier = new SignClassifier();
  for (const example of SIGN_EXAMPLES) {
    const aspect = 16 / 9;
    const videoHand = coordinatesToHand(example.coordinates).map(point => ({ x: .5 + point.x * example.aspectRatio / aspect, y: .5 + point.y, z: point.z * example.aspectRatio / aspect }));
    const prediction = classifier.predict(videoHand, 'alphabet', aspect);
    assert.equal(prediction.targetClass, example.label);
    assert.ok(prediction.confidenceProbability > .85);
  }
});
test('real classifier reaches game confirmation after 1000ms; wrong signs never advance', () => {
  const classifier = new SignClassifier();
  let now = 0;
  const engine = new GameEngine({ clock: () => now });
  engine.start([{ target: 'A' }, { target: 'B' }]);
  for (now = 0; now <= 1100; now += 50) engine.observe(classifier.predict(exampleHand('B')), now);
  assert.equal(engine.index, 0);
  for (now = 1200; now <= 2150; now += 50) engine.observe(classifier.predict(exampleHand('A')), now);
  assert.equal(engine.index, 0);
  now = 2200; engine.observe(classifier.predict(exampleHand('A')), now);
  assert.equal(engine.index, 1);
});
test('personal examples support numbers without relabeling an alphabet prediction', () => {
  const classifier = new SignClassifier();
  assert.equal(classifier.predict(exampleHand('A'), 'numbers').targetClass, null);
  classifier.setPersonalExamples({ 1: [normalizeHand(exampleHand('D'))], 2: [normalizeHand(exampleHand('V'))] });
  assert.equal(classifier.predict(exampleHand('V'), 'numbers').targetClass, '2');
  assert.equal(classifier.predict(exampleHand('V')).targetClass, 'V');
  classifier.setPersonalExamples();
  assert.equal(classifier.predict(exampleHand('V'), 'numbers').targetClass, null);
});
test('calibration requires warmup plus uninterrupted stable observations, rejects movement and gaps', () => {
  const capture = new CalibrationSession('A', 0);
  assert.equal(capture.observe(exampleHand('A'), 1000).state, 'warmup');
  for (let time = 2000; time < 3000; time += 100) capture.observe(exampleHand('A'), time);
  assert.equal(capture.observe(null, 3000).state, 'tracking-lost');
  capture.observe(exampleHand('A'), 3100);
  assert.equal(capture.observe(exampleHand('B'), 3200).progress, 0);
  assert.equal(capture.observe(exampleHand('A'), 3500).progress, 0);
  let result;
  for (let time = 3600; time <= 4700; time += 100) result = capture.observe(exampleHand('A'), time);
  assert.equal(result.state, 'complete'); assert.equal(result.samples.length, 5);
  assert.equal(new CalibrationSession('A', 0).observe(exampleHand('A'), 16000).state, 'timeout');
  assert.throws(() => new CalibrationSession('J', 0));
});
test('calibration storage is bounded, profile-scoped and migration enables camera only once', () => {
  const memory = new Map();
  const storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
  const store = new ProfileStore(storage);
  const ana = store.login('Ana'); store.login('Bia');
  assert.equal(ana.settings.simulation, false);
  const samples = Array(5).fill(normalizeHand(exampleHand('A')));
  for (let index = 0; index < 4; index++) store.saveExamples('Ana', 'A', samples);
  assert.equal(store.read('Ana').signExamples.A.length, 12);
  assert.equal(store.read('Bia').signExamples, undefined);
  store.saveSettings('Ana', { simulation: true });
  assert.equal(store.login('Ana').settings.simulation, true);
  assert.throws(() => store.saveExamples('Ana', 'J', samples));
});
