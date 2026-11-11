import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ALPHABET_ILLUSTRATIONS, NUMBER_ILLUSTRATIONS, referenceMedia, renderReferenceMedia } from '../js/reference-media.js';
import { SIGN_REFERENCES } from '../js/dataset.js';

class Element {
  constructor(tag, ownerDocument) { this.tagName=tag.toUpperCase();this.ownerDocument=ownerDocument;this.children=[];this.events={};this.open=false;this.pauses=0; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children=nodes; }
  addEventListener(type,callback) { this.events[type]=callback; }
  setAttribute(key,value) { this[key]=value; }
  pause() { this.pauses++; }
}
const document={createElement:tag=>new Element(tag,document)};

test('all 27 references resolve to PNG cards at original crop resolution',async()=>{
  assert.equal(Object.keys(ALPHABET_ILLUSTRATIONS).length,27);
  for(const path of Object.values(ALPHABET_ILLUSTRATIONS)) {
    const source=await readFile(new URL(`../${path}`,import.meta.url));
    assert.deepEqual([...source.subarray(0,8)],[137,80,78,71,13,10,26,10]);
    assert.equal(source.readUInt32BE(16),390);
    assert.equal(source.readUInt32BE(20),290);
  }
});
test('rendering replaces photos with accessible reference cards without changing classifier assets',()=>{
  const container=new Element('div',document),original=JSON.stringify(SIGN_REFERENCES);
  renderReferenceMedia(container,'A');
  assert.equal(container.children.length,1);
  assert.equal(container.children[0].tagName,'IMG');
  assert.equal(container.children[0].src,'assets/references/a.png');
  assert.match(container.children[0].alt,/A.*LIBRAS/);
  assert.match(SIGN_REFERENCES.A,/\.jpg$/);
  assert.equal(JSON.stringify(SIGN_REFERENCES),original);
});
test('motion references retain an optional video that pauses when disclosure closes',()=>{
  const container=new Element('div',document);
  for(const label of ['H','J','K','X','Y','Z']) {
    renderReferenceMedia(container,label);
    assert.equal(container.children[0].src,ALPHABET_ILLUSTRATIONS[label]);
    const details=container.children[1],video=details.children[1];
    assert.equal(details.open,false);
    assert.equal(video.src,SIGN_REFERENCES[label]);
    assert.equal(video.preload,'none');
    details.open=true;details.events.toggle();assert.equal(video.pauses,0);
    details.open=false;details.events.toggle();assert.equal(video.pauses,1);
  }
});
test('number cards load at original resolution and replace obsolete letter videos',async()=>{
  assert.equal(Object.keys(NUMBER_ILLUSTRATIONS).length,10);
  const container=new Element('div',document);
  for(const label of '0123456789') {
    const path=NUMBER_ILLUSTRATIONS[label];
    const source=await readFile(new URL(`../${path}`,import.meta.url));
    assert.deepEqual([...source.subarray(0,8)],[137,80,78,71,13,10,26,10]);
    assert.equal(source.readUInt32BE(16),492);
    assert.equal(source.readUInt32BE(20),246);
    renderReferenceMedia(container,'J');renderReferenceMedia(container,label);
    assert.equal(container.children.length,1);
    assert.equal(container.children[0].src,path);
    assert.equal(container.children[0].alt,`Ilustração do número ${label} em LIBRAS`);
    assert.equal(container.children[0].width,492);
    assert.equal(container.children[0].height,246);
  }
});
test('switching to an unsupported label clears obsolete illustrations and videos',()=>{
  const container=new Element('div',document);
  for(const label of ['10','UNKNOWN','',null,'<script>']) {
    renderReferenceMedia(container,'J');renderReferenceMedia(container,label);
    assert.equal(container.children.length,0);
    assert.deepEqual(referenceMedia(label),{illustration:null,video:null});
  }
});
