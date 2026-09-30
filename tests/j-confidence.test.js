import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { confidenceThreshold, validExampleConfidence, confidenceBucket, retainExamples, summarizeExamples } from '../js/example-policy.js';
import { MotionClassifier } from '../js/dynamic.js';
import { TrainingManager } from '../js/training.js';
import { ProfileStore } from '../js/storage.js';
import { GameEngine } from '../js/engine.js';
import { readTraining, writeTraining } from '../scripts/training-csv.js';

// Synthetic vectors isolate admission/retention from the editable live dataset.
function clip(variation = 0) {
  const pose = Array.from({length:63}, (_, i) => i < 3 ? 0 :
    (i % 3 === 1 ? -.1 * Math.floor(i / 3) : i % 3 === 0 ? .05 * (i % 7) : 0) + variation);
  return { version:2, durationMs:1200, frames:Array.from({length:32}, (_, i) => [...pose, 0, -1.5 * i / 31, 0]) };
}
const record = (score, id = 1) => ({ ...clip(), confidenceProbability:score, capturedAt:id, comparisonSource:'reference' });
function fixture() {
  const data = new Map(), storage = { getItem:key=>data.get(key)??null, setItem:(key,value)=>data.set(key,value) };
  const store = new ProfileStore(storage); store.login('Ana');
  return { store, storage, manager:new TrainingManager(store, () => 1000) };
}

test('only J accepts scores above 75%, with exact rational bucket boundaries', () => {
  assert.equal(confidenceThreshold('J'), .75);
  for (const label of ['A','H','K','X','Z','UNKNOWN','0',undefined]) {
    assert.equal(confidenceThreshold(label),.85);
    assert.equal(validExampleConfidence(.8,label),false);
    assert.equal(confidenceBucket(.9,label),'85-90');
  }
  for (const value of [.75, 0, NaN, Infinity, 1.01, '0.8', null, undefined]) {
    assert.equal(validExampleConfidence(value,'J'),false);
    assert.equal(confidenceBucket(value,'J'),null);
  }
  for (const [value,expected] of [[.750001,'75-83⅓'],[5/6,'75-83⅓'],[5/6+1e-8,'83⅓-91⅔'],[11/12,'83⅓-91⅔'],[11/12+1e-8,'91⅔-100'],[1,'91⅔-100']]) {
    assert.equal(confidenceBucket(value,'J'),expected);
  }
});

test('J FIFO protects six of thirty slots and releases an old anchor when its band gets a third', () => {
  const previous = [.78,.8,.87,.9,...Array(26).fill(.98)].map((score,i)=>record(score,i+1));
  const retained = retainExamples(previous,record(.99,31),'J');
  assert.equal(retained.length,30);
  assert.deepEqual(retained.slice(0,5).map(r=>r.capturedAt),[1,2,3,4,6]);
  const summary = summarizeExamples(retained,'J');
  assert.deepEqual(Object.values(summary.buckets).map(b=>b.protected),[2,2,2]);
  const refreshed = retainExamples(previous,record(.79,31),'J');
  assert.equal(refreshed[0].capturedAt,2);
  assert.equal(summarizeExamples(refreshed,'J').buckets['75-83⅓'].count,2);
  const incomplete = summarizeExamples([record(.96),record(.98)],'J');
  assert.equal(incomplete.buckets['75-83⅓'].missing,2);
  assert.equal(incomplete.buckets['83⅓-91⅔'].missing,2);
  assert.deepEqual(previous.map(r=>r.capturedAt),Array.from({length:30},(_,i)=>i+1));
});

test('classifier admits J at about 81% without relaxing Z or accepting UNKNOWN', () => {
  const candidate = clip(.14);
  const j = new MotionClassifier({J:[clip()]}).predict(candidate);
  const z = new MotionClassifier({Z:[clip()]}).predict(candidate);
  assert.ok(j.confidenceProbability > .75 && j.confidenceProbability < .85);
  assert.equal(j.targetClass,'J');
  assert.equal(z.similarityScore,j.similarityScore);
  assert.equal(z.targetClass,null);
  assert.equal(new MotionClassifier({UNKNOWN:[clip()]}).predict(clip()).targetClass,null);
});

test('J at 80% requires the complete uninterrupted second; Z at 80% still fails', () => {
  let now = 0;
  const engine = new GameEngine({clock:()=>now});
  engine.start([{target:'J'},{target:'Z'}]);
  const observe = (time,label,score) => { now=time; return engine.observe({targetClass:label,confidenceProbability:score,timestamp:1},time); };
  for (let time=0;time<=500;time+=100) assert.equal(observe(time,'J',.8),false);
  observe(600,'J',.75); // the exclusive boundary resets the accumulated hold
  for (let time=700;time<1700;time+=100) assert.equal(observe(time,'J',.8),false);
  assert.equal(observe(1700,'J',.8),true);
  assert.equal(engine.current.target,'Z');
  for(let time=1800;time<=3000;time+=100) assert.equal(observe(time,'Z',.8),false);
  assert.equal(engine.index,1);
  for(let time=3100;time<4100;time+=100) assert.equal(observe(time,'Z',.9),false);
  assert.equal(observe(4100,'Z',.9),true);
});

test('two provisional J captures between 75% and 85% persist and survive export/import', () => {
  const {store,storage,manager} = fixture(), empty = new MotionClassifier({});
  assert.equal(manager.recordMotion('Ana','J',clip(),empty).state,'pending');
  const reopened = new ProfileStore(storage);
  const saved = new TrainingManager(reopened).recordMotion('Ana','J',clip(.14),empty);
  assert.equal(saved.state,'saved'); assert.equal(saved.savedCount,2);
  assert.ok(saved.confidence>.75 && saved.confidence<.85);
  const backup = store.exportTraining('Ana');
  assert.equal(backup.motionExamples.J.length,2);
  assert.equal(backup.legacyReferences.motionExamples.J.length,0);
  const other = fixture().store; other.importTraining('Ana',backup);
  assert.deepEqual(other.exportTraining('Ana').motionExamples.J,backup.motionExamples.J);
  store.saveMotion('Ana','J',record(.97,2000));
  assert.equal(store.read('Ana').motionExamples.J.length,3);
  assert.equal(store.read('Ana').motionExamples.J[0].confidenceProbability,saved.confidence);
});

test('storage rejects exact 75% J, low-score other classes and invalid imports atomically', () => {
  const {store,storage} = fixture();
  store.saveMotion('Ana','J',record(.8));
  const before = storage.getItem(store.key('Ana'));
  for (const [label,score] of [['J',.75],['K',.8],['Z',.85],['UNKNOWN',.8]]) {
    assert.throws(()=>store.saveMotion('Ana',label,record(score)));
    assert.equal(storage.getItem(store.key('Ana')),before);
  }
  const backup = store.exportTraining('Ana');
  backup.motionExamples.J[0].confidenceProbability=.75;
  assert.throws(()=>store.importTraining('Ana',backup));
  assert.equal(storage.getItem(store.key('Ana')),before);
  assert.throws(()=>store.importMotion('Ana',{version:2,examples:{K:[record(.8)]}}));
  store.importMotion('Ana',{version:2,examples:{J:[record(.79,2)]}});
  assert.equal(store.read('Ana').motionExamples.J.length,2);
});

test('CSV server round-trip retains J scores and diversity at the new threshold', async () => {
  const csvFile = pathToFileURL(join(tmpdir(),`libras-j-policy-${randomUUID()}.csv`));
  await writeFile(csvFile,`${Array.from({length:63},(_,i)=>i).join(',')},label\n`);
  try {
    const {store} = fixture();
    store.saveMotions('Ana','J',[.78,.8,.87,.9,...Array(26).fill(.98)].map((score,i)=>record(score,i+1)));
    store.saveMotion('Ana','J',record(.99,31));
    await writeTraining('Ana',store.exportTraining('Ana'),csvFile);
    const restored = await readTraining('Ana',csvFile);
    assert.equal(restored.motionExamples.J.length,30);
    assert.deepEqual(restored.motionExamples.J.map(r=>r.capturedAt),store.read('Ana').motionExamples.J.map(r=>r.capturedAt));
    assert.deepEqual(Object.values(summarizeExamples(restored.motionExamples.J,'J').buckets).map(b=>b.protected),[2,2,2]);
    const contents = await readFile(csvFile,'utf8');
    restored.motionExamples.J[0].confidenceProbability=.75;
    await assert.rejects(writeTraining('Ana',restored,csvFile));
    assert.equal(await readFile(csvFile,'utf8'),contents);
  } finally { await unlink(csvFile); }
});
