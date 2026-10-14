import test from 'node:test';
import assert from 'node:assert/strict';
import {SignClassifier,inspectFingerCrossing,featureDistance} from '../js/classifier.js';
import {TrainingManager} from '../js/training.js';
import {ProfileStore} from '../js/storage.js';

function pose(crossed=false) {
  const values=Array.from({length:63},(_,i)=>i<3?0:i%3===2?0:i%3===0?.1*(Math.floor(i/3)%4):-.4);
  for(const [base,x,tip]of [[5,-.08,crossed?.06:-.08],[9,.08,crossed?-.06:.08]]) {
    for(let j=0;j<4;j++) { values[(base+j)*3]=x+(tip-x)*j/3; values[(base+j)*3+1]=-.5-.9*j/3; }
  }
  return values;
}
const u=pose(),r=pose(true);
const model=(bank={U:[u],R:[r]})=>{const c=new SignClassifier([]);c.setPersonalExamples(bank);return c;};
const transform=(features,angle,mirror=1)=>features.map((value,i)=>i%3===0?features[i]*mirror*Math.cos(angle)-features[i+1]*Math.sin(angle):i%3===1?features[i-1]*mirror*Math.sin(angle)+value*Math.cos(angle):value);

test('crossing evidence distinguishes reversed tip order from parallel fingers',()=>{
  assert.equal(inspectFingerCrossing(u),'parallel');assert.equal(inspectFingerCrossing(r),'crossed');
  for(const angle of [-.4,.3])for(const mirror of [-1,1]) {
    assert.equal(inspectFingerCrossing(transform(u,angle,mirror)),'parallel');
    assert.equal(inspectFingerCrossing(transform(r,angle,mirror)),'crossed');
  }
});
test('similar U/R now pass the score gate with crossing evidence',()=>{
  assert.ok(.5+.5*featureDistance(u,r)/.12<.8);
  for(const [label,features]of [['U',u],['R',r]]) {
    const p=model().predictFeatures(transform(features,.04));
    assert.equal(p.targetClass,label);assert.equal(p.metric,'finger-crossing');assert.ok(p.confidenceProbability>.85);
  }
});
test('tip overlap, degenerate bases and reassociated intermediate points remain uncertain',()=>{
  const overlap=[...u];overlap[24]=0;overlap[36]=0;
  assert.equal(inspectFingerCrossing(overlap),'uncertain');
  assert.equal(model({U:[overlap],R:[r]}).predictFeatures(overlap).targetClass,null);
  const damaged=[...r];damaged[19]=-3;
  assert.equal(inspectFingerCrossing(damaged),'uncertain');
  const flat=[...u];flat[27]=flat[15];flat[28]=flat[16];
  assert.equal(inspectFingerCrossing(flat),'uncertain');assert.equal(inspectFingerCrossing(null),'uncertain');
});
test('second independent U execution seeds training against similar R reference',()=>{
  const data=new Map(),store=new ProfileStore({getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)});store.login('Ana');
  const manager=new TrainingManager(store),c=model({R:[r]});
  assert.equal(manager.recordStatic('Ana','U',[u],c).state,'pending');
  const saved=manager.recordStatic('Ana','U',[transform(u,.04)],c);
  assert.equal(saved.state,'saved');assert.equal(saved.savedCount,2);assert.ok(saved.confidence>.85);
});
test('other classes retain their metric and wrong crossing cannot approve U',()=>{
  assert.equal(model({B:[u],C:[r]}).predictFeatures(u).metric,'whole-hand');
  const p=model({U:[r],R:[r]}).predictFeatures(r);
  assert.equal(p.targetClass,'R');
  assert.equal(model({U:[r]}).predictFeatures(r).targetClass,null);
});
