import test from 'node:test';
import assert from 'node:assert/strict';
import {SignClassifier,validIndexGeometry,CalibrationSession,coordinatesToHand} from '../js/classifier.js';
import {ProfileStore} from '../js/storage.js';
import {TrainingManager} from '../js/training.js';

// Synthetic coordinates test estimated geometry, not true optical occlusion.
const pose=()=>Array.from({length:63},(_,i)=>i<3?0:i%3===2?0:i%3===0?(Math.floor(i/3)%4)*.2:-Math.floor((Math.floor(i/3)-1)%4)*.3-.4);
const f=pose(),t=[...f];
for(const joint of [3,4]) {f[joint*3+2]=-.2;t[joint*3+2]=.2;}
function model(bank={F:[f],T:[t]}) {const c=new SignClassifier([]);c.setPersonalExamples(bank);return c;}
const broken=()=>{const x=[...t];for(let axis=0;axis<3;axis++)x[24+axis]=x[21+axis];return x;};

test('F/T relational metric distinguishes opposing estimated thumb depth',()=>{
  const c=model();
  for(const [label,features]of [['F',f],['T',t]]) {
    const p=c.predictFeatures(features);
    assert.equal(p.targetClass,label);assert.equal(p.metric,'thumb-index');
    assert.ok(p.confidenceProbability>.85);
  }
});
test('collapsed index remains unclassifiable even with an identical stored reference',()=>{
  assert.equal(validIndexGeometry(t),true);assert.equal(validIndexGeometry(broken()),false);
  const p=model({F:[f],T:[broken()]}).predictFeatures(broken());
  assert.equal(p.targetClass,null);assert.equal(p.confidenceProbability,0);assert.equal(p.reason,'unreliable-index');
  assert.equal(validIndexGeometry(null),false);
});
test('capture and first provisional training reject corrupt index geometry',()=>{
  const calibration=new CalibrationSession('T',0);
  const p=calibration.observe(coordinatesToHand(broken()),2100);
  assert.equal(p.reason,'unreliable-index');assert.equal(calibration.samples.length,0);
  const memory=new Map(),store=new ProfileStore({getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v)});
  store.login('Ana');const manager=new TrainingManager(store);
  assert.throws(()=>manager.recordStatic('Ana','T',[broken()],model({F:[f]})),/indicador/);
  assert.equal(store.read('Ana').pendingExamples?.T,undefined);
});
test('small 2D rotation survives and coincident F/T remain ambiguous',()=>{
  const angle=.04;
  const rotated=t.map((v,i)=>i%3===0?t[i]*Math.cos(angle)-t[i+1]*Math.sin(angle):i%3===1?t[i-1]*Math.sin(angle)+v*Math.cos(angle):v);
  assert.equal(model().predictFeatures(rotated).targetClass,'T');
  assert.ok(model().predictFeatures(rotated).confidenceProbability>.85);
  assert.equal(model({F:[f],T:[f]}).predictFeatures(f).confidenceProbability,.5);
  assert.equal(model({B:[f],C:[t]}).predictFeatures(f).metric,'whole-hand');
});
