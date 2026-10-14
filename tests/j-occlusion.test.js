import test from 'node:test';
import assert from 'node:assert/strict';
import { JMotionState, hasIPose, inspectJPinky } from '../js/j-motion.js';
import { normalizeHand } from '../js/classifier.js';
import { MotionSegmenter, TemporalRecognizer, validMotionClip } from '../js/dynamic.js';

// Synthetic geometry independent of the editable CSV. Does not establish
// linguistic validity or camera accuracy; checks temporal safety and isolation.
function hand(x = 0, y = 0) {
  const points = Array.from({ length: 21 }, () => ({ x: .5, y: .58, z: 0 }));
  points[0] = { x: .5, y: .65, z: 0 };
  for (const [index, px] of [[5,.44],[9,.48],[13,.52],[17,.56]]) {
    points[index] = { x: px, y: .53, z: 0 };
    points[index+1] = { x: px, y: .48, z: 0 };
    points[index+2] = { x: px, y: .52, z: -.02 };
    points[index+3] = { x: px, y: .59, z: -.02 };
  }
  points[18] = { x: .57, y: .46, z: 0 };
  points[19] = { x: .58, y: .40, z: 0 };
  points[20] = { x: .59, y: .34, z: 0 };
  return points.map(p => ({ ...p, x:p.x+x, y:p.y+y }));
}
function sequence(gap = true, hook = true) {
  return Array.from({length:45}, (_,i) => {
    const time = i*50;
    const down = Math.max(0, Math.min(1,(time-350)/400));
    const turn = hook ? Math.max(0,Math.min(1,(time-1100)/550)) : 0;
    return {time, hand:gap && time>=800 && time<1100 ? null : hand(.09*turn,.16*down-.08*turn)};
  });
}
function run(label, frames, handedness = 'Right') {
  const segmenter = new MotionSegmenter(label), statuses=[];
  for (const f of frames) {
    const status = segmenter.observe(f.hand,f.time,handedness,1);
    statuses.push(status);
    if (status.state==='complete') break;
  }
  return {segmenter,statuses,complete:statuses.find(s=>s.state==='complete')};
}
test('I geometry survives rigid pitch/yaw; null inputs are rejected', () => {
  const original=hand();
  assert.equal(hasIPose(original,1),true);
  for (const angle of [Math.PI/2,Math.PI]) {
    const rotated=original.map(p=>({x:p.x,y:.65+(p.y-.65)*Math.cos(angle)-p.z*Math.sin(angle),z:(p.y-.65)*Math.sin(angle)+p.z*Math.cos(angle)}));
    assert.equal(hasIPose(rotated,1),true);
  }
  assert.equal(hasIPose(null,1),false);
});
test('keyframes require observed descent then left/up hook; a gap cannot finish them', () => {
  const f=(time,x,y)=>({time,pinky:[x,y],palm:1,jPose:true});
  const state=new JMotionState(f(0,0,0));
  state.observe(f(100,-.3,-.2)); assert.equal(state.phase,'initial');
  state.observe(f(200,0,.5)); assert.equal(state.phase,'descending');
  state.interrupt(); assert.equal(state.phase,'descending');
  state.observe(f(600,-.3,.2)); assert.equal(state.phase,'hook');
  state.interrupt(); state.observe(f(800,-.3,.2)); assert.equal(state.phase,'hook');
  state.observe(f(900,-.3,.2)); assert.equal(state.phase,'complete');
});
test('J bridges 350 ms with explicit gap metadata; H/K/X/Z retain 180 ms', () => {
  const result=run('J',sequence());
  assert.ok(result.complete,JSON.stringify(result.statuses));
  assert.equal(result.complete.jPhase,'complete');
  assert.equal(result.complete.extendedGap,true);
  assert.ok(validMotionClip(result.complete.clip));
  assert.deepEqual(result.complete.clip.occlusions.map(g=>g.endMs-g.startMs),[350]);
  for (const label of ['H','K','X','Z']) {
    const other=run(label,sequence());
    assert.ok(other.statuses.some(s=>s.reason==='gap-too-long'),label);
  }
});
test('J rejects prolonged absence, hand switch, and incomplete descending-only motion', () => {
  const {segmenter}=run('J',sequence(false).filter(f=>f.time<=750));
  assert.equal(segmenter.observe(null,1400,'Right',1).reason,'gap-too-long');
  const prepared=run('J',sequence(false).filter(f=>f.time<=750)).segmenter;
  assert.equal(prepared.observe(hand(0,.16),800,'Left',1).reason,'unstable-handedness');
  assert.equal(prepared.observe(hand(0,.16),1400,'Left',1).reason,'gap-too-long');
  assert.equal(run('J',sequence(true,false)).complete,undefined);
});
test('automatic recognition shares keyframes and clears confirmation on missing frame', () => {
  const reference=run('J',sequence(false)).complete.clip;
  const recognizer=new TemporalRecognizer({J:[reference]});
  let result, finalTime;
  for (const f of sequence()) {
    result=recognizer.predict(f.hand,f.time,'Right',1);
    if (result.state==='confirming') {finalTime=f.time;break;}
  }
  assert.equal(result.targetClass,'J',JSON.stringify(result));
  assert.equal(recognizer.predict(null,finalTime+50,'Right',1).state,'tracking-lost');
});

test('missing callbacks are recorded as a gap and mirrored left hands share the path', () => {
  const silent=run('J',sequence().filter(f=>f.hand));
  assert.ok(silent.complete);
  assert.equal(silent.complete.clip.occlusions[0].endMs-silent.complete.clip.occlusions[0].startMs,350);
  const mirrored=sequence().map(f=>({...f,hand:f.hand?.map(p=>({...p,x:1-p.x}))}));
  assert.equal(run('J',mirrored,'Left').complete?.jPhase,'complete');
});

test('disappearance of a stationary I cannot manufacture a completed J', () => {
  const frames=sequence().map(f=>({...f,hand:f.hand ? hand() : null}));
  assert.equal(run('J',frames).complete,undefined);
});

test('a transient handedness flip is excluded, then J resumes with the original label', () => {
  const segmenter = new MotionSegmenter('J');
  let complete;
  for (const f of sequence(false)) {
    const status=segmenter.observe(f.hand,f.time,f.time>=800 && f.time<1100 ? 'Left' : 'Right',1);
    if (f.time>=800 && f.time<1100) {
      assert.equal(status.state,'occluded');
      assert.equal(status.reason,'unstable-handedness');
    }
    if (status.state==='complete') { complete=status; break; }
  }
  assert.ok(complete);
  assert.equal(complete.clip.occlusions[0].endMs-complete.clip.occlusions[0].startMs,350);
});

test('reset reason survives subsequent arming frames until preparation succeeds', () => {
  const {segmenter}=run('J',sequence(false).filter(f=>f.time<=750));
  assert.equal(segmenter.observe(null,1400,'Right',1).state,'tracking-lost');
  const next=segmenter.observe(hand(),1450,'Right',1);
  assert.equal(next.state,'arming');
  assert.equal(next.lastInterruption.reason,'gap-too-long');
  assert.equal(next.lastInterruption.cause,'missing-landmarks');
  let ready;
  for(let time=1500;time<=1750;time+=50) ready=segmenter.observe(hand(),time,'Right',1);
  assert.equal(ready.state,'ready');
  assert.equal(ready.lastInterruption,undefined);
});

test('free reading and training both preserve a paused observed descent before the hook', () => {
  const frames=sequence(false).filter(f=>f.time<=750);
  for(let time=800;time<=1250;time+=50) frames.push({time,hand:hand(0,.16)});
  for(const label of ['J',null]) {
    const result=run(label,frames);
    assert.equal(result.complete,undefined);
    assert.equal(result.statuses.at(-1).state,'recording');
    assert.equal(result.statuses.at(-1).jPhase,'descending');
  }
});

test('pinky quality permits rigid 3D rotation, translation, scale and aspect changes', () => {
  const original=hand(), frame=(points,time,aspect=1)=>({pose:normalizeHand(points,aspect),time});
  const reference=frame(original,0);
  let previous=reference;
  for(let i=1;i<=12;i++) {
    const pitch=i*Math.PI/12, yaw=i*Math.PI/24;
    const transformed=original.map(p=>{
      const dx=p.x-.5, dy=p.y-.65;
      const y=dy*Math.cos(pitch)-p.z*Math.sin(pitch), z=dy*Math.sin(pitch)+p.z*Math.cos(pitch);
      return {x:(.6+1.3*(dx*Math.cos(yaw)+z*Math.sin(yaw)))/1.7,y:.6+1.3*y,z:1.3*(-dx*Math.sin(yaw)+z*Math.cos(yaw))/1.7};
    });
    const current=frame(transformed,i*80,1.7);
    assert.equal(inspectJPinky(current,reference,previous).valid,true);
    previous=current;
  }
});

test('pinky quality rejects collapsed bones, a tip in the palm and abrupt direction swaps', () => {
  const reference={pose:normalizeHand(hand(),1),time:0};
  for(const index of [18,19,20]) {
    const damaged=hand(); damaged[index]={...damaged[index-1]};
    assert.equal(inspectJPinky({pose:normalizeHand(damaged,1),time:50},reference,reference).reason,'pinky-deformed');
  }
  const damaged=hand(); damaged[20]={...damaged[0]};
  assert.equal(inspectJPinky({pose:normalizeHand(damaged,1),time:50},reference,reference).valid,false);
  const flipped=hand();
  for(const index of [18,19,20]) flipped[index].y=2*flipped[17].y-flipped[index].y;
  assert.equal(inspectJPinky({pose:normalizeHand(flipped,1),time:20},reference,reference).reason,'pinky-jump');
  assert.equal(inspectJPinky({pose:null,time:20},reference,reference).valid,false);
});

test('finite but corrupted landmarks pause J without entering history or advancing keyframes', () => {
  for(const label of ['J',null]) {
    const segmenter=new MotionSegmenter(label);
    let complete;
    for(const f of sequence(false)) {
      const corrupted=f.time>=800 && f.time<1100;
      if(corrupted) f.hand[20]={...f.hand[0]};
      const last=segmenter.last, phase=segmenter.jMotion?.phase;
      const status=segmenter.observe(f.hand,f.time,'Right',1);
      if(corrupted) {
        assert.equal(status.state,'occluded');
        assert.equal(status.reason,'pinky-deformed');
        assert.equal(segmenter.last,last);
        assert.equal(segmenter.jMotion.phase,phase);
        assert.ok(segmenter.frames.every(frame=>frame.time<800));
      }
      if(status.state==='complete') {complete=status;break;}
    }
    assert.ok(complete);
    assert.equal(complete.clip.occlusions[0].endMs-complete.clip.occlusions[0].startMs,350);
    assert.ok(validMotionClip(complete.clip));
  }
});

test('persistent corrupted landmarks time out without renewing grace; other captures are isolated', () => {
  const segmenter=run('J',sequence(false).filter(f=>f.time<=750)).segmenter;
  const damaged=hand(0,.16); damaged[20]={...damaged[0]};
  for(let time=800;time<=1350;time+=50) assert.equal(segmenter.observe(damaged,time,'Right',1).state,'occluded');
  const stopped=segmenter.observe(damaged,1400,'Right',1);
  assert.equal(stopped.reason,'gap-too-long');
  assert.equal(stopped.lastInterruption.cause,'pinky-deformed');
  for(const label of ['H','K','X','Z']) {
    const other=run(label,sequence(false).filter(f=>f.time<=750)).segmenter;
    assert.notEqual(other.observe(damaged,800,'Right',1).reason,'pinky-deformed');
  }
});
