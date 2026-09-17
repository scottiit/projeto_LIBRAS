import test from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../js/engine.js';
import { createSequence, MODES, WORDS, formatTime } from '../js/games.js';
import { ProfileStore } from '../js/storage.js';
import { TrajectoryBuffer, DynamicRecognizer, detectZMovement, detectJMovement, detectXMovement } from '../js/trajectory.js';
import { StaticClassifierMock } from '../js/vision.js';

function fixture(sequence = ['A', 'B']) {
  let now = 0, finishes = 0;
  const engine = new GameEngine({ clock: () => now, onFinish: () => finishes++ });
  engine.start(sequence.map(target => ({ target })));
  return { engine, finishes: () => finishes, set: value => { now = value; }, frame(time, confidence = 0.9, target = engine.current?.target) { now = time; return engine.observe({ targetClass: target, confidenceProbability: confidence, timestamp: Date.now() }, time); } };
}
test('approves only at 1000 ms, advances instantly and keeps master timer', () => {
  const f = fixture();
  for (let time = 0; time <= 900; time += 100) f.frame(time);
  f.frame(999); assert.equal(f.engine.index, 0);
  f.frame(1000); assert.equal(f.engine.index, 1); assert.equal(f.engine.elapsed(), 1000);
  for (let time = 1100; time <= 2100; time += 100) f.frame(time);
  assert.equal(f.engine.state, 'finished'); assert.equal(f.engine.elapsed(), 2100);
  f.set(3000); assert.equal(f.engine.elapsed(), 2100); assert.equal(f.finishes(), 1);
  f.frame(3100); assert.equal(f.finishes(), 1);
});
for (const confidence of [0.84, 0.85, 0, NaN, Infinity, 1.1]) test(`confidence ${confidence} breaks continuity`, () => {
  const f = fixture();
  for (let time = 0; time <= 800; time += 100) f.frame(time);
  f.frame(900, confidence); assert.equal(f.engine.holdStartedAt, null);
  for (let time = 1000; time <= 1900; time += 100) f.frame(time);
  assert.equal(f.engine.index, 0); f.frame(2000); assert.equal(f.engine.index, 1);
});
test('null, wrong class, duplicate, stale observation and tracking gaps invalidate', () => {
  const f = fixture();
  f.frame(0); f.frame(100); f.frame(200, .99, 'Z'); assert.equal(f.engine.holdStartedAt, null);
  f.frame(300); f.engine.observe(null, 300); assert.equal(f.engine.holdStartedAt, null);
  f.frame(400); f.frame(400); assert.equal(f.engine.holdStartedAt, null);
  f.frame(500); f.frame(800); assert.equal(f.engine.holdStartedAt, 800);
  f.set(1000); f.engine.tick(); assert.equal(f.engine.holdStartedAt, null);
  f.engine.observe({ targetClass: 'A', confidenceProbability: .99, timestamp: Date.now() }, 800);
  assert.equal(f.engine.holdStartedAt, null);
});
test('UI ticks alone can never approve and cancellation blocks predictions', () => {
  const f = fixture(['A']); f.frame(0); f.set(1000); f.engine.tick(); assert.equal(f.engine.index, 0);
  f.engine.cancel(); f.frame(1100); assert.equal(f.engine.state, 'cancelled');
});
test('six modes, ordered coverage, random uniqueness, full word indices', () => {
  assert.equal(MODES.length, 6); assert.ok(WORDS.length >= 20);
  assert.equal(createSequence('alphabet-ordered').map(step => step.target).join(''), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  assert.equal(createSequence('numbers-ordered').map(step => step.target).join(''), '0123456789');
  for (let run = 0; run < 100; run++) for (const mode of ['alphabet-random', 'numbers-random']) {
    const sequence = createSequence(mode); assert.equal(sequence.length, 5); assert.equal(new Set(sequence.map(step => step.target)).size, 5);
  }
  const words = createSequence('words-fixed');
  assert.equal(words.map(step => step.target).join(''), 'BOLACASAMAOLUZ');
  assert.deepEqual(words[4], { target: 'C', word: 'CASA', wordIndex: 1, letterIndex: 0 });
  assert.throws(() => createSequence('toString'));
  assert.equal(formatTime(61234.8), '01:01:234');
});
class MemoryStorage {
  data = new Map(); writes = 0;
  get length() { return this.data.size; }
  key(index) { return [...this.data.keys()][index]; }
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) { this.data.set(key, value); this.writes++; }
}
test('profile isolation, access history, settings, strict best-time and separate simulation', () => {
  const storage = new MemoryStorage(), store = new ProfileStore(storage);
  store.login('  Ana  '); store.login('ANA'); store.login('Bruno');
  assert.equal(store.read('ana').accessHistory.length, 2);
  store.saveScore('ana', 'alphabet-ordered', 4000);
  const writes = storage.writes;
  assert.equal(store.saveScore('ana', 'alphabet-ordered', 4000).improved, false);
  assert.equal(store.saveScore('ana', 'alphabet-ordered', 5000).improved, false);
  assert.equal(storage.writes, writes);
  assert.equal(store.saveScore('ana', 'alphabet-ordered', 3999).improved, true);
  store.saveScore('ana', 'alphabet-ordered', 1000, true);
  assert.equal(store.read('ana').bestTimes['alphabet-ordered'], 3999);
  assert.equal(store.read('ana').demoBestTimes['alphabet-ordered'], 1000);
  assert.deepEqual(store.read('Bruno').bestTimes, {});
  store.saveSettings('ana', { simulation: false }); assert.equal(store.read('ana').settings.simulation, false);
  assert.throws(() => store.login('   ')); assert.throws(() => store.saveScore('ana', 'mode', NaN));
});
test('corrupt and quota-limited storage fail without claiming success', () => {
  const storage = new MemoryStorage(), store = new ProfileStore(storage);
  storage.setItem(store.key('corrupt'), '{');
  assert.throws(() => store.login('corrupt')); assert.equal(storage.getItem(store.key('corrupt')), '{');
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.throws(() => store.login('new'));
});
function hand() {
  const points = Array.from({ length: 21 }, () => ({ x: .5, y: .6, z: 0 }));
  points[0] = { x: .5, y: .8, z: 0 };
  points[9] = { x: .5, y: .6, z: 0 };
  points[5] = { x: .5, y: .6, z: 0 };
  points[6] = { x: .5, y: .5, z: 0 };
  points[8] = { x: .5, y: .3, z: 0 };
  return points;
}
test('bounded ring stores 3D coordinates, mirrors X, resets on invalid input and gaps', () => {
  const buffer = new TrajectoryBuffer(60);
  const points = hand(); points[8].x = .3; points[8].z = -.2;
  for (let index = 0; index < 80; index++) buffer.push(points, index * 30);
  assert.equal(buffer.frames.length, 60);
  assert.deepEqual(buffer.frames[0].landmarks[8], { x: .7, y: .3, z: -.2 });
  buffer.push(points, 3000); assert.equal(buffer.frames.length, 1);
  buffer.push(null, 3030); assert.equal(buffer.frames.length, 0);
});
test('Z accepts three directional strokes and rejects straight lines and malformed arrays', () => {
  const frames = [];
  for (let index = 0; index <= 18; index++) {
    const points = hand();
    const step = index <= 6 ? [index * .025, 0] : index <= 12 ? [.15 - (index - 6) * .025, (index - 6) * .025] : [(index - 12) * .025, .15];
    points[8] = { x: .3 + step[0], y: .15 + step[1], z: 0 };
    frames.push({ landmarks: points, time: index * 30, handedness: 'Right' });
  }
  assert.equal(detectZMovement(frames), true);
  const line = frames.map((frame, index) => ({ ...frame, landmarks: frame.landmarks.map((point, id) => id === 8 ? { x: .3 + index * .025, y: .15, z: 0 } : point) }));
  assert.equal(detectZMovement(line), false);
  for (const detector of [detectZMovement, detectJMovement, detectXMovement]) {
    assert.equal(detector(null), false); assert.equal(detector([{}]), false); assert.equal(detector(Array(12).fill({})), false);
  }
});
test('static mock never equates a tracked hand with a classified sign', async () => {
  const mock = new StaticClassifierMock();
  assert.equal((await mock.predict(hand(), 'A')).confidenceProbability, 0);
  const prediction = await mock.predict(null, 'A', true);
  assert.equal(prediction.targetClass, 'A'); assert.ok(prediction.confidenceProbability > .85); assert.ok(Number.isFinite(prediction.timestamp));
});
test('dynamic recognizer does not approve stationary hands or missing tracking', () => {
  const recognizer = new DynamicRecognizer();
  for (const target of ['J', 'Z', 'X']) {
    for (let index = 0; index < 90; index++) assert.equal(recognizer.predict(hand(), target, index * 30, 'Right'), 0);
  }
  assert.equal(recognizer.predict(null, 'J', 3000, 'Right'), 0);
});
test('J requires stable I, wrist descent and progressive inward curvature', () => {
  const path = Array.from({ length: 6 }, () => [0, 0]);
  for (let index = 1; index <= 6; index++) path.push([0, index * .025]);
  for (let index = 1; index <= 8; index++) {
    const angle = Math.PI - index * Math.PI / 8;
    path.push([.08 + Math.cos(angle) * .08, .15 + Math.sin(angle) * .08]);
  }
  const frames = path.map(([dx, dy], index) => {
    const points = hand(); points[8].y = .65;
    points[18] = { x: .5, y: .5, z: 0 }; points[20] = { x: .5, y: .25, z: 0 };
    return { landmarks: points.map(point => ({ x: point.x + dx, y: point.y + dy, z: point.z })), time: index * 30, handedness: 'Right' };
  });
  assert.equal(detectJMovement(frames), true);
  const reversed = frames.map(frame => ({ ...frame, landmarks: frame.landmarks.map(point => ({ ...point, x: 1 - point.x })) }));
  assert.equal(detectJMovement(reversed), false);
  assert.equal(detectJMovement(reversed.map(frame => ({ ...frame, handedness: 'Left' }))), true);
});
test('X requires simultaneous acute flexion and depth toward camera', () => {
  const frames = Array.from({ length: 10 }, (_, index) => {
    const points = hand(), ratio = index / 9;
    points[8] = { x: .5, y: .3 + ratio * .32, z: -ratio * .1 };
    return { landmarks: points, time: index * 30, handedness: 'Right' };
  });
  assert.equal(detectXMovement(frames), true);
  assert.equal(detectXMovement(frames.map(frame => ({ ...frame, landmarks: frame.landmarks.map(point => ({ ...point, z: -point.z })) }))), false);
});
test('completed dynamic motion needs fresh stable terminal frames for an entire second', () => {
  const f = fixture(['Z', 'A']), recognizer = new DynamicRecognizer();
  let rawHand;
  for (let index = 0; index <= 18; index++) {
    const points = hand();
    const step = index <= 6 ? [index * .025, 0] : index <= 12 ? [.15 - (index - 6) * .025, (index - 6) * .025] : [(index - 12) * .025, .15];
    points[8] = { x: .3 + step[0], y: .15 + step[1], z: 0 };
    rawHand = points.map(point => ({ ...point, x: 1 - point.x }));
    const probability = recognizer.predict(rawHand, 'Z', index * 30, 'Right');
    f.frame(index * 30, probability);
  }
  assert.equal(f.engine.index, 0);
  for (let time = 570; time <= 1560; time += 30) {
    const probability = recognizer.predict(rawHand, 'Z', time, 'Right');
    f.frame(time, probability, 'Z');
  }
  assert.equal(f.engine.index, 1);
  assert.equal(recognizer.predict(null, 'Z', 1590, 'Right'), 0);
  assert.equal(recognizer.predict(rawHand, 'Z', 1620, 'Right'), 0);
});
