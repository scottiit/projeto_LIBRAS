import { SIGN_EXAMPLES, DATASET_METADATA, SIGN_REFERENCES } from './dataset.js';
import { isValidHand, DYNAMIC_CLASSES } from './trajectory.js';

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
      for (const features of samples.slice(-12)) if (validFeatures(features)) this.personal.push({ label, features: [...features], source: 'personal' });
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
    const references = Object.entries(SIGN_REFERENCES).filter(([label, path]) => !DYNAMIC_CLASSES.has(label) && !path.endsWith('.mp4'));
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
    const result = { targetClass: null, confidenceProbability: 0, timestamp: Date.now(), source: 'examples', alternatives: [] };
    const features = normalizeHand(hand, aspectRatio);
    if (!features) return result;
    const variants = [];
    for (const mirror of [1, -1]) for (const angle of [-Math.PI / 15, 0, Math.PI / 15]) {
      const sin = Math.sin(angle), cos = Math.cos(angle);
      variants.push(features.map((value, index) => {
        if (index % 3 === 0) return features[index] * mirror * cos - features[index + 1] * sin;
        if (index % 3 === 1) return features[index - 1] * mirror * sin + features[index] * cos;
        return value;
      }));
    }
    const distances = new Map();
    for (const example of [...this.base, ...this.personal]) {
      if ((domain === 'numbers') !== /^\d$/.test(example.label)) continue;
      const distance = Math.min(...variants.map(variant => featureDistance(variant, example.features)));
      if (!distances.has(example.label) || distance < distances.get(example.label).distance) distances.set(example.label, { label: example.label, distance, source: example.source });
    }
    const ranked = [...distances.values()].sort((a, b) => a.distance - b.distance);
    if (!ranked.length) return result;
    const [first, second] = ranked;
    const similarity = Math.exp(-0.5 * (first.distance / 0.28) ** 2);
    const separation = second ? Math.min(1, Math.max(0, (second.distance - first.distance) / 0.12)) : 1;
    return { ...result, targetClass: first.label, confidenceProbability: Math.min(similarity, 0.5 + 0.5 * separation), distance: first.distance, source: first.source, alternatives: ranked.slice(0, 3) };
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
    const interrupted = !features || (this.lastTime !== null && (time <= this.lastTime || time - this.lastTime > 180)) || (this.samples.length && featureDistance(features, this.samples[0].features) > 0.09);
    if (interrupted) this.samples = [];
    this.lastTime = time;
    if (!features) return { state: 'tracking-lost', progress: 0 };
    this.samples.push({ features, time });
    const elapsed = time - this.samples[0].time;
    if (elapsed < 1200 || this.samples.length < 12) return { state: 'collecting', progress: Math.min(1, elapsed / 1200) };
    // Keep five representative observations, not hundreds of correlated frames.
    const samples = Array.from({ length: 5 }, (_, index) => this.samples[Math.floor(index * (this.samples.length - 1) / 4)].features);
    return { state: 'complete', label: this.label, samples };
  }
}
