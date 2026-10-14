import { SIGN_EXAMPLES, DATASET_METADATA, SIGN_REFERENCES } from './dataset.js';
import { isValidHand, DYNAMIC_CLASSES } from './trajectory.js';
import { EXAMPLE_LIMIT } from './example-policy.js';

export function normalizeHand(hand, aspectRatio = 1) {
  if (!isValidHand(hand)) return null;
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0 || aspectRatio > 10) return null;
  // MediaPipe x/z are width-relative, y height-relative. Correct the source
  // aspect BEFORE isotropic palm normalization (portrait photos vs webcam).
  const corrected = hand.map(point => ({ x: point.x * aspectRatio, y: point.y, z: point.z * aspectRatio }));
  const wrist = corrected[0];
  const palm = [5, 9, 13, 17].reduce((total, index) => total + Math.hypot(corrected[index].x - wrist.x, corrected[index].y - wrist.y, corrected[index].z - wrist.z), 0) / 4;
  if (palm < 0.015) return null;
  return corrected.flatMap(point => [(point.x - wrist.x) / palm, (point.y - wrist.y) / palm, (point.z - wrist.z) / palm]);
}
export function coordinatesToHand(coordinates) {
  return Array.from({ length: 21 }, (_, index) => ({ x: coordinates[index * 3], y: coordinates[index * 3 + 1], z: coordinates[index * 3 + 2] }));
}
export const validFeatures = features => Array.isArray(features) && features.length === 63 && features.every(value => Number.isFinite(value) && Math.abs(value) <= 20);

/** Weighted RMS in palm units. Tips and distal joints carry more information
 * than the nearly identical MCP positions. z gets less weight because monocular
 * depth is noisier. All examples use the same extraction as incoming frames.
 */
export function featureDistance(a, b) {
  let sum = 0, weight = 0;
  for (let index = 3; index < 63; index++) {
    const point = Math.floor(index / 3);
    const jointWeight = point % 4 === 0 ? 2 : 1;
    const axisWeight = index % 3 === 2 ? 0.45 : 1;
    const currentWeight = jointWeight * axisWeight;
    sum += (a[index] - b[index]) ** 2 * currentWeight;
    weight += currentWeight;
  }
  return Math.sqrt(sum / weight);
}

/** A/S fine comparison: 65% thumb configuration, 35% whole-hand geometry.
 * Express thumb joints 2/3/4 relative to index MCP 5 to reduce wrist-placement
 * noise. Distal joints receive more weight; estimated z keeps weight 0.45.
 * Apply this SAME metric to every competing class in a candidate A/S dispute,
 * never just to the requested label or only to one side of the comparison.
 * This is a geometric pilot heuristic; weights require real-person evaluation.
 */
export function thumbFocusedDistance(a, b) {
  let sum = 0, weight = 0;
  for (const joint of [2, 3, 4]) for (let axis = 0; axis < 3; axis++) {
    const currentWeight = (joint === 2 ? 1 : 2) * (axis === 2 ? .45 : 1);
    const delta = (a[joint * 3 + axis] - a[15 + axis]) - (b[joint * 3 + axis] - b[15 + axis]);
    sum += delta ** 2 * currentWeight; weight += currentWeight;
  }
  return Math.sqrt(.35 * featureDistance(a, b) ** 2 + .65 * sum / weight);
}

/** Detect obvious index-chain collapse/stretch. Bent fingers are allowed.
 * Uses estimated 3D lengths in palm units, not projected 2D straightness.
 * Bounds are broad pilot heuristics, not per-joint visibility probabilities.
 */
export function validIndexGeometry(features) {
  if (!validFeatures(features)) return false;
  const distance = (a, b) => Math.hypot(...[0,1,2].map(axis => features[a*3+axis]-features[b*3+axis]));
  const bones = [5,6,7].map(index=>distance(index,index+1));
  const middle = [9,10,11].reduce((sum,index)=>sum+distance(index,index+1),0);
  const length = bones.reduce((sum,value)=>sum+value,0);
  return bones.every(value=>value>.04 && value<1.3) && middle>.12 && length/middle>.25 && length/middle<1.8;
}

/** F/T compare the thumb's position relative to several index joints.
 * Retain x/y and wrist-relative z; do not hard-code camera front/back sign.
 * z is an estimated cue and cannot reconstruct an occluded index finger.
 * All competitors use this same metric whenever the F/T branch is selected.
 */
export function thumbIndexDistance(a,b) {
  let sum=0,weight=0;
  for(const [thumb,index] of [[3,6],[4,6],[4,7],[4,8]]) for(let axis=0;axis<3;axis++) {
    const axisWeight=axis===2?.8:1;
    const delta=(a[thumb*3+axis]-a[index*3+axis])-(b[thumb*3+axis]-b[index*3+axis]);
    sum+=axisWeight*delta**2;weight+=axisWeight;
  }
  return Math.sqrt(.4*featureDistance(a,b)**2+.6*sum/weight);
}

/** U/R crossing evidence in the image plane. The lateral axis is MCP 5->9,
 * so dot products retain their sign under reflection and in-plane rotation.
 * Reversed fingertip order indicates crossing; preserved order plus aligned
 * extended fingers indicates parallelism. Near overlap/edge-on projection is
 * ambiguous: estimated z cannot prove which finger is actually in front.
 * These broad geometric thresholds need real-person calibration.
 */
export function inspectFingerCrossing(features) {
  if (!validFeatures(features)) return 'uncertain';
  const point = index => features.slice(index*3,index*3+2);
  const subtract = (a,b) => a.map((value,axis)=>value-b[axis]);
  const dot = (a,b) => a.reduce((sum,value,axis)=>sum+value*b[axis],0);
  const base=subtract(point(9),point(5));
  const index=subtract(point(8),point(5)),middle=subtract(point(12),point(9));
  const baseSquared=dot(base,base), lengths=Math.hypot(...index)*Math.hypot(...middle);
  if(baseSquared<.08**2 || Math.min(Math.hypot(...index),Math.hypot(...middle))<.35) return 'uncertain';
  const order=dot(subtract(point(12),point(8)),base)/baseSquared;
  const alignment=dot(index,middle)/lengths;
  // A single displaced tip is insufficient: PIP/DIP must progress along each
  // finger toward its tip. Obvious reassociation must not manufacture crossing.
  for(const [start,end] of [[5,8],[9,12]]) {
    const direction=subtract(point(end),point(start)), squared=dot(direction,direction);
    let previous=0;
    for(const joint of [start+1,start+2]) {
      const progress=dot(subtract(point(joint),point(start)),direction)/squared;
      if(progress<previous-.1 || progress>1.2) return 'uncertain';
      previous=progress;
    }
  }
  if(order<-.2 && alignment>.3) return 'crossed';
  if(order>.2 && alignment>.9) return 'parallel';
  return 'uncertain';
}

/** V-only opening descriptor in XY; invariant to rotation/reflection/scale.
 * Measure both angular divergence and tip separation relative to finger length.
 * Require preserved tip order and coherent intermediate joints via the existing
 * crossing inspector. These thresholds are pilot heuristics, not visibility.
 */
export function inspectVOpening(features) {
  if (!validFeatures(features) || inspectFingerCrossing(features)==='crossed') return null;
  const vector=(a,b)=>[0,1].map(axis=>features[b*3+axis]-features[a*3+axis]);
  const index=vector(5,8),middle=vector(9,12),base=vector(5,9),tips=vector(8,12);
  const left=Math.hypot(...index),right=Math.hypot(...middle),width=Math.hypot(...base);
  if(Math.min(left,right)<.35 || width<.08) return null;
  const cosine=(index[0]*middle[0]+index[1]*middle[1])/(left*right);
  const order=tips[0]*base[0]+tips[1]*base[1];
  if(order<=0) return null;
  // Independent joint progression prevents an isolated swapped fingertip from
  // supplying opening evidence. A real V may exceed the U alignment threshold.
  for(const [start,end]of [[5,8],[9,12]]) {
    const direction=vector(start,end),squared=direction[0]**2+direction[1]**2;
    let previous=0;
    for(const joint of [start+1,start+2]) {
      const offset=vector(start,joint),progress=(offset[0]*direction[0]+offset[1]*direction[1])/squared;
      if(progress<previous-.1 || progress>1.2) return null;
      previous=progress;
    }
  }
  const spread=Math.hypot(...tips)/((left+right)/2);
  return {spread,open:cosine<Math.cos(12*Math.PI/180) && Math.hypot(...tips)/width>1.6};
}

/** Example-based classifier (nearest prototype per class).
 * Translation and uniform scale are removed; both handednesses and small
 * rotations (+/-12 degrees) are tested without erasing meaningful orientation.
 * The expected letter is NEVER an input. We choose among all classes in the
 * alphabet/numeral domain, then the independent game engine checks the answer.
 * Confidence is a conservative similarity score, NOT calibrated ML accuracy:
 * min(exp(-0.5*(distance/0.28)^2), 0.5+0.5*min(1, margin/0.12)).
 * Distant poses and ambiguous nearest neighbors fail the unchanged >85% gate.
 */
export class SignClassifier {
  constructor(examples = SIGN_EXAMPLES) {
    this.base = examples.filter(example => !DYNAMIC_CLASSES.has(example.label)).map(example => ({ label: example.label, features: normalizeHand(coordinatesToHand(example.coordinates), example.aspectRatio ?? 1), source: 'dataset' })).filter(example => example.features);
    this.personal = [];
    this.metadata = DATASET_METADATA;
  }
  setPersonalExamples(examples = {}) {
    this.personal = [];
    if (!examples || typeof examples !== 'object') return;
    for (const [label, samples] of Object.entries(examples)) {
      if (!/^[A-Z0-9]$/.test(label) || DYNAMIC_CLASSES.has(label) || !Array.isArray(samples)) continue;
      for (const sample of samples.slice(-EXAMPLE_LIMIT)) {
        const features = Array.isArray(sample) ? sample : sample?.features;
        if (validFeatures(features)) this.personal.push({ label, features: [...features], source: 'personal' });
      }
    }
  }
  hasClass(label) { return [...this.base, ...this.personal].some(example => example.label === label); }
  /** Re-extract available labeled photos with the exact browser tracking model.
   * The legacy CSV came from Tasks/Python, whose landmarks can differ materially.
   * Run once per controller lifetime, then reuse in-memory prototypes. No uploads.
   * This is training from labeled references, not a benchmark or target injection.
   * Must run before installing the live onResults callback / starting camera sends.
   */
  async adaptFromImages(hands, onProgress = () => {}, isCancelled = () => false) {
    if (this.browserReferencesReady) return;
    const trainedClasses = new Set(DATASET_METADATA.staticClasses);
    const references = Object.entries(SIGN_REFERENCES).filter(([label, path]) => trainedClasses.has(label) && !DYNAMIC_CLASSES.has(label) && !path.endsWith('.mp4'));
    const adapted = [];
    let detectedHand = null;
    hands.onResults(results => { detectedHand = results.multiHandLandmarks?.[0] ?? null; });
    for (const [index, [label, path]] of references.entries()) {
      if (isCancelled()) return;
      onProgress(index + 1, references.length);
      try {
        const image = new Image(); image.src = new URL(path, new URL('../', import.meta.url)).href;
        // The generated file:// bundle uses document-relative asset URLs.
        if (location.protocol === 'file:') image.src = path;
        await image.decode();
        if (isCancelled()) return;
        detectedHand = null;
        hands.reset();
        await hands.send({ image });
        const features = normalizeHand(detectedHand, image.naturalWidth / image.naturalHeight);
        if (features) adapted.push({ label, features, source: 'browser-reference' });
      } catch { /* A missing/undetected reference retains its original CSV sample. */ }
    }
    if (isCancelled()) return;
    const labels = new Set(adapted.map(example => example.label));
    this.base = [...this.base.filter(example => !labels.has(example.label)), ...adapted];
    this.browserReferenceCount = adapted.length;
    this.browserReferencesReady = true;
    hands.reset();
  }
  predict(hand, domain = 'alphabet', aspectRatio = 1) {
    return this.predictFeatures(normalizeHand(hand, aspectRatio), domain);
  }
  /** The training capture already contains normalized vectors. Evaluate them
   * against the PREVIOUS dataset, before saving, with the same decision metric. */
  predictFeatures(features, domain = 'alphabet') {
    const result = { targetClass: null, confidenceProbability: 0, timestamp: Date.now(), source: 'examples', alternatives: [] };
    if (!validFeatures(features)) return result;
    const variants = [];
    for (const mirror of [1, -1]) for (const angle of [-Math.PI / 15, 0, Math.PI / 15]) {
      const sin = Math.sin(angle), cos = Math.cos(angle);
      variants.push(features.map((value, index) => {
        if (index % 3 === 0) return features[index] * mirror * cos - features[index + 1] * sin;
        if (index % 3 === 1) return features[index - 1] * mirror * sin + features[index] * cos;
        return value;
      }));
    }
    const examples = [...this.base, ...this.personal].filter(example => (domain === 'numbers') === /^\d$/.test(example.label));
    const rank = metric => {
      const distances = new Map();
      for (const example of examples) {
        const distance = Math.min(...variants.map(variant => metric(variant, example.features)));
        if (!distances.has(example.label) || distance < distances.get(example.label).distance) distances.set(example.label, { label: example.label, distance, source: example.source });
      }
      return [...distances.values()].sort((a, b) => a.distance - b.distance);
    };
    let ranked = rank(featureDistance);
    if (!ranked.length) return result;
    // A clearly open V can resolve only its U rival. No U/R predicate or U
    // reference distance is changed; closed/uncertain hands follow the old path.
    let vSeparation=null;
    if(domain==='alphabet' && ['U','V'].includes(ranked[0].label)) {
      const opening=inspectVOpening(features),v=ranked.find(item=>item.label==='V');
      const uExamples=examples.filter(item=>item.label==='U').map(item=>inspectVOpening(item.features)).filter(Boolean);
      const vExamples=examples.filter(item=>item.label==='V').map(item=>inspectVOpening(item.features)).filter(item=>item?.open);
      if(opening?.open && v && v.distance<.15 && v.distance-ranked[0].distance<.04 &&
        uExamples.length && uExamples.every(item=>!item.open) && vExamples.some(item=>Math.abs(item.spread-opening.spread)<.15)) {
        vSeparation=Math.max(0,Math.min(1,(opening.spread-Math.max(...uExamples.map(item=>item.spread)))/.2));
        ranked=[v,...ranked.filter(item=>item.label!=='V')];
      }
    }
    const crossingCandidate=domain==='alphabet' && ['U','R'].includes(ranked[0].label) && ranked[0].distance<.28;
    let crossing=null;
    if(crossingCandidate) {
      crossing=inspectFingerCrossing(features);
      if(crossing==='uncertain') return {...result,reason:'uncertain-crossing',alternatives:ranked.slice(0,3)};
      // Apply geometric evidence to BOTH labels, without consulting the target.
      // Other classes retain their distances and can still win/reject this pose.
      ranked=ranked.map(item=>({...item,distance:item.distance+(
        (item.label==='R' && crossing==='parallel') || (item.label==='U' && crossing==='crossed') ? .22 : 0
      )})).sort((a,b)=>a.distance-b.distance);
    }
    const winner = ranked[0], rival = ranked.find(item => item.label === (winner.label === 'A' ? 'S' : 'A'));
    const thumbFocused = domain === 'alphabet' && ['A', 'S'].includes(winner.label) && rival &&
      winner.distance < .28 && rival.distance - winner.distance < .15;
    const indexPair = domain === 'alphabet' && ['F','T'].includes(winner.label);
    if (indexPair && !validIndexGeometry(features)) return { ...result, reason:'unreliable-index', alternatives:ranked.slice(0,3) };
    const indexRival = ranked.find(item=>item.label===(winner.label==='F'?'T':'F'));
    const indexFocused = indexPair && indexRival && winner.distance<.28 && indexRival.distance-winner.distance<.15;
    if (thumbFocused) ranked = rank(thumbFocusedDistance);
    else if (indexFocused) ranked = rank(thumbIndexDistance);
    const [first, second] = ranked;
    if ((crossing==='crossed' && first.label==='U') || (crossing==='parallel' && first.label==='R')) return {...result,reason:'incompatible-crossing',alternatives:ranked.slice(0,3),crossing};
    if (domain==='alphabet' && ['F','T'].includes(first.label) && !validIndexGeometry(features)) return { ...result, reason:'unreliable-index', alternatives:ranked.slice(0,3) };
    const similarity = Math.exp(-0.5 * (first.distance / 0.28) ** 2);
    let separation = second ? Math.min(1, Math.max(0, (second.distance - first.distance) / 0.12)) : 1;
    if(first.label==='V') {
      if(!inspectVOpening(features)?.open) return {...result,reason:'v-opening-required',alternatives:ranked.slice(0,3)};
      if(vSeparation!==null) {
        const competitors=ranked.slice(1).map(item=>item.label==='U'?vSeparation:Math.max(0,Math.min(1,(item.distance-first.distance)/.12)));
        separation=competitors.length?Math.min(...competitors):1;
      }
    }
    return { ...result, targetClass: first.label, confidenceProbability: Math.min(similarity, 0.5 + 0.5 * separation), distance: first.distance, source: first.source, alternatives: ranked.slice(0, 3), metric: first.label==='V' && vSeparation!==null ? 'v-opening' : thumbFocused ? 'thumb-focused' : indexFocused ? 'thumb-index' : crossingCandidate ? 'finger-crossing' : 'whole-hand', crossing };
  }
}

/** Captures a steady pose, never a one-click fabricated success. Warmup lets
 * the user move away from the mouse. Each fresh observation must stay close
 * to the initial normalized pose; loss/gaps/movement restart collection.
 */
export class CalibrationSession {
  constructor(label, now) {
    if (!/^[A-Z0-9]$/.test(label) || DYNAMIC_CLASSES.has(label)) throw new Error('Este sinal exige movimento e não pode ser ensinado como pose estática.');
    this.label = label; this.startedAt = now; this.samples = []; this.lastTime = null;
  }
  observe(hand, time, aspectRatio = 1) {
    if (time - this.startedAt > 15000) return { state: 'timeout' };
    if (time - this.startedAt < 2000) return { state: 'warmup', remaining: Math.ceil((2000 - time + this.startedAt) / 1000) };
    const features = normalizeHand(hand, aspectRatio);
    if (['F','T'].includes(this.label) && features && !validIndexGeometry(features)) {
      this.samples=[];this.lastTime=time;
      return {state:'tracking-lost',reason:'unreliable-index',progress:0};
    }
    const interrupted = !features || (this.lastTime !== null && (time <= this.lastTime || time - this.lastTime > 180)) || (this.samples.length && featureDistance(features, this.samples[0].features) > 0.09);
    if (interrupted) this.samples = [];
    this.lastTime = time;
    if (!features) return { state: 'tracking-lost', progress: 0 };
    this.samples.push({ features, time });
    const elapsed = time - this.samples[0].time;
    if (elapsed < 1200 || this.samples.length < 12) return { state: 'collecting', progress: Math.min(1, elapsed / 1200) };
    // Five observations validate this execution; TrainingManager consolidates
    // them into ONE stored example after every observation passes admission.
    const samples = Array.from({ length: 5 }, (_, index) => this.samples[Math.floor(index * (this.samples.length - 1) / 4)].features);
    return { state: 'complete', label: this.label, samples };
  }
}
