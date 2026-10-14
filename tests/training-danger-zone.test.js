import test from 'node:test';
import assert from 'node:assert/strict';
import { TrainingDangerZone } from '../js/training-danger-zone.js';

function uiFixture(apply) {
  const root = { activeElement:null };
  class Element extends EventTarget {
    constructor() { super(); this.value='85'; this.disabled=false; this.open=false; }
    focus() { root.activeElement=this; }
    showModal() { this.open=true; }
    close() { this.open=false; this.dispatchEvent(new Event('close')); }
    click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  }
  const elements = new Map();
  root.getElementById = id => { if (!elements.has(id)) elements.set(id,new Element()); return elements.get(id); };
  const context = { name:'Ana',label:'A',threshold:.85,records:Array.from({length:8},(_,i)=>({id:i})),busy:false };
  const calls = [], errors = [];
  const zone = new TrainingDangerZone(root,()=>context,async op=>{ calls.push(op); if (apply) await apply(op,context); },error=>errors.push(error));
  zone.render();
  return { zone, context, calls, errors, element:root.getElementById, root };
}

test('slider stages a value; only explicit modal confirmation applies it', async () => {
  const {zone,context,calls,element,root} = uiFixture((op,c)=>{c.threshold=op.value;});
  element('training-threshold').value='70'; element('training-threshold').dispatchEvent(new Event('input'));
  assert.equal(context.threshold,.85); assert.equal(calls.length,0);
  element('apply-training-threshold').focus(); element('apply-training-threshold').click();
  assert.equal(element('training-confirmation').open,true);
  assert.equal(root.activeElement,element('cancel-training-action'));
  assert.match(element('training-confirmation-description').textContent,/70%.*Perfil global/);
  await zone.confirm();
  assert.equal(calls.length,1); assert.equal(context.threshold,.7);
  assert.equal(element('training-confirmation').open,false);
  assert.equal(root.activeElement,element('apply-training-threshold'));
});

test('Cancel and Escape never mutate settings or delete examples', () => {
  const {zone,calls,element} = uiFixture();
  zone.open('oldest'); element('cancel-training-action').click();
  assert.equal(calls.length,0); assert.equal(zone.pending,null);
  zone.open('newest'); element('training-confirmation').dispatchEvent(new Event('cancel',{cancelable:true}));
  assert.equal(calls.length,0); assert.equal(element('training-confirmation').open,false);
});

test('batch confirmation shows actual count; empty bank and active capture block actions', async () => {
  const {zone,context,calls,element} = uiFixture();
  context.records=context.records.slice(0,3); zone.render(); zone.open('newest');
  assert.match(element('training-confirmation-description').textContent,/excluir 3 exemplos mais recentes/);
  await zone.confirm(); assert.equal(calls[0].count,3);
  context.records=[]; zone.render(); zone.open('oldest');
  assert.equal(element('training-confirmation').open,false);
  assert.equal(element('delete-oldest-examples').disabled,true);
  context.records=[{id:1}]; context.busy=true; zone.render(); zone.open('oldest');
  assert.equal(element('training-confirmation').open,false);
});

test('stale profile/letter/dataset changes invalidate the previously confirmed selection', async () => {
  for (const change of [c=>c.label='J',c=>c.name='Bia',c=>c.records.pop(),c=>c.threshold=.75]) {
    const {zone,context,calls,errors}=uiFixture(); zone.open('oldest'); change(context); await zone.confirm();
    assert.equal(calls.length,0); assert.equal(errors.length,1);
  }
});

test('double confirmation and Escape are blocked while a write is pending', async () => {
  let finish;
  const {zone,calls,element}=uiFixture(()=>new Promise(resolve=>{finish=resolve;}));
  zone.open('oldest'); const pending=zone.confirm(); await zone.confirm(); zone.cancel();
  assert.equal(calls.length,1); assert.equal(element('training-confirmation').open,true);
  assert.equal(element('cancel-training-action').disabled,true);
  finish(); await pending; assert.equal(element('training-confirmation').open,false);
});

test('failed writes retain an actionable dialog with an explicit failure message', async () => {
  const {zone,element,errors}=uiFixture(()=>{throw new Error('CSV indisponível');});
  zone.open('oldest'); await zone.confirm();
  assert.equal(element('training-confirmation').open,true);
  assert.match(element('training-confirmation-error').textContent,/não salva.*CSV indisponível/);
  assert.equal(element('confirm-training-action').disabled,false);
  assert.equal(errors.length,1); zone.cancel();
});
