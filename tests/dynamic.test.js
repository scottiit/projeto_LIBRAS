import test from 'node:test';
import assert from 'node:assert/strict';
import { MotionSegmenter, MotionClassifier, MotionCapture, TemporalRecognizer, motionDtw, validMotionClip, inspectDepthRetreat, MOTION_VERSION } from '../js/dynamic.js';
import { SIGN_EXAMPLES } from '../js/dataset.js';
import { coordinatesToHand } from '../js/classifier.js';
import { ProfileStore } from '../js/storage.js';
import { GameEngine } from '../js/engine.js';
import { VisionController } from '../js/vision.js';

// Synthetic geometry tests verify the algorithm, NOT linguistic validity or
// real-world H/J/K/X/Z accuracy. Production ships no synthetic training templates.
const base = coordinatesToHand(SIGN_EXAMPLES.find(example => example.label === 'I').coordinates);
const pathPoints = {
  H: [[0, 0], [0, 0], [0, 0], [0, 0]],
  Z: [[0, 0], [.18, 0], [0, .18], [.18, .18]],
  J: [[0, 0], [0, .13], [-.04, .22], [-.15, .16]],
  K: [[0, 0], [0, -.07], [0, -.14], [0, -.22]],
  X: [[0, 0], [0, 0], [0, 0], [0, 0]],
  BAD: [[0, 0], [0, -.1], [.18, -.18], [.2, -.2]],
};
function frames(label, { speed = 1, step = 50, scale = 1, mirror = false, aspect = 1, offset = 0, warp = false, retreat = .3, jitter = 0, tilt = 0, fingerDrift = 0 } = {}) {
  const points = pathPoints[label], output = [];
  const duration = 1000 * speed;
  for (let time = 0; time <= 500 + duration + 500; time += step) {
    let u = Math.max(0, Math.min(1, (time - 500) / duration));
    if (warp) u = u < .5 ? u * .75 : .375 + (u - .5) * 1.25;
    const index = Math.min(2, Math.floor(u * 3)), fraction = u * 3 - index;
    const x = points[index][0] + fraction * (points[index + 1][0] - points[index][0]);
    const y = points[index][1] + fraction * (points[index + 1][1] - points[index][1]);
    // H and K start from the exact same synthetic hand. Rotate H around the
    // wrist's Y axis; translate K upwards. No finger pose changes are invented.
    const angle = label === 'H' ? u * Math.PI / 2 : u * tilt * Math.PI / 180;
    const projectedScale = (label === 'X' ? 1 - retreat * u : 1) * (1 + jitter * Math.sin(time * .1));
    const hand = base.map((point, joint) => {
      const dx = point.x - base[0].x, dz = point.z - base[0].z;
      const rotatedX = base[0].x + dx * Math.cos(angle) + dz * Math.sin(angle);
      const rotatedZ = base[0].z - dx * Math.sin(angle) + dz * Math.cos(angle);
      const fingerOffset = joint >= 6 && joint <= 8 ? fingerDrift * u : 0;
      return { x: (.1 + scale * (rotatedX * projectedScale + x)) * (mirror ? -1 : 1) / aspect, y: .1 + scale * ((point.y + fingerOffset) * projectedScale + y), z: rotatedZ * scale * projectedScale / aspect };
    });
    output.push({ hand, time: time + offset, handedness: mirror ? 'Left' : 'Right', aspect });
  }
  return output;
}
function capture(label, options) {
  const segmenter = new MotionSegmenter();
  for (const frame of frames(label, options)) {
    const result = segmenter.observe(frame.hand, frame.time, frame.handedness, frame.aspect);
    if (result.state === 'complete') return result.clip;
  }
  assert.fail(`No clip captured for ${label}`);
}
const samples = () => ({ H: [capture('H')], J: [capture('J')], K: [capture('K')], X: [capture('X')], Z: [capture('Z')] });

test('segmentation encodes bounded shape + anchored trajectory, not a stationary pose', () => {
  const clip = capture('Z');
  assert.ok(validMotionClip(clip));
  assert.equal(clip.frames.length, 32);
  assert.equal(clip.frames[0].length, 66);
  assert.equal(clip.frames[0][63], 0);
  assert.ok(Math.abs(clip.frames.at(-1)[63]) > .3);
  assert.equal(motionDtw(clip, clip), 0);
  const segmenter = new MotionSegmenter();
  for (let time = 0; time <= 5000; time += 50) assert.notEqual(segmenter.observe(base, time, 'Right').state, 'complete');
});

test('DTW tolerates speed, FPS, handedness, image aspect and scale without erasing path', () => {
  const classifier = new MotionClassifier(samples());
  for (const label of ['H', 'J', 'K', 'X', 'Z']) for (const options of [{ speed: 1.4, step: 40 }, { speed: .8, step: 25 }, { scale: 1.4, mirror: true, aspect: 16 / 9 }, { warp: true }]) {
    const prediction = classifier.predict(capture(label, options));
    assert.equal(prediction.targetClass, label, `${label}: ${JSON.stringify(prediction.alternatives)}`);
    assert.ok(prediction.confidenceProbability > .85);
  }
});

test('X preserves a pure apparent contraction despite identical normalized pose and wrist XY', () => {
  const clip = capture('X');
  assert.equal(clip.version, 2);
  assert.equal(clip.frames[0][65], 0);
  assert.ok(clip.frames.every(frame => frame[63] === 0 && frame[64] === 0));
  for (const frame of clip.frames) for (let index = 0; index < 63; index++) assert.ok(Math.abs(frame[index] - clip.frames[0][index]) < 1e-12);
  const depth = inspectDepthRetreat(clip);
  assert.equal(depth.eligible, true);
  assert.ok(depth.scaleRatio > .69 && depth.scaleRatio < .74);
  assert.ok(Math.abs(depth.relativeDistanceRatio * depth.scaleRatio - 1) < 1e-12);
  const classifier = new MotionClassifier(samples());
  for (const options of [{ speed: 2.5 }, { scale: .7, aspect: 9 / 16, mirror: true }, { jitter: .008 }, { retreat: .25 }]) {
    const prediction = classifier.predict(capture('X', options));
    assert.equal(prediction.targetClass, 'X', JSON.stringify({ options, prediction }));
  }
});

test('rotation, approach, noisy scale and a stationary small hand cannot satisfy the X retreat gate', () => {
  const classifier = new MotionClassifier({ X: [capture('X')] });
  for (const clip of [capture('H'), capture('K'), capture('X', { retreat: -.3 })]) {
    assert.equal(inspectDepthRetreat(clip).eligible, false);
    assert.equal(classifier.predict(clip).targetClass, null);
  }
  // Add shrinking scale to a rotating H; contraction alone must not label it X.
  const rotation = capture('H');
  rotation.frames.forEach((frame, index) => { frame[65] = .35 * index / 31; });
  assert.ok(inspectDepthRetreat(rotation).warnings.includes('pose-variation'));
  assert.equal(classifier.predict(rotation).targetClass, null);
  for (const options of [{ retreat: 0, jitter: .015 }, { retreat: .04 }, { retreat: 0, scale: .65 }]) {
    const recognizer = new TemporalRecognizer({ X: [capture('X')] });
    for (const frame of frames('X', options)) assert.equal(recognizer.predict(frame.hand, frame.time, frame.handedness, frame.aspect).targetClass, null);
  }
  const jump = capture('X');
  jump.frames.forEach((frame, index) => { frame[65] = index < 16 ? 0 : .35; });
  assert.equal(inspectDepthRetreat(jump).reason, 'scale-jump');
  assert.equal(classifier.predict(jump).targetClass, null);
});

test('X capture rejects a non-retreat example and reuses the production depth segmenter', () => {
  for (const [label, expectedState] of [['X', 'complete'], ['H', 'depth-required'], ['K', 'depth-required']]) {
    const recorder = new MotionCapture('X', 0);
    let result;
    for (const frame of frames(label, { offset: 2000 })) {
      result = recorder.observe(frame.hand, frame.time, frame.aspect, frame.handedness);
      if (['complete', 'depth-required'].includes(result.state)) break;
    }
    assert.equal(result.state, expectedState);
    if (result.clip) assert.equal(inspectDepthRetreat(result.clip).eligible, true);
    if (label === 'H') assert.equal(result.depth.reason, 'palm-rotation');
    if (label === 'K') assert.equal(result.depth.reason, 'insufficient-retreat');
  }
});

test('personal X capture tolerates finger variation and modest wrist tilt, and remains usable for DTW', () => {
  const options = { tilt: 20, fingerDrift: .12 };
  const recorder = new MotionCapture('X', 0);
  let result;
  for (const frame of frames('X', { ...options, offset: 2000 })) {
    result = recorder.observe(frame.hand, frame.time, frame.aspect, frame.handedness);
    if (['complete', 'depth-required'].includes(result.state)) break;
  }
  assert.equal(result.state, 'complete', JSON.stringify(result));
  assert.equal(result.depth.eligible, true);
  assert.ok(result.depth.warnings.includes('pose-variation'));
  const classifier = new MotionClassifier({ ...samples(), X: [result.clip] });
  assert.equal(classifier.hasClass('X'), true);
  assert.equal(classifier.predict(capture('X', { ...options, speed: 1.3, step: 40, jitter: .005 })).targetClass, 'X');
});

test('one noisy pose or palm frame does not veto an otherwise valid X example', () => {
  const clip = capture('X');
  // This frame violates both former strict thresholds, but is an isolated outlier.
  clip.frames[12][8 * 3 + 1] += 1.5;
  clip.frames[12][17 * 3] += .5;
  const result = inspectDepthRetreat(clip);
  assert.equal(result.eligible, true);
  assert.ok(result.poseVariationFraction > 0 && result.poseVariationFraction < .2);
  assert.equal(new MotionClassifier({ X: [clip] }).hasClass('X'), true);
});

test('smaller deliberate retreat is retained and rejection reasons distinguish approach and insufficient scale', () => {
  const clip = capture('X', { retreat: .15 });
  assert.ok(validMotionClip(clip));
  assert.equal(inspectDepthRetreat(clip).eligible, true);
  assert.equal(new MotionClassifier({ X: [clip] }).predict(capture('X', { retreat: .15, speed: 1.25 })).targetClass, 'X');
  assert.equal(inspectDepthRetreat(capture('X', { retreat: -.3 })).reason, 'approach');
  assert.equal(inspectDepthRetreat(capture('K')).reason, 'insufficient-retreat');
  assert.ok(inspectDepthRetreat(clip).minShrinkPercent > 9 && inspectDepthRetreat(clip).minShrinkPercent < 10);
});

test('one raw scale discontinuity cannot become a gradual X through resampling', () => {
  for (const step of [25, 50, 100]) {
    const recognizer = new TemporalRecognizer({ X: [capture('X')] });
    let interrupted = false;
    for (let time = 0; time < 2200; time += step) {
      const scale = time < 750 ? 1 : .8;
      const hand = base.map(point => ({ x: .1 + point.x * scale, y: .1 + point.y * scale, z: point.z * scale }));
      const result = recognizer.predict(hand, time, 'Right');
      assert.equal(result.targetClass, null);
      interrupted ||= result.state === 'tracking-lost';
    }
    assert.equal(interrupted, true);
  }
});

test('X loses all evidence on missing tracking, a scale jump or renewed retreat after matching', () => {
  const input = frames('X');
  for (const interruption of ['missing', 'jump']) {
    const recognizer = new TemporalRecognizer(samples());
    input.slice(0, 19).forEach(frame => recognizer.predict(frame.hand, frame.time, 'Right'));
    assert.equal(recognizer.segmenter.state, 'recording');
    const frame = input[19];
    const hand = interruption === 'missing' ? null : frame.hand.map(point => ({ x: .1 + (point.x - .1) * .6, y: .1 + (point.y - .1) * .6, z: point.z * .6 }));
    assert.equal(recognizer.predict(hand, frame.time, 'Right').state, 'tracking-lost');
    assert.equal(recognizer.segmenter.frames.length, 0);
  }
  const recognizer = new TemporalRecognizer(samples());
  let prediction;
  input.forEach(frame => { prediction = recognizer.predict(frame.hand, frame.time, 'Right'); });
  assert.equal(prediction.targetClass, 'X');
  const terminal = input.at(-1);
  const continuedRetreat = terminal.hand.map(point => ({ x: .1 + (point.x - .1) * .8, y: .1 + (point.y - .1) * .8, z: point.z * .8 }));
  assert.equal(recognizer.predict(continuedRetreat, terminal.time + 50, 'Right').targetClass, null);
  assert.equal(recognizer.evidence, null);
});

test('legacy H/J/K/Z recordings and scores survive new captures and mixed-version export/import', () => {
  const toLegacy = clip => ({ ...clip, version: 1, frames: clip.frames.map(frame => frame.slice(0, 65)) });
  const previous = Object.fromEntries(['H', 'J', 'K', 'Z'].map(label => [label, [toLegacy(capture(label))]]));
  previous.X = [toLegacy(capture('BAD'))]; // Valid old XY-only X remains backed up.
  const classifier = new MotionClassifier(previous);
  assert.equal(classifier.hasClass('X'), false);
  for (const label of ['H', 'J', 'K', 'Z']) {
    assert.ok(validMotionClip(previous[label][0]));
    assert.equal(classifier.predict(capture(label)).targetClass, label);
  }
  const memory = new Map(), storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
  const store = new ProfileStore(storage);
  store.login('Ana'); store.login('Bia'); store.saveScore('Ana', 'alphabet', 9999);
  store.importMotion('Ana', { version: 1, examples: previous });
  store.saveMotion('Ana', 'X', capture('X'));
  const profile = store.read('Ana');
  assert.deepEqual(profile.motionExamples.H, previous.H);
  assert.equal(profile.motionExamples.X[0].version, 1);
  assert.equal(profile.motionExamples.X[1].version, 2);
  assert.equal(profile.bestTimes.alphabet, 9999);
  store.importMotion('Bia', JSON.parse(JSON.stringify({ version: 2, examples: profile.motionExamples })));
  assert.deepEqual(store.read('Bia').motionExamples, profile.motionExamples);
  const restored = new MotionClassifier(store.read('Bia').motionExamples);
  assert.equal(restored.examples.X.length, 1);
  assert.equal(restored.predict(capture('X')).targetClass, 'X');
  assert.throws(() => store.importMotion('Bia', { version: 1, examples: { X: [capture('X')] } }));
  assert.equal(validMotionClip({ ...previous.H[0], version: 2 }), false);
});

test('H wrist rotation and K upward motion remain distinct with an identical initial hand', () => {
  const h = capture('H'), k = capture('K');
  assert.deepEqual(frames('H')[0].hand, frames('K')[0].hand);
  assert.ok(h.frames.every(frame => frame[63] === 0 && frame[64] === 0));
  assert.ok(h.frames.at(-1).slice(0, 63).some((value, axis) => Math.abs(value - h.frames[0][axis]) > .1));
  assert.ok(k.frames.at(-1)[64] < -.3);
  assert.ok(motionDtw(h, k) > .2);
  const classifier = new MotionClassifier({ H: [h], K: [k] });
  assert.equal(classifier.predict(h).targetClass, 'H');
  assert.equal(classifier.predict(k).targetClass, 'K');
  const recognizer = new TemporalRecognizer({ H: [h], K: [k] });
  for (let time = 0; time < 2000; time += 50) assert.equal(recognizer.predict(frames('H')[0].hand, time, 'Right').targetClass, null);
  assert.equal(new MotionCapture('H', 0).label, 'H');
});

test('overlapping projected palm joints do not discard otherwise valid H tracking', () => {
  const hand = base.map(point => ({ ...point }));
  hand[17] = { x: hand[5].x, y: hand[5].y, z: hand[5].z + .04 };
  const segmenter = new MotionSegmenter();
  let result;
  for (let time = 0; time <= 300; time += 50) {
    result = segmenter.observe(hand, time, 'Right');
    assert.notEqual(result.state, 'tracking-lost');
  }
  assert.equal(result.state, 'ready');
});

test('a missing frame during H rotation discards the motion and never extrapolates a completion', () => {
  const recognizer = new TemporalRecognizer(samples()), input = frames('H');
  for (const frame of input.slice(0, 19)) recognizer.predict(frame.hand, frame.time, frame.handedness, frame.aspect);
  assert.equal(recognizer.segmenter.state, 'recording');
  const lost = recognizer.predict(null, input[19].time, 'Right');
  assert.equal(lost.state, 'tracking-lost');
  assert.equal(recognizer.segmenter.frames.length, 0);
  for (const frame of input.slice(20)) assert.equal(recognizer.predict(frame.hand, frame.time, frame.handedness, frame.aspect).targetClass, null);
  const terminal = input.at(-1);
  for (let time = terminal.time + 50; time <= terminal.time + 1500; time += 50) assert.equal(recognizer.predict(terminal.hand, time, 'Right').targetClass, null);
});

test('K is classified from upward trajectory and cannot pass as a stationary pose', () => {
  const classifier = new MotionClassifier(samples());
  assert.equal(classifier.predict(capture('K')).targetClass, 'K');
  assert.equal(classifier.predict(capture('BAD')).targetClass, null);
  const recognizer = new TemporalRecognizer(samples());
  for (let time = 0; time < 1800; time += 50) {
    const prediction = recognizer.predict(base, time, 'Right');
    assert.notEqual(prediction.targetClass, 'K');
  }
  assert.throws(() => new MotionCapture('A', 0));
  assert.equal(new MotionCapture('K', 0).label, 'K');
});

test('K exposes READY before movement and RECORDING at its first detected displacement', () => {
  const states = frames('K');
  const segmenter = new MotionSegmenter();
  const observed = states.map(f => segmenter.observe(f.hand, f.time, f.handedness, f.aspect).state);
  const ready = observed.indexOf('ready'), recording = observed.indexOf('recording');
  assert.ok(ready >= 0 && recording > ready);
  assert.ok(observed.includes('complete'));
  assert.ok(!observed.slice(0, ready).includes('recording'));
});

test('finger flexion and relative depth can encode motion with a stationary wrist', () => {
  const segmenter = new MotionSegmenter();
  let result;
  for (let time = 0; time <= 2000; time += 50) {
    const u = Math.max(0, Math.min(1, (time - 500) / 1000));
    const hand = base.map((point, index) => index >= 6 && index <= 8 ? { ...point, y: point.y + .25 * u, z: point.z - .15 * u } : { ...point });
    result = segmenter.observe(hand, time, 'Right');
    if (result.state === 'complete') break;
  }
  assert.equal(result.state, 'complete');
  assert.ok(result.clip.frames.every(frame => frame[63] === 0 && frame[64] === 0));
  assert.equal(inspectDepthRetreat(result.clip).eligible, false);
  assert.equal(new MotionClassifier({ X: [result.clip], Z: [capture('Z')] }).hasClass('X'), false, 'finger flexion alone is no longer a valid X template');
});

test('competing classes, unknown motions, reversed/incomplete paths and ambiguity reject', () => {
  const data = samples(), classifier = new MotionClassifier(data);
  assert.equal(classifier.predict(capture('BAD')).targetClass, null);
  const incomplete = structuredClone(data.Z[0]);
  incomplete.frames = incomplete.frames.map((_, i) => data.Z[0].frames[Math.floor(i / 2)]);
  assert.equal(classifier.predict(incomplete).targetClass, null);
  const reversed = structuredClone(data.Z[0]);
  reversed.frames.reverse();
  const origin = reversed.frames[0].slice(63);
  reversed.frames.forEach(frame => { frame[63] -= origin[0]; frame[64] -= origin[1]; });
  assert.equal(classifier.predict(reversed).targetClass, null);
  classifier.setExamples({ Z: data.Z, J: data.Z });
  assert.equal(classifier.predict(data.Z[0]).targetClass, null);
  classifier.setExamples({ ...data, UNKNOWN: [capture('BAD')] });
  assert.equal(classifier.predict(capture('BAD')).reason, 'negative');
  assert.equal(new MotionClassifier().predict(data.Z[0]).reason, 'no-examples');
});

test('null/nonfinite tracking, duplicate time, hand switch, aspect change and gap invalidate unfinished sequences', () => {
  for (const interruption of ['null', 'nan', 'time', 'hand', 'aspect', 'gap']) {
    const segmenter = new MotionSegmenter(), input = frames('Z');
    input.slice(0, 19).forEach(f => segmenter.observe(f.hand, f.time, f.handedness, f.aspect));
    assert.equal(segmenter.state, 'recording');
    const f = input[19];
    const hand = interruption === 'null' ? null : interruption === 'nan' ? base.map(p => ({ ...p, z: NaN })) : f.hand;
    const result = segmenter.observe(hand, interruption === 'time' ? input[18].time : interruption === 'gap' ? f.time + 200 : f.time, interruption === 'hand' ? 'Left' : 'Right', interruption === 'aspect' ? 2 : 1);
    assert.equal(result.state, 'tracking-lost');
    assert.equal(segmenter.frames.length, 0);
  }
});

test('guided recorder warms up, then uses the same segmenter; timeout never produces samples', () => {
  const recorder = new MotionCapture('Z', 0);
  assert.equal(recorder.observe(base, 1000, 1, 'Right').state, 'warmup');
  let result;
  for (const f of frames('Z', { offset: 2000 })) {
    result = recorder.observe(f.hand, f.time, f.aspect, f.handedness);
    if (result.state === 'complete') break;
  }
  assert.equal(result.state, 'complete');
  assert.equal(result.label, 'Z');
  assert.ok(validMotionClip(result.clip));
  assert.equal(new MotionCapture('J', 0).observe(base, 16000, 1, 'Right').state, 'timeout');
  assert.throws(() => new MotionCapture('A', 0));
});

for (const label of ['Z', 'X']) test(`${label} match must survive fresh final-pose frames for a full second; reset requires a new motion`, () => {
  const recognizer = new TemporalRecognizer(samples());
  let now = 0;
  const engine = new GameEngine({ clock: () => now, onAdvance: () => recognizer.reset() });
  engine.start([{ target: label }, { target: label }]);
  const input = frames(label);
  let terminal, firstMatch;
  for (const f of input) {
    now = f.time;
    const prediction = recognizer.predict(f.hand, now, f.handedness, f.aspect);
    if (prediction.targetClass) firstMatch ??= now;
    engine.observe(prediction, now); terminal = f;
  }
  assert.ok(Number.isFinite(firstMatch));
  assert.equal(engine.index, 0);
  for (now = terminal.time + 50; now < firstMatch + 1000; now += 50) engine.observe(recognizer.predict(terminal.hand, now, 'Right'), now);
  assert.equal(engine.index, 0);
  now = firstMatch + 1000;
  engine.observe(recognizer.predict(terminal.hand, now, 'Right'), now);
  assert.equal(engine.index, 1);
  for (now += 50; now < firstMatch + 4000; now += 50) engine.observe(recognizer.predict(terminal.hand, now, 'Right'), now);
  assert.equal(engine.index, 1);
});

test('lost tracking or terminal pose movement clears completed evidence, not just its score', () => {
  for (const lost of [true, false]) {
    const recognizer = new TemporalRecognizer(samples());
    const input = frames('Z');
    let prediction;
    input.forEach(f => { prediction = recognizer.predict(f.hand, f.time, 'Right'); });
    assert.equal(prediction.targetClass, 'Z');
    let now = input.at(-1).time + 50;
    assert.equal(recognizer.predict(lost ? null : base, now, 'Right').targetClass, null);
    for (let i = 0; i < 25; i++) {
      now += 50;
      assert.equal(recognizer.predict(input.at(-1).hand, now, 'Right').targetClass, null);
    }
  }
});

test('versioned motion storage is bounded, isolated, atomically validated and export-compatible', () => {
  const memory = new Map(), storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
  const store = new ProfileStore(storage), clip = capture('Z');
  store.login('Ana'); store.login('Bia'); store.saveScore('Ana', 'alphabet', 1200);
  for (let i = 0; i < 10; i++) store.saveMotion('Ana', 'Z', clip);
  assert.equal(store.read('Ana').motionExamples.Z.length, 8);
  assert.equal(store.read('Bia').motionExamples, undefined);
  store.importMotion('Bia', JSON.parse(JSON.stringify({ version: MOTION_VERSION, examples: store.read('Ana').motionExamples })));
  assert.equal(store.read('Bia').motionExamples.Z.length, 8);
  const before = memory.get(store.key('Ana'));
  for (const payload of [{ version: 3, examples: { Z: [clip] } }, { version: MOTION_VERSION, examples: { A: [clip] } }, { version: MOTION_VERSION, examples: { J: [clip], Z: [null] } }]) assert.throws(() => store.importMotion('Ana', payload));
  assert.equal(memory.get(store.key('Ana')), before);
  store.removeLastMotion('Ana', 'Z');
  assert.equal(store.read('Ana').motionExamples.Z.length, 7);
  assert.equal(store.read('Ana').bestTimes.alphabet, 1200);
  storage.setItem = () => { throw new Error('quota'); };
  assert.throws(() => store.saveMotion('Ana', 'J', clip), /quota/);
  assert.equal(store.read('Ana').motionExamples.J.length, 0);
});

test('invalid clip schemas never enter inference', () => {
  const clip = capture('Z');
  for (const invalid of [null, {}, { ...clip, durationMs: NaN }, { ...clip, durationMs: 5000 }, { ...clip, frames: [] }, { ...clip, frames: clip.frames.map(frame => frame.map(() => 0)) }, { ...clip, frames: clip.frames.map(frame => frame.map(() => Infinity)) }]) {
    assert.equal(validMotionClip(invalid), false);
    assert.equal(motionDtw(clip, invalid), Infinity);
    assert.equal(new MotionClassifier({ Z: [invalid] }).hasClass('Z'), false);
  }
});

test('vision routes sequences through DTW without relabeling them as the requested target', async context => {
  globalThis.document = { hidden: false };
  context.after(() => { delete globalThis.document; });
  const observations = [], captures = [];
  const vision = new VisionController({ videoWidth: 100, videoHeight: 100 }, {}, prediction => observations.push(prediction), () => {}, status => captures.push(status));
  vision.draw = () => {}; // Canvas rendering is unrelated to recognition.
  vision.setMotionExamples(samples());
  vision.setTarget('J'); // Feed a Z even though the game requests J.
  for (const f of frames('Z')) {
    vision.captureTarget = vision.target; vision.captureTime = f.time; vision.captureRevision = vision.revision;
    await vision.handleResults({ multiHandLandmarks: [f.hand], multiHandedness: [{ label: 'Left' }] }, vision.generation);
  }
  assert.equal(observations.at(-1).targetClass, 'Z');
  assert.equal(observations.at(-1).source, 'dtw');
  vision.calibration = new MotionCapture('Z', 2000);
  const previousCount = observations.length;
  for (const f of frames('Z', { offset: 4000 })) {
    vision.captureTime = f.time;
    await vision.handleResults({ multiHandLandmarks: [f.hand], multiHandedness: [{ label: 'Left' }] }, vision.generation);
    if (captures.at(-1)?.state === 'complete') break;
  }
  assert.equal(captures.at(-1).state, 'complete');
  assert.equal(observations.length, previousCount, 'recording never supplies a scoring frame');
  assert.equal(vision.calibration, null);
});

test('vision routes H and K through competing motion templates instead of static poses', async context => {
  globalThis.document = { hidden: false };
  context.after(() => { delete globalThis.document; });
  const observations = [];
  const vision = new VisionController({ videoWidth: 100, videoHeight: 100 }, {}, prediction => observations.push(prediction), () => {}, () => {});
  vision.draw = () => {};
  vision.setMotionExamples(samples());
  for (const [target, performed] of [['H', 'K'], ['K', 'H']]) {
    vision.setTarget(target);
    for (const frame of frames(performed)) {
      vision.captureTarget = target; vision.captureTime = frame.time; vision.captureRevision = vision.revision;
      await vision.handleResults({ multiHandLandmarks: [frame.hand], multiHandedness: [{ label: 'Left' }] }, vision.generation);
    }
    assert.equal(observations.at(-1).source, 'dtw');
    assert.equal(observations.at(-1).targetClass, performed);
  }
});
