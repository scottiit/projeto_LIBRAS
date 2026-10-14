import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile,readFile,unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { GLOBAL_TRAINING_PROFILE, trainingThreshold, summarizeExamples } from '../js/example-policy.js';
import { ProfileStore } from '../js/storage.js';
import { TrainingManager } from '../js/training.js';
import { MotionClassifier } from '../js/dynamic.js';
import { SignClassifier } from '../js/classifier.js';
import { SplitProfileStorage,CsvTrainingRepository } from '../js/csv-training.js';
import { readTraining,writeTraining } from '../scripts/training-csv.js';

const vector = Array(63).fill(0);
const motion = (variation=0) => ({version:2,durationMs:1000,frames:Array.from({length:32},(_,i)=>[...vector.map((x,j)=>j<3?0:x+variation),0,-i/31,0])});
const staticRecord = (id,score=.95,threshold) => ({features:vector,confidenceProbability:score,capturedAt:id,comparisonSource:'reference',...(threshold===undefined?{}:{admissionThreshold:threshold})});
function memory() { const data=new Map(); return {get length(){return data.size;},key:i=>[...data.keys()][i],getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)}; }
function fixture() { const storage=memory(),store=new ProfileStore(storage); store.login('Ana'); return {storage,store,manager:new TrainingManager(store)}; }
const csvFixture = async context => {
  const file=new URL(`../.test-global-${randomUUID()}.csv`,import.meta.url);
  await writeFile(file,`${Array.from({length:63},(_,i)=>i).join(',')},label\n${vector.join(',')},A\n`);
  context.after(()=>unlink(file)); return file;
};

test('custom training limits admit new static/motion examples without lowering game classifiers', () => {
  const {store,manager}=fixture();
  store.setTrainingThreshold('Ana','A',.7);
  const classifier=new SignClassifier([]); classifier.setPersonalExamples({A:[vector]});
  const features=vector.map((value,i)=>i<3?0:.22);
  const score=classifier.predictFeatures(features).confidenceProbability;
  assert.ok(score>.7&&score<.85);
  assert.equal(manager.recordStatic('Ana','A',[features],classifier).state,'saved');
  store.setTrainingThreshold('Ana','K',.7);
  const temporal=new MotionClassifier({K:[motion()]});
  assert.equal(temporal.predict(motion(.14)).targetClass,null);
  assert.equal(manager.recordMotion('Ana','K',motion(.14),temporal).state,'saved');
  store.setTrainingThreshold('Ana','K',.99);
  assert.equal(store.exportTraining('Ana').motionExamples.K.length,1);
  assert.equal(store.exportTraining('Ana').signExamples.A[0].admissionThreshold,.7);
  assert.equal(trainingThreshold(store.read('Ana'),'A'),.7);
  assert.equal(trainingThreshold(store.read('Ana'),'J'),.75);
});

test('thresholds require valid integer percentages; invalid settings/imports never write', () => {
  const {store,storage}=fixture(),before=storage.getItem(store.key('Ana'));
  for(const value of [.49,1,.705,NaN,'0.7']) assert.throws(()=>store.setTrainingThreshold('Ana','A',value));
  assert.throws(()=>store.setTrainingThreshold('Ana','invalid',.7));
  const backup=store.exportTraining('Ana'); backup.trainingThresholds={A:.4};
  assert.throws(()=>store.importTraining('Ana',backup));
  assert.equal(storage.getItem(store.key('Ana')),before);
});

test('manual FIFO/LIFO deletes exactly five, can remove anchors, and preserves other classes/pending', () => {
  for(const direction of ['oldest','newest']) {
    const {store}=fixture(); store.saveExamples('Ana','A',Array.from({length:8},(_,i)=>staticRecord(i+1)));
    store.saveExamples('Ana','B',[staticRecord(20)]);
    store.stageExample('Ana','J',{kind:'motion',clip:motion()});
    const {profile,removedCount}=store.deleteTrainingBatch('Ana','A',direction);
    assert.equal(removedCount,5);
    assert.deepEqual(profile.signExamples.A.map(r=>r.capturedAt),direction==='oldest'?[6,7,8]:[1,2,3]);
    assert.equal(profile.signExamples.B.length,1); assert.ok(profile.pendingExamples.J);
    assert.equal(store.deleteTrainingBatch('Ana','A',direction).removedCount,3);
    assert.equal(store.deleteTrainingBatch('Ana','A',direction).removedCount,0);
  }
});

test('CSV stores custom thresholds and historical admission rules for static and motion records', async context => {
  const file=await csvFixture(context),{store,manager}=fixture();
  store.setTrainingThreshold('Ana','A',.7);
  const classifier=new SignClassifier([]); classifier.setPersonalExamples({A:[vector]});
  manager.recordStatic('Ana','A',[vector.map((v,i)=>i<3?0:.22)],classifier);
  store.setTrainingThreshold('Ana','K',.7);
  manager.recordMotion('Ana','K',motion(.14),new MotionClassifier({K:[motion()]}));
  store.setTrainingThreshold('Ana','A',.99); // existing lower-score examples survive
  const backup=store.exportTraining('Ana');
  await writeTraining(GLOBAL_TRAINING_PROFILE,backup,file);
  const restored=await readTraining(GLOBAL_TRAINING_PROFILE,file);
  assert.deepEqual(restored.trainingThresholds,{A:.99,K:.7});
  assert.equal(restored.signExamples.A[0].admissionThreshold,.7);
  assert.equal(restored.motionExamples.K[0].admissionThreshold,.7);
  assert.equal(restored.signExamples.A.length,1);
  assert.ok((await readFile(file,'utf8')).includes(',global-state,'));
});

test('global seeding preserves original profile rows and deletion of the last examples stays deleted', async context => {
  const file=await csvFixture(context),{store}=fixture();
  store.saveExamples('Ana','A',[staticRecord(1),staticRecord(2)]);
  await writeTraining('Ana',store.exportTraining('Ana'),file);
  const old=await readTraining('Ana',file);
  const initial=await readTraining(GLOBAL_TRAINING_PROFILE,file);
  assert.equal(initial.signExamples.A.length,2);
  await writeTraining(GLOBAL_TRAINING_PROFILE,initial,file);
  initial.signExamples.A=[]; initial.exampleOrder.signExamples.A=[];
  await writeTraining(GLOBAL_TRAINING_PROFILE,initial,file);
  assert.equal((await readTraining(GLOBAL_TRAINING_PROFILE,file)).signExamples.A?.length??0,0);
  assert.deepEqual(await readTraining('Ana',file),old);
  assert.ok((await readFile(file,'utf8')).includes(`${vector.join(',')},A,,,,,,`));
});

test('global repository shares banks/settings between players and restores failed deletions', async context => {
  const browser=memory(),split=new SplitProfileStorage(browser),store=new ProfileStore(split);
  store.login('Ana'); store.login('Bia'); store.saveScore('Bia','alphabet',1000);
  const repository=new CsvTrainingRepository(store,split,browser,{global:true});
  const temp=fixture().store; temp.saveExamples('Ana','A',[staticRecord(1)]);
  let disk={...temp.exportTraining('Ana'),trainingScope:GLOBAL_TRAINING_PROFILE},fail=false;
  const previous=globalThis.fetch; context.after(()=>{globalThis.fetch=previous;});
  globalThis.fetch=async (url,options)=>{
    if(options?.method==='PUT') {
      const payload=JSON.parse(options.body); assert.equal(payload.profile,GLOBAL_TRAINING_PROFILE);
      if(fail) return {ok:false,status:500,json:async()=>({error:'Falha de gravação'})};
      disk={...payload.training,trainingScope:GLOBAL_TRAINING_PROFILE};
    } else assert.ok(url.includes(encodeURIComponent(GLOBAL_TRAINING_PROFILE)));
    return {ok:true,json:async()=>disk};
  };
  await repository.load('Ana'); await repository.load('Bia');
  store.setTrainingThreshold('Ana','A',.7); await repository.persist('Ana');
  assert.equal(trainingThreshold(store.read('Bia'),'A'),.7);
  assert.equal(store.read('Bia').bestTimes.alphabet,1000);
  const metadata=JSON.parse(browser.getItem(store.key('Ana')));
  assert.equal(metadata.signExamples,undefined); assert.equal(metadata.trainingThresholds,undefined);
  fail=true; store.deleteTrainingBatch('Bia','A','oldest');
  await assert.rejects(repository.persist('Bia'));
  assert.equal(store.read('Ana').signExamples.A.length,1);
  assert.equal(store.read('Bia').signExamples.A.length,1);
});

test('old server empty responses never replace a loaded bank or display a false zero count', async context => {
  const browser=memory(),split=new SplitProfileStorage(browser),store=new ProfileStore(split);
  store.login('Ana'); store.saveExamples('Ana','A',[staticRecord(1)]);
  const repository=new CsvTrainingRepository(store,split,browser,{global:true});
  const before=store.read('Ana').signExamples.A;
  const previous=globalThis.fetch; context.after(()=>{globalThis.fetch=previous;});
  globalThis.fetch=async()=>({ok:true,json:async()=>({version:1,kind:'libras-training',signExamples:{},motionExamples:{}})});
  await assert.rejects(repository.load('Ana'),/servidor está desatualizado/);
  assert.deepEqual(store.read('Ana').signExamples.A,before);
});

test('custom retention keeps six anchors across proportional score bands', () => {
  const {store}=fixture(); store.setTrainingThreshold('Ana','A',.7);
  store.saveExamples('Ana','A',[.73,.75,.83,.88,...Array(26).fill(.98)].map((score,i)=>staticRecord(i+1,score,.7)));
  store.saveExamples('Ana','A',[staticRecord(31,.99,.7)]);
  const records=store.read('Ana').signExamples.A;
  assert.deepEqual(records.slice(0,5).map(r=>r.capturedAt),[1,2,3,4,6]);
  assert.deepEqual(Object.values(summarizeExamples(records,'A',.7).buckets).map(b=>b.protected),[2,2,2]);
});
