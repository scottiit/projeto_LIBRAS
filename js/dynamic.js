import { isValidHand, DYNAMIC_CLASSES } from './trajectory.js';
import { normalizeHand, featureDistance } from './classifier.js';
import { apparentPalmSize, coherentPalmScale, depthRetreat, DEPTH_WEIGHT, DEPTH_AXIS } from './depth.js';

export const MOTION_VERSION = 2;
export const MOTION_LABELS = [...DYNAMIC_CLASSES, 'UNKNOWN'];
export const MOTION_LIMIT = 8;
const MOTION_SAMPLES = 32;
const MOTION_GAP = 180;
const motionClamp = value => Math.max(0, Math.min(1, value));

/** Coordinates in image-height units. Mirror X as on screen, then canonicalize
 * left hands to right hands. MediaPipe z is wrist-relative, NOT camera distance:
 * retain it for finger shape but never infer hand approach from wrist z.
 * normalizeHand does NOT align away 3D rotation: a wrist rotation (H) changes
 * local x/z even with a stationary wrist; upward translation (K) changes the
 * anchored wrist path. These features depend on the tracker estimates; they
 * do not reconstruct hidden joints or establish per-landmark visibility.
 */
function motionFrame(hand, time, handedness, aspectRatio) {
  if (!isValidHand(hand) || !Number.isFinite(time) || !['Left', 'Right'].includes(handedness) || !Number.isFinite(aspectRatio) || aspectRatio <= 0) return null;
  const pose = normalizeHand(hand, aspectRatio);
  if (!pose) return null;
  const direction = handedness === 'Left' ? 1 : -1;
  for (let i = 0; i < 63; i += 3) pose[i] *= direction;
  const palm = [5, 9, 13, 17].reduce((sum, index) => sum + Math.hypot((hand[index].x - hand[0].x) * aspectRatio, hand[index].y - hand[0].y, (hand[index].z - hand[0].z) * aspectRatio), 0) / 4;
  const apparentSize = apparentPalmSize(hand, aspectRatio);
  if (!apparentSize) return null;
  return { time, handedness, aspectRatio, pose, palm, apparentSize, wrist: [direction * hand[0].x * aspectRatio, hand[0].y] };
}
function scaleMotion(a, b) {
  // Depth depends on the palm, not on perfectly still fingertips. Pose changes
  // remain represented separately by featureDistance and the DTW sequence.
  return coherentPalmScale(a.pose, b.pose) ? Math.log(a.apparentSize / b.apparentSize) : 0;
}
function motionDifference(a, b) {
  const palm = (a.palm + b.palm) / 2;
  return Math.hypot(featureDistance(a.pose, b.pose), .55 * Math.hypot(a.wrist[0] - b.wrist[0], a.wrist[1] - b.wrist[1]) / palm, DEPTH_WEIGHT * scaleMotion(a, b));
}
function temporalCost(a, b, includeDepth = true) {
  // Legacy clips contain no scale history: never invent a zero-depth trajectory.
  const depth = includeDepth && a.length === 66 && b.length === 66 ? DEPTH_WEIGHT * (a[DEPTH_AXIS] - b[DEPTH_AXIS]) : 0;
  return Math.hypot(featureDistance(a, b), .55 * Math.hypot(a[63] - b[63], a[64] - b[64]), depth);
}

/** Strict, bounded schema also used for localStorage and untrusted JSON imports. */
export function validMotionClip(clip) {
  return Boolean(clip && [1, MOTION_VERSION].includes(clip.version) && Number.isFinite(clip.durationMs) && clip.durationMs >= 250 && clip.durationMs <= 4500 &&
    Array.isArray(clip.frames) && clip.frames.length === MOTION_SAMPLES && clip.frames.every(frame => Array.isArray(frame) && frame.length === (clip.version === 1 ? 65 : 66) && frame.every(value => Number.isFinite(value) && Math.abs(value) <= 20)) &&
    clip.frames[0][63] === 0 && clip.frames[0][64] === 0 && (clip.version === 1 || clip.frames[0][DEPTH_AXIS] === 0) && (motionExtent(clip) >= .16 || (clip.version === 2 && inspectDepthRetreat(clip).eligible)));
}
export const inspectDepthRetreat = clip => depthRetreat(clip, featureDistance);
export const usableMotionClip = (label, clip) => validMotionClip(clip) && (label !== 'X' || inspectDepthRetreat(clip).eligible);
function motionExtent(clip) {
  return Math.max(...clip.frames.map(frame => temporalCost(frame, clip.frames[0])));
}
/** Resample by elapsed time, not frame index. Local pose is wrist-relative;
 * translation is relative to the FIRST wrist and FIRST palm scale, preserving
 * the path that per-frame recentering alone would destroy (especially J/Z).
 * Fixed 32 samples bound storage and DTW work independently of camera FPS.
 */
function encodeMotion(frames) {
  const first = frames[0], last = frames.at(-1);
  const durationMs = last.time - first.time;
  const values = frames.map(frame => [...frame.pose, (frame.wrist[0] - first.wrist[0]) / first.palm, (frame.wrist[1] - first.wrist[1]) / first.palm, Math.log(first.apparentSize / frame.apparentSize)]);
  let cursor = 0;
  const sampled = Array.from({ length: MOTION_SAMPLES }, (_, i) => {
    const time = first.time + durationMs * i / (MOTION_SAMPLES - 1);
    while (cursor < frames.length - 2 && frames[cursor + 1].time < time) cursor++;
    const fraction = motionClamp((time - frames[cursor].time) / (frames[cursor + 1].time - frames[cursor].time));
    return values[cursor].map((value, axis) => value + fraction * (values[cursor + 1][axis] - value));
  });
  const clip = { version: MOTION_VERSION, durationMs, frames: sampled };
  return validMotionClip(clip) ? clip : null;
}

/** Exact DTW in a Sakoe-Chiba-style band (25% of length).
 * D(i,j) = c(i,j) + min(D(i-1,j), D(i,j-1), D(i-1,j-1)).
 * c combines weighted local landmark RMS and anchored wrist displacement.
 * Return accumulated minimum-path cost / path length. O(N * band) cells,
 * O(N) memory; this is NOT FastDTW, neural inference or a calibrated probability.
 * Uniform resampling removes global speed; warping handles local speed changes.
 */
export function motionDtw(left, right, includeDepth = true) {
  if (!validMotionClip(left) || !validMotionClip(right)) return Infinity;
  const a = left.frames, b = right.frames, band = Math.ceil(Math.max(a.length, b.length) * .25);
  let previous = new Float64Array(b.length + 1).fill(Infinity), lengths = new Uint16Array(b.length + 1);
  previous[0] = 0;
  for (let i = 1; i <= a.length; i++) {
    const row = new Float64Array(b.length + 1).fill(Infinity), counts = new Uint16Array(b.length + 1);
    for (let j = Math.max(1, i - band); j <= Math.min(b.length, i + band); j++) {
      let best = previous[j - 1], count = lengths[j - 1];
      if (previous[j] < best) { best = previous[j]; count = lengths[j]; }
      if (row[j - 1] < best) { best = row[j - 1]; count = counts[j - 1]; }
      row[j] = best + temporalCost(a[i - 1], b[j - 1], includeDepth); counts[j] = count + 1;
    }
    previous = row; lengths = counts;
  }
  return previous[b.length] / lengths[b.length];
}

/** All dynamic classes compete; the requested game target is never an input.
 * Absolute similarity, endpoint agreement and nearest competing class margin
 * prevent a nearest template from automatically becoming an accepted sign.
 * UNKNOWN templates are explicit counterexamples, and can only reject.
 */
export class MotionClassifier {
  constructor(examples) { this.setExamples(examples); }
  setExamples(examples = {}) {
    this.examples = Object.fromEntries(MOTION_LABELS.map(label => [label, (Array.isArray(examples?.[label]) ? examples[label] : []).filter(clip => usableMotionClip(label, clip)).slice(-MOTION_LIMIT)]));
  }
  hasClass(label) { return Boolean(this.examples[label]?.length); }
  predict(clip) {
    const result = { targetClass: null, confidenceProbability: 0, timestamp: Date.now(), source: 'dtw', alternatives: [], reason: 'invalid' };
    if (!validMotionClip(clip)) return result;
    const depth = inspectDepthRetreat(clip);
    const alternatives = MOTION_LABELS.filter(label => this.hasClass(label)).map(label => {
      // Preserve the validated pose/XY metric for H/J/K/Z. X and new rejection
      // examples also compare retreat; old non-X examples remain usable as-is.
      const includeDepth = label === 'X' || label === 'UNKNOWN';
      const distances = this.examples[label].map(example => {
        const dtw = motionDtw(clip, example, includeDepth);
        // Do not let time warping hide the wrong initial/final pose or an incomplete path.
        const endpoints = (temporalCost(clip.frames[0], example.frames[0], includeDepth) + temporalCost(clip.frames.at(-1), example.frames.at(-1), includeDepth)) / 2;
        return Math.max(dtw, endpoints * .6);
      });
      return { label, distance: Math.min(...distances) };
    }).sort((a, b) => a.distance - b.distance);
    if (!alternatives.length) return { ...result, depth, reason: 'no-examples' };
    const [best, second] = alternatives;
    const similarity = Math.exp(-.5 * (best.distance / .22) ** 2);
    const separation = second ? motionClamp((second.distance - best.distance) / .12) : 1;
    const score = Math.min(similarity, .5 + .5 * separation);
    const needsDepth = best.label === 'X' && !depth.eligible;
    const accepted = best.label !== 'UNKNOWN' && !needsDepth && score > .85;
    return { ...result, targetClass: accepted ? best.label : null, confidenceProbability: accepted ? score : 0, similarityScore: score, alternatives, depth, reason: accepted ? 'matched' : best.label === 'UNKNOWN' ? 'negative' : needsDepth ? 'depth-required' : 'uncertain' };
  }
}

/** Online segmentation: stable start -> motion -> stable end. Both recording
 * and live recognition use this same state machine. Tracking gaps, hand switches,
 * aspect changes and jumps invalidate the ENTIRE unfinished movement. No interpolation
 * bridges missing tracking. History has a 4.5 s time limit AND a 160-frame cap.
 */
export class MotionSegmenter {
  constructor() { this.reset(); }
  reset() { this.state = 'arming'; this.anchor = null; this.last = null; this.frames = []; this.preRoll = []; this.stillSince = null; }
  observe(hand, time, handedness, aspectRatio = 1) {
    const frame = motionFrame(hand, time, handedness, aspectRatio);
    if (!frame) { this.reset(); return { state: 'tracking-lost' }; }
    // Reject a sudden >~11% size change between observations. Otherwise linear
    // resampling could turn ONE tracker/zoom jump into many smooth fake samples.
    const broken = this.last && (time <= this.last.time || time - this.last.time > MOTION_GAP || handedness !== this.last.handedness || aspectRatio !== this.last.aspectRatio || motionDifference(this.last, frame) > 2 || Math.abs(scaleMotion(this.last, frame)) > .12);
    if (broken) { this.reset(); return { state: 'tracking-lost' }; }
    this.last = frame;
    if (!this.anchor) this.anchor = frame;
    if (this.state === 'arming') {
      if (motionDifference(this.anchor, frame) > .07) this.anchor = frame;
      this.preRoll = [frame];
      if (time - this.anchor.time >= 240) this.state = 'ready';
      return { state: this.state };
    }
    if (this.state === 'ready') {
      this.preRoll.push(frame);
      this.preRoll = this.preRoll.filter(item => time - item.time <= 160).slice(-12);
      // Detect small coherent scale changes early so pre-roll retains the start
      // of a retreat whose normalized pose and wrist XY may remain identical.
      if (motionDifference(this.anchor, frame) <= .12 && Math.abs(scaleMotion(this.anchor, frame)) <= .055) return { state: 'ready' };
      this.frames = [...this.preRoll]; this.state = 'recording'; this.anchor = frame; this.stillSince = time;
    } else if (time - this.frames.at(-1).time >= 30) this.frames.push(frame);
    if (time - this.frames[0].time > 4500 || this.frames.length >= 160) { this.reset(); return { state: 'too-long' }; }
    if (motionDifference(this.anchor, frame) > .07 || Math.abs(scaleMotion(this.anchor, frame)) > .025) { this.anchor = frame; this.stillSince = time; }
    if (time - this.stillSince < 300) return { state: 'recording', durationMs: time - this.frames[0].time };
    // Keep only 100 ms of the final pause: its length is not part of the sign.
    const trimmed = this.frames.filter(item => item.time <= this.stillSince + 100);
    const clip = trimmed.length >= 4 ? encodeMotion(trimmed) : null;
    this.reset();
    return clip ? { state: 'complete', clip, terminal: frame } : { state: 'too-short' };
  }
}

export class MotionCapture {
  constructor(label, now) {
    if (!MOTION_LABELS.includes(label)) throw new Error('Classe dinâmica inválida.');
    this.label = label; this.startedAt = now; this.segmenter = new MotionSegmenter();
  }
  observe(hand, time, aspectRatio = 1, handedness) {
    if (time - this.startedAt > 15000) return { state: 'timeout', dynamic: true };
    if (time - this.startedAt < 2000) return { state: 'warmup', remaining: Math.ceil((2000 - time + this.startedAt) / 1000), dynamic: true };
    const status = this.segmenter.observe(hand, time, handedness, aspectRatio);
    if (status.state === 'complete' && this.label === 'X') {
      const depth = inspectDepthRetreat(status.clip);
      if (!depth.eligible) return { state: 'depth-required', dynamic: true, label: this.label, depth };
      return { ...status, dynamic: true, label: this.label, depth };
    }
    return { ...status, dynamic: true, label: this.label };
  }
}

/** A completed match is evidence of a movement, not a permanent class latch.
 * Fresh, uninterrupted frames in its terminal pose can sustain that evidence for
 * 1 s in GameEngine. A lost frame, hand switch, changed pose or target reset clears
 * it. No new motion is inferred from the held pose; repeated letters need repetition.
 */
export class TemporalRecognizer {
  constructor(examples) { this.classifier = new MotionClassifier(examples); this.reset(); }
  setExamples(examples) { this.classifier.setExamples(examples); this.reset(); }
  reset() { this.segmenter = new MotionSegmenter(); this.evidence = null; this.lastTime = null; this.feedback = null; }
  predict(hand, time, handedness, aspectRatio = 1) {
    const empty = state => ({ targetClass: null, confidenceProbability: 0, timestamp: Date.now(), source: 'dtw', state });
    const frame = motionFrame(hand, time, handedness, aspectRatio);
    if (!frame || (this.lastTime !== null && (time <= this.lastTime || time - this.lastTime > MOTION_GAP))) { this.reset(); return empty('tracking-lost'); }
    this.lastTime = time;
    if (this.evidence) {
      const { terminal, prediction } = this.evidence;
      if (handedness === terminal.handedness && aspectRatio === terminal.aspectRatio && time - terminal.time <= 1800 && motionDifference(terminal, frame) <= .1) return { ...prediction, timestamp: Date.now(), state: 'confirming' };
      this.reset(); return empty('restart');
    }
    const status = this.segmenter.observe(hand, time, handedness, aspectRatio);
    if (status.state !== 'complete') {
      if (this.feedback && time < this.feedback.until && ['arming', 'ready'].includes(status.state)) return { ...this.feedback.prediction, timestamp: Date.now(), state: 'rejected' };
      this.feedback = null;
      return empty(status.state);
    }
    const prediction = this.classifier.predict(status.clip);
    if (prediction.targetClass && DYNAMIC_CLASSES.has(prediction.targetClass)) this.evidence = { terminal: status.terminal, prediction };
    else this.feedback = { prediction, until: time + 1200 };
    return { ...prediction, state: this.evidence ? 'confirming' : 'rejected' };
  }
}
