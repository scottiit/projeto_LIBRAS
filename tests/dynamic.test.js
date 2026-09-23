import test from 'node:test';
import assert from 'node:assert/strict';
import { MotionSegmenter, MotionClassifier, MotionCapture, TemporalRecognizer, motionDtw, validMotionClip, MOTION_VERSION } from '../js/dynamic.js';
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
  X: [[0, 0], [-.08, 0], [-.16, 0], [-.2, -.04]],
  BAD: [[0, 0], [0, -.1], [.18, -.18], [.2, -.2]],
};
function frames(label, { speed = 1, step = 50, scale = 1, mirror = false, aspect = 1, offset = 0, warp = false } = {}) {
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
    const angle = label === 'H' ? u * Math.PI / 2 : 0;
    const hand = base.map(point => {
      const dx = point.x - base[0].x, dz = point.z - base[0].z;
      const rotatedX = base[0].x + dx * Math.cos(angle) + dz * Math.sin(angle);
      const rotatedZ = base[0].z - dx * Math.sin(angle) + dz * Math.cos(angle);
      return { x: (.1 + scale * (rotatedX + x)) * (mirror ? -1 : 1) / aspect, y: .1 + scale * (point.y + y), z: rotatedZ * scale / aspect };
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
  assert.equal(clip.frames[0].length, 65);
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
  assert.equal(new MotionClassifier({ X: [result.clip], Z: [capture('Z')] }).predict(result.clip).targetClass, 'X');
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

test('dynamic match must survive fresh final-pose frames for a full second; reset requires a new motion', () => {
  const recognizer = new TemporalRecognizer(samples());
  let now = 0;
  const engine = new GameEngine({ clock: () => now, onAdvance: () => recognizer.reset() });
  engine.start([{ target: 'Z' }, { target: 'Z' }]);
  const input = frames('Z');
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
  for (const payload of [{ version: 2, examples: { Z: [clip] } }, { version: 1, examples: { A: [clip] } }, { version: 1, examples: { J: [clip], Z: [null] } }]) assert.throws(() => store.importMotion('Ana', payload));
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
