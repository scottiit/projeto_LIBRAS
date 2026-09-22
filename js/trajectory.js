export const DYNAMIC_CLASSES = new Set(['J', 'Z', 'X']);
export const isValidHand = hand => Array.isArray(hand) && hand.length === 21 && hand.every(point => point && ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis])));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const delta = (a, b) => ({ x: b.x - a.x, y: b.y - a.y, z: b.z - a.z });
const scale = hand => Math.max(0.025, distance(hand[0], hand[9]));
function jointAngle(a, b, c) {
  const u = delta(b, a), v = delta(b, c);
  const norm = Math.hypot(u.x, u.y, u.z) * Math.hypot(v.x, v.y, v.z);
  return norm < 1e-8 ? 0 : Math.acos(Math.max(-1, Math.min(1, (u.x * v.x + u.y * v.y + u.z * v.z) / norm)));
}
const extended = (hand, base) => distance(hand[base + 3], hand[0]) > distance(hand[base + 1], hand[0]) * 1.15;
const isIPose = hand => extended(hand, 17) && [5, 9, 13].every(base => !extended(hand, base));
const isHook = hand => jointAngle(hand[5], hand[6], hand[8]) < 1.65;

/** FIFO of complete 3D hands. x'=1-x explicitly matches the CSS mirror.
 * A gap, handedness change or wrist teleport discards the previous trajectory.
 * MediaPipe z is wrist-relative; it is NOT calibrated global camera depth.
 */
export class TrajectoryBuffer {
  constructor(capacity = 60) { this.capacity = Math.max(30, Math.min(60, capacity)); this.clear(); }
  clear() { this.frames = []; }
  push(hand, time, handedness = 'Right') {
    if (!isValidHand(hand) || !Number.isFinite(time)) { this.clear(); return false; }
    const landmarks = hand.map(({ x, y, z }) => ({ x: 1 - x, y, z }));
    const previous = this.frames.at(-1);
    if (previous && (time <= previous.time || time - previous.time > 180 || previous.handedness !== handedness || distance(previous.landmarks[0], landmarks[0]) > scale(landmarks) * 2)) this.clear();
    this.frames.push({ landmarks, time, handedness });
    if (this.frames.length > this.capacity) this.frames.shift();
    return true;
  }
}
function validFrames(frames, min = 9) {
  return Array.isArray(frames) && frames.length >= min && frames.every((frame, index) => isValidHand(frame?.landmarks) && Number.isFinite(frame.time) && (!index || (frame.time > frames[index - 1].time && frame.time - frames[index - 1].time <= 180 && frame.handedness === frames[index - 1].handedness)));
}

/**
 * Z: in mirrored coordinates, segment the index fingertip into +X, -X/+Y,
 * +X strokes. Left-handed trajectories are canonicalized by a second sign.
 * Ignore sub-0.06-palm jitter, require 0.65/0.5/0.65-palm displacements and
 * at least two direction samples per stroke. Diagonal slope must be >0.3;
 * horizontal |dy/dx|<0.65. These imply two corners across three strokes
 * (a geometric Z has two internal corners, not three). Reject reversals.
 * Palm normalization makes thresholds approximately invariant to distance.
 * @param {Array<{landmarks:Array<{x:number,y:number,z:number}>,time:number}>} frames
 * @returns {boolean} Experimental geometric evidence, not an ML probability.
 */
export function detectZMovement(frames) {
  if (!validFrames(frames)) return false;
  const size = scale(frames[0].landmarks), direction = frames[0].handedness === 'Left' ? -1 : 1;
  let anchor = frames[0].landmarks[8], phase = 0;
  const lengths = [0, 0, 0], counts = [0, 0, 0];
  for (let index = 1; index < frames.length; index++) {
    const hand = frames[index].landmarks;
    if (!extended(hand, 5)) return false;
    const point = hand[8], vector = delta(anchor, point);
    const dx = vector.x * direction / size, dy = vector.y / size;
    if (Math.hypot(dx, dy) < 0.06) continue;
    anchor = point;
    const horizontal = dx > 0 && Math.abs(dy) < dx * 0.65;
    const diagonal = dx < 0 && dy > 0 && dy > -dx * 0.3;
    if (phase === 0 && diagonal && lengths[0] >= 0.65 && counts[0] >= 2) phase = 1;
    else if (phase === 1 && horizontal && lengths[1] >= 0.5 && counts[1] >= 2) phase = 2;
    if (!(phase === 1 ? diagonal : horizontal)) return false;
    lengths[phase] += Math.hypot(dx, dy);
    counts[phase]++;
  }
  return phase === 2 && lengths[2] >= 0.65 && counts[2] >= 2;
}

/**
 * J: anchor a stable I pose for >=120 ms; pinky and wrist must then descend
 * together (+Y). Analyze the pinky relative to that initial anchor. Require
 * a descent >=0.65 palm and a subsequent inward hook >=0.35 palm in X,
 * ending with an upward tangent. Consecutive tangents must turn progressively
 * (cross product has the inward sign; no jumps >100 degrees).
 * Handedness canonicalizes inward X after mirroring. Wrist displacement
 * rejects isolated fingertip jitter. Constants need validation with signers.
 */
export function detectJMovement(frames) {
  if (!validFrames(frames)) return false;
  const first = frames[0], size = scale(first.landmarks), direction = first.handedness === 'Left' ? -1 : 1;
  const initial = frames.filter(frame => frame.time - first.time <= 160);
  if (initial.length < 3 || initial.at(-1).time - first.time < 120 || initial.some(frame => !isIPose(frame.landmarks) || distance(frame.landmarks[20], first.landmarks[20]) > size * 0.2)) return false;
  const start = initial.at(-1), rest = frames.filter(frame => frame.time > start.time);
  if (rest.length < 5 || rest.some(frame => !isIPose(frame.landmarks))) return false;
  let bottom = 0;
  rest.forEach((frame, index) => { if (frame.landmarks[20].y > rest[bottom].landmarks[20].y) bottom = index; });
  const low = rest[bottom].landmarks, last = rest.at(-1).landmarks;
  if (low[20].y - start.landmarks[20].y < size * 0.65 || low[0].y - start.landmarks[0].y < size * 0.25 || bottom < 2 || bottom > rest.length - 3) return false;
  if ((last[20].x - low[20].x) * direction < size * 0.35 || low[20].y - last[20].y < size * 0.12) return false;
  let previous = null, turns = 0;
  for (let index = Math.max(1, bottom - 2); index < rest.length; index++) {
    const movement = delta(rest[index - 1].landmarks[20], rest[index].landmarks[20]);
    const x = movement.x * direction, y = movement.y;
    const magnitude = Math.hypot(x, y);
    if (magnitude < size * 0.025) continue;
    const current = { x: x / magnitude, y: y / magnitude };
    if (previous) {
      const cross = previous.x * current.y - previous.y * current.x;
      const dot = previous.x * current.x + previous.y * current.y;
      if (cross > 0.25 || dot < -0.17) return false;
      if (cross < -0.03) turns++;
    }
    previous = current;
  }
  return turns >= 2;
}

/**
 * X: compare an initially open index PIP angle (>2.1 rad) with a hook
 * (<1.65 rad), requiring a decrease >0.55 rad within 150..900 ms.
 * z_tip-z_wrist must decrease by >=0.18 palm (toward camera, smaller z),
 * with negative deltas in >=60% of significant depth samples. Do not use
 * abs(z): crossing zero would invert the physical direction. A monocular
 * wrist-relative z cannot measure absolute whole-hand approach; this is
 * an experimental relative-depth proxy, documented instead of overclaimed.
 */
export function detectXMovement(frames) {
  if (!validFrames(frames, 6)) return false;
  const first = frames[0], last = frames.at(-1), duration = last.time - first.time;
  if (duration < 150 || duration > 900) return false;
  const a = first.landmarks, b = last.landmarks, size = scale(a);
  const openAngle = jointAngle(a[5], a[6], a[8]), closedAngle = jointAngle(b[5], b[6], b[8]);
  if (openAngle < 2.1 || !isHook(b) || openAngle - closedAngle < 0.55) return false;
  const depth = hand => hand[8].z - hand[0].z;
  if (depth(b) - depth(a) > -size * 0.18) return false;
  let toward = 0, significant = 0;
  for (let index = 1; index < frames.length; index++) {
    const change = depth(frames[index].landmarks) - depth(frames[index - 1].landmarks);
    if (Math.abs(change) < size * 0.008) continue;
    significant++;
    if (change < 0) toward++;
  }
  return significant >= 3 && toward / significant >= 0.6;
}

/** Completed motion enters a terminal-pose confirmation, revalidated each frame.
 * Losing tracking, pose, identity, or terminal location revokes evidence.
 * The game engine still requires 1000 ms of consecutive >85% observations.
 */
// Legacy baseline kept for regression/comparison only. VisionController now
// uses TemporalRecognizer (dynamic.js); these fixed heuristics are not live.
export class DynamicRecognizer {
  constructor() { this.buffer = new TrajectoryBuffer(); this.reset(); }
  reset() { this.buffer.clear(); this.evidence = null; this.target = null; }
  predict(hand, target, time, handedness) {
    if (target !== this.target) { this.reset(); this.target = target; }
    if (!this.buffer.push(hand, time, handedness)) { this.evidence = null; return 0; }
    const current = this.buffer.frames.at(-1);
    if (this.buffer.frames.length === 1) this.evidence = null;
    if (this.evidence) {
      const point = target === 'J' ? 20 : 8;
      const stable = distance(current.landmarks[point], this.evidence.landmarks[point]) < scale(current.landmarks) * 0.4;
      const pose = target === 'J' ? isIPose(current.landmarks) : target === 'X' ? isHook(current.landmarks) : extended(current.landmarks, 5);
      if (stable && pose && time - this.evidence.time <= 1800) return 0.9;
      this.evidence = null;
      this.buffer.clear();
      return 0;
    }
    const detector = { J: detectJMovement, Z: detectZMovement, X: detectXMovement }[target];
    // Search suffixes: the ring may include a stationary prelude before motion.
    for (let start = 0; start <= this.buffer.frames.length - 6; start++) {
      if (detector?.(this.buffer.frames.slice(start))) { this.evidence = current; return 0.9; }
    }
    return 0;
  }
}
