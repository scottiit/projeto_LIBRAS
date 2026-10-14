import test from 'node:test';
import assert from 'node:assert/strict';
import {SignClassifier,inspectVOpening,featureDistance} from '../js/classifier.js';
import {ProfileStore} from '../js/storage.js';
import {TrainingManager} from '../js/training.js';

function pose(open=false) {
  const values=Array.from({length:63},(_,i)=>i<3?0:i%3===2?0:i%3===0?.1*(Math.floor(i/3)%4):-.4);
  for(const [base,x,tip]of [[5,-.08,open?-.21:-.08],[9,.08,open?.21:.08]])for(let j=0;j<4;j++) {
    values[(base+j)*3]=x+(tip-x)*j/3;values[(base+j)*3+1]=-.5-.9*j/3;
  }
  return values;
}
const u=pose(),v=pose(true);
function model(bank={U:[u],V:[v]}) {const c=new SignClassifier([]);c.setPersonalExamples(bank);return c;}
const rotate=(features,angle,mirror=1)=>features.map((value,i)=>i%3===0?features[i]*mirror*Math.cos(angle)-features[i+1]*Math.sin(angle):i%3===1?features[i-1]*mirror*Math.sin(angle)+value*Math.cos(angle):value);

test('V opening survives small rotation/reflection and rejects closed fingers',()=>{
  assert.equal(inspectVOpening(u).open,false);
  for(const mirror of [-1,1])for(const angle of [-.04,.04]) {
    const sample=rotate(v,angle,mirror);
    assert.equal(inspectVOpening(sample).open,true);
    const p=model().predictFeatures(sample);assert.equal(p.targetClass,'V');assert.ok(p.confidenceProbability>.85);
  }
  assert.equal(inspectVOpening(null),null);
});
test('closed U retains the previous crossing metric and distance-based score',()=>{
  const p=model().predictFeatures(u);
  assert.equal(p.targetClass,'U');assert.equal(p.metric,'finger-crossing');
  assert.equal(p.distance,0);
  const rival=p.alternatives.find(item=>item.label==='V');
  assert.equal(p.confidenceProbability,Math.min(1,.5+.5*Math.min(1,rival.distance/.12)));
});
test('V cannot accept closed geometry or override another close non-U class',()=>{
  assert.equal(model({V:[u]}).predictFeatures(u).targetClass,null);
  const p=model({U:[u],V:[v],B:[v]}).predictFeatures(v);
  assert.ok(p.confidenceProbability<=.5);
});
test('two independent V captures can seed training against U',()=>{
  const data=new Map(),store=new ProfileStore({getItem:k=>data.get(k)??null,setItem:(k,x)=>data.set(k,x)});store.login('Ana');
  const manager=new TrainingManager(store),c=model({U:[u]});
  assert.equal(manager.recordStatic('Ana','V',[v],c).state,'pending');
  const result=manager.recordStatic('Ana','V',[rotate(v,.04)],c);
  assert.equal(result.state,'saved');assert.equal(result.savedCount,2);assert.ok(result.confidence>.85);
});
test('malformed intermediate points do not supply V evidence; suspicious U references cannot resolve the pair',()=>{
  const damaged=[...v];damaged[19]=-3;
  assert.equal(inspectVOpening(damaged),null);
  assert.equal(model({U:[v],V:[v]}).predictFeatures(v).confidenceProbability,.5);
});
