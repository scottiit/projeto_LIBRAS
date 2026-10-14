import test from 'node:test';
import assert from 'node:assert/strict';
import { SignClassifier, featureDistance } from '../js/classifier.js';
import { ProfileStore } from '../js/storage.js';
import { TrainingManager } from '../js/training.js';

// Controlled vectors isolate thumb discrimination from editable CSV records.
// They are not linguistic templates or estimates of real-world accuracy.
const a = Array.from({length:63},(_,i)=>i<3?0:i%3===2?0:i%3===0?.1*(Math.floor(i/3)%5):-.5);
const s = [...a];
for(const joint of [2,3,4]) s[joint*3]+=.25;
function classifier(bank={A:[a],S:[s]}) {
  const result=new SignClassifier([]);result.setPersonalExamples(bank);return result;
}
function rotate(features,angle,mirror=1) {
  return features.map((value,i)=>i%3===0?features[i]*mirror*Math.cos(angle)-features[i+1]*Math.sin(angle):i%3===1?features[i-1]*mirror*Math.sin(angle)+value*Math.cos(angle):value);
}
test('thumb emphasis separates otherwise identical A/S above the admission gate',()=>{
  assert.ok(.5+.5*featureDistance(a,s)/.12<.85,'previous margin rejects the pair');
  const model=classifier();
  for(const [label,features] of [['A',a],['S',s]]) {
    const prediction=model.predictFeatures(features);
    assert.equal(prediction.targetClass,label);
    assert.equal(prediction.metric,'thumb-focused');
    assert.ok(prediction.confidenceProbability>.85);
  }
});
test('small rotations, reflection and modest non-thumb noise preserve A/S discrimination',()=>{
  const model=classifier();
  for(const [label,features] of [['A',a],['S',s]]) for(const mirror of [1,-1]) for(const angle of [-.05,.05]) {
    const sample=rotate(features,angle,mirror).map((value,i)=>i>=18?value+Math.sin(i)*.008:value);
    const prediction=model.predictFeatures(sample);
    assert.equal(prediction.targetClass,label);
    assert.ok(prediction.confidenceProbability>.85,`${label}: ${prediction.confidenceProbability}`);
  }
});
test('indistinguishable thumbs remain ambiguous and other static classes keep their metric',()=>{
  assert.equal(classifier({A:[a],S:[a]}).predictFeatures(a).confidenceProbability,.5);
  const model=classifier({B:[a],C:[s]});
  assert.equal(model.predictFeatures(a).metric,'whole-hand');
  assert.equal(classifier({'0':[a],'1':[s]}).predictFeatures(a,'numbers').metric,'whole-hand');
  assert.equal(classifier().predictFeatures(null).targetClass,null);
});
test('second independent S capture can seed training despite similar A references',()=>{
  const memory=new Map();
  const store=new ProfileStore({getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,value)});
  store.login('Ana');
  const manager=new TrainingManager(store,()=>1000),model=classifier({A:[a]});
  assert.equal(manager.recordStatic('Ana','S',Array(5).fill(s),model).state,'pending');
  const second=rotate(s,.04);
  const admission=manager.recordStatic('Ana','S',Array(5).fill(second),model);
  assert.equal(admission.state,'saved');
  assert.equal(admission.savedCount,2);
  assert.ok(admission.confidence>.85);
});
