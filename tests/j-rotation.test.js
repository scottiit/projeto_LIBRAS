import test from 'node:test';
import assert from 'node:assert/strict';
import { MotionSegmenter, MotionCapture, TemporalRecognizer, MotionClassifier, validMotionClip, motionDtw } from '../js/dynamic.js';
import { VisionController } from '../js/vision.js';
import { ProfileStore } from '../js/storage.js';
import { TrainingManager } from '../js/training.js';
import { GameEngine } from '../js/engine.js';

// Deterministic geometry independent of the editable production dataset.
// Synthetic rotations validate the implementation, not LIBRAS or webcam accuracy.
const initial = [
  [.5,.7,0], [.47,.65,-.01], [.44,.62,-.02], [.43,.58,-.03], [.44,.55,-.04],
  [.47,.56,0], [.46,.5,-.01], [.46,.56,-.03], [.47,.59,-.04],
  [.5,.55,0], [.5,.5,-.01], [.5,.57,-.03], [.5,.60,-.04],
  [.53,.57,0], [.54,.52,-.01], [.54,.59,-.03], [.53,.62,-.04],
  [.56,.60,0], [.58,.52,-.01], [.60,.46,-.01], [.62,.40,-.01],
].map(([x,y,z]) => ({x,y,z}));
function input({ duration = 2000, offset = 0, label = 'J', mirror = false, aspect = 1, tail = 600 } = {}) {
  const base = structuredClone(initial);
  if (label !== 'J') {
    base[18] = { x:.57, y:.55, z:-.01 }; base[19] = { x:.57, y:.61, z:-.03 }; base[20] = { x:.56, y:.64, z:-.04 };
    if (label !== 'X') for (const finger of [5,9]) for (let joint = 1; joint < 4; joint++) base[finger+joint] = { x:base[finger].x, y:base[finger].y-.055*joint, z:0 };
  }
  const frames = [];
  for (let time = 0; time <= 500+duration+tail; time += 50) {
    const u = Math.max(0,Math.min(1,(time-500)/duration));
    const pitch = label === 'J' ? -175*Math.PI/180*Math.min(1,u/.65) : 0;
    const yaw = label === 'J' ? Math.max(0,(u-.65)/.35)*Math.PI*.8 : label === 'H' ? u*Math.PI/2 : 0;
    const scale = label === 'X' ? 1-.3*u : 1;
    const tx = label === 'J' ? -.12*Math.max(0,(u-.65)/.35) : label === 'Z' ? (u<1/3 ? u*3*.18 : u<2/3 ? .18-(u-1/3)*3*.18 : (u-2/3)*3*.18) : 0;
    const ty = label === 'J' ? .16*u : label === 'K' ? -.22*u : label === 'Z' ? .18*Math.max(0,Math.min(1,(u-1/3)*3)) : 0;
    const hand = base.map(point => {
      const dx=point.x-.5, dy=point.y-.7, dz=point.z;
      const py=dy*Math.cos(pitch)-dz*Math.sin(pitch), pz=dy*Math.sin(pitch)+dz*Math.cos(pitch);
      const x=.5+(dx*Math.cos(yaw)+pz*Math.sin(yaw))*scale+tx;
      return { x:(mirror ? 1-x : x)/aspect, y:.7+py*scale+ty, z:(-dx*Math.sin(yaw)+pz*Math.cos(yaw))*scale/aspect };
    });
    frames.push({ hand,time:time+offset,handedness:mirror?'Left':'Right',aspect });
  }
  return frames;
}
function capture(options = {}, missing = () => false) {
  const segmenter = new MotionSegmenter();
  let status;
  for (const f of input(options)) {
    status=segmenter.observe(missing(f.time) ? null : f.hand, f.time, f.handedness,f.aspect);
    if (status.state==='complete') return status.clip;
  }
  assert.fail(`No clip: ${JSON.stringify(status)}`);
}
const templates = () => Object.fromEntries(['J','H','K','X','Z'].map(label=>[label,[capture({label})]]));

test('J uses exactly the same DTW metric as Z, including full-hand features', () => {
  const reference = capture(), candidate = structuredClone(reference);
  candidate.frames.forEach(frame => { frame[8 * 3] += .3; });
  const j = new MotionClassifier({ J: [reference] }).predict(candidate);
  const z = new MotionClassifier({ Z: [reference] }).predict(candidate);
  assert.equal(j.similarityScore, z.similarityScore);
  assert.deepEqual(j.alternatives.map(item => item.distance), z.alternatives.map(item => item.distance));
  assert.ok(j.alternatives[0].distance > 0);
  assert.equal(motionDtw(reference, reference, false), 0);
});

test('J pitch/yaw, H/K/Z trajectories and X retreat still classify with generic segmentation', () => {
  const classifier = new MotionClassifier(templates());
  for (const options of [{}, { duration: 2500 }, { mirror: true, aspect: 16 / 9 }, { label: 'H' }, { label: 'K' }, { label: 'Z' }, { label: 'X' }]) {
    const result = classifier.predict(capture(options));
    assert.equal(result.targetClass, options.label ?? 'J', JSON.stringify(result));
  }
});

test('short tracking gaps use one bounded policy for J and Z, with no required finger pose', () => {
  for (const label of ['J', 'Z']) {
    const clip = capture({ label }, time => time === 950 || time === 1000);
    assert.equal(clip.occlusions[0].endMs - clip.occlusions[0].startMs, 150);
    const segmenter = new MotionSegmenter();
    for (const f of input({ label }).filter(f => f.time <= 900)) segmenter.observe(f.hand, f.time, f.handedness);
    assert.equal(segmenter.observe(null, 950, null).state, 'occluded');
    assert.equal(segmenter.observe(null, 1100, null).reason, 'gap-too-long');
    assert.equal(segmenter.frames.length, 0);
  }
});

test('capture does not apply X scale-jump veto to J/Z; X retains its own retreat gate', () => {
  for (const label of ['J', 'Z']) {
    const segmenter = new MotionSegmenter();
    const frames = input({ label }).filter(f => f.time <= 900);
    for (const f of frames) segmenter.observe(f.hand, f.time, f.handedness);
    const last = frames.at(-1).hand;
    const scaled = last.map(p => ({ x:last[0].x+(p.x-last[0].x)*.7, y:last[0].y+(p.y-last[0].y)*.7, z:last[0].z+(p.z-last[0].z)*.7 }));
    assert.equal(segmenter.observe(scaled, 950, 'Right').state, 'recording');
  }
  const jumped = capture({ label:'X' });
  jumped.frames.forEach((frame, index) => { frame[65] = index < 16 ? 0 : .35; });
  assert.equal(new MotionClassifier({ X:[capture({label:'X'})] }).predict(jumped).reason, 'depth-required');
  const recorder = new MotionCapture('X', 0);
  let result;
  for (const f of input({ label:'J', offset:2000 })) {
    result = recorder.observe(f.hand, f.time, f.aspect, f.handedness);
    if (result.state === 'depth-required') break;
  }
  assert.equal(result.state, 'depth-required');
});

test('capture and live recognition use generic segmentation without injecting the game target', async context => {
  const recorder = new MotionCapture('J', 0);
  let recorded;
  for (const f of input({offset:2000})) {
    recorded = recorder.observe(f.hand, f.time, f.aspect, f.handedness);
    if (recorded.state === 'complete') break;
  }
  assert.equal(recorded.state, 'complete');
  globalThis.document = { hidden:false };
  context.after(() => { delete globalThis.document; });
  const observed = [];
  const vision = new VisionController({videoWidth:100,videoHeight:100}, {}, prediction => observed.push(prediction), () => {});
  vision.draw = () => {}; vision.setMotionExamples(templates()); vision.setTarget('Z');
  for (const f of input()) {
    Object.assign(vision, { captureTime:f.time, captureTarget:vision.target, captureRevision:vision.revision });
    await vision.handleResults({multiHandLandmarks:[f.hand],multiHandedness:[{label:'Left'}]}, vision.generation);
  }
  assert.equal(observed.at(-1).targetClass, 'J');
});

function trainingFixture() {
  const data = new Map();
  const storage = {getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};
  const store = new ProfileStore(storage);
  store.login('Ana');
  return { storage, store, manager:new TrainingManager(store, () => 123456) };
}

test('two independent J executions seed the bank after provisional persistence and reload', () => {
  const {storage,store,manager} = trainingFixture();
  const classifier = new MotionClassifier({});
  assert.equal(manager.recordMotion('Ana', 'J', capture(), classifier).state, 'pending');
  const result = new TrainingManager(new ProfileStore(storage)).recordMotion('Ana', 'J', capture({duration:2500}), classifier);
  assert.equal(result.state, 'saved'); assert.equal(result.savedCount, 2);
  assert.ok(result.confidence > .85);
  assert.equal(store.read('Ana').motionExamples.J.length, 2);
});

test('rejected provisional J reports its nonzero comparison score instead of zeroed game evidence', () => {
  const {store,manager} = trainingFixture();
  const reference = capture(), candidate = structuredClone(reference);
  candidate.frames.forEach(frame => { for (let i=3; i<63; i++) frame[i] += .3; });
  const prediction = new MotionClassifier({J:[reference]}).predict(candidate);
  assert.equal(prediction.confidenceProbability, 0);
  assert.ok(prediction.similarityScore > 0 && prediction.similarityScore < .85);
  const empty = new MotionClassifier({});
  manager.recordMotion('Ana','J',reference,empty);
  const rejected = manager.recordMotion('Ana','J',candidate,empty);
  assert.equal(rejected.state,'rejected');
  assert.ok(Math.abs(rejected.confidence-prediction.similarityScore)<1e-6);
  assert.equal(store.read('Ana').motionExamples?.J?.length ?? 0,0);
  assert.ok(store.read('Ana').pendingExamples.J);
});

test('ambiguous identical J/Z examples cannot pass admission despite nonzero score', () => {
  const {store,manager} = trainingFixture();
  const clip = capture(), classifier = new MotionClassifier({J:[clip],Z:[clip]});
  const result = manager.recordMotion('Ana','J',clip,classifier);
  assert.equal(result.state,'rejected');
  assert.equal(result.confidence,.5);
  assert.equal(store.read('Ana').motionExamples?.J?.length ?? 0,0);
});

test('missing references and malformed arrays are unavailable comparisons, never fake zero similarity', () => {
  const {manager} = trainingFixture();
  const clip = capture();
  const assessed = manager.evaluate({kind:'motion',clip},'J',new MotionClassifier({}))[0];
  assert.equal(assessed.confidence,undefined);
  assert.equal(assessed.accepted,false);
  for (const mutate of [c=>delete c.frames[3], c=>delete c.frames[2][5], c=>c.frames[2].pop(), c=>c.frames[2][5]=NaN]) {
    const broken = structuredClone(clip); mutate(broken);
    assert.equal(validMotionClip(broken),false);
    const result = new MotionClassifier({J:[clip]}).predict(broken);
    assert.equal(result.reason,'invalid');
    assert.equal(result.similarityScore,undefined);
    assert.equal(motionDtw(clip,broken),Infinity);
  }
  const legacy = {...clip,version:1,frames:clip.frames.map(frame=>frame.slice(0,65))};
  assert.equal(motionDtw(clip,legacy,false),0);
});

test('a missing final confirmation frame revokes evidence and cannot advance the game', () => {
  const recognizer = new TemporalRecognizer(templates()), engine = new GameEngine();
  engine.start([{target:'J'}]);
  const frames = input();
  for (const f of frames) engine.observe(recognizer.predict(f.hand,f.time,'Right'),f.time);
  assert.ok(recognizer.evidence);
  const time = frames.at(-1).time+50;
  const lost = recognizer.predict(null,time,null);
  assert.equal(lost.state,'tracking-lost'); assert.equal(recognizer.evidence,null);
  engine.observe(lost,time);
  for(let t=time+50;t<time+1500;t+=50) engine.observe(recognizer.predict(frames.at(-1).hand,t,'Right'),t);
  assert.equal(engine.index,0);
});
