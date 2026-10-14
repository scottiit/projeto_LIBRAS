import { isValidHand } from './trajectory.js';

/** Observed keyframes only. Image Y grows downwards; X is already mirrored and
 * canonicalized by motionFrame. Distances use the INITIAL palm size, so wrist
 * pitch cannot turn a shrinking projected palm into a large artificial path.
 * No palm normal or Euler angle is required: monocular depth is not reliable
 * enough to require an exact 180-degree pitch/yaw. These are tunable pilot
 * heuristics, not a linguistic classifier or reconstruction of hidden joints.
 */
export class JMotionState {
  constructor(frame) {
    this.phase = frame?.jPose ? 'initial' : 'inactive';
    this.origin = frame; this.bottom = frame; this.hookSince = null;
  }
  get active() { return this.phase !== 'inactive'; }
  observe(frame) {
    if (!this.active || this.phase === 'complete') return;
    const scale = this.origin.palm;
    if (this.phase === 'initial') {
      if ((frame.pinky[1] - this.origin.pinky[1]) / scale > .25) {
        this.phase = 'descending'; this.bottom = frame;
      }
      return;
    }
    if (frame.pinky[1] > this.bottom.pinky[1]) this.bottom = frame;
    const left = (this.bottom.pinky[0] - frame.pinky[0]) / scale;
    const up = (this.bottom.pinky[1] - frame.pinky[1]) / scale;
    // Observe a real descending point AND a later left/up hook. Interpolated
    // points never enter this method and cannot supply a missing keyframe.
    if (left > .15 && up > .12 && frame.jPose) {
      this.hookSince ??= frame.time;
      this.phase = frame.time - this.hookSince >= 100 ? 'complete' : 'hook';
    } else { this.hookSince = null; this.phase = 'descending'; }
  }
  interrupt() { this.hookSince = null; }
}

/** Rotation-invariant chord / bone-chain ratio for the little finger.
 * Folded fingers are checked with wrist-to-tip vs wrist-to-PIP distance.
 * This uses estimated z for local shape only, never absolute camera depth.
 * The thumb is deliberately not a hard veto because it is often occluded.
 */
export function hasIPose(hand, aspect) {
  if (!isValidHand(hand) || !Number.isFinite(aspect) || aspect <= 0) return false;
  const distance = (a, b) => Math.hypot((hand[a].x - hand[b].x) * aspect,
    hand[a].y - hand[b].y, (hand[a].z - hand[b].z) * aspect);
  const chain = distance(17, 18) + distance(18, 19) + distance(19, 20);
  return chain > 1e-6 && distance(17, 20) / chain > .8 &&
    [6, 10, 14].every(pip => distance(0, pip + 2) < distance(0, pip) * 1.15);
}

/** Conservative consistency filter, NOT a visibility/confidence estimator.
 * pose is wrist-relative, aspect-corrected and normalized by 3D palm size.
 * Bone lengths and chord/chain ratio survive rigid pitch/yaw, unlike image
 * distances alone. Compare to this execution's initial hand, not fixed anatomy.
 * Broad bounds accommodate noisy monocular z. Smooth but incorrect landmarks
 * can still pass: geometry cannot prove that a point lies on the real finger.
 * Temporal displacement is measured relative to MCP 17, removing translation.
 * The allowance grows with elapsed time since the last ACCEPTED observation;
 * rejected frames must never update either reference or previous frame.
 */
export function inspectJPinky(frame, reference, previous) {
  const extract = item => {
    const pose = item?.pose;
    if (!Array.isArray(pose) || pose.length < 63 || !pose.every(Number.isFinite)) return null;
    const point = index => pose.slice(index * 3, index * 3 + 3);
    const relative = [18, 19, 20].map(index => point(index).map((value, axis) => value - point(17)[axis]));
    const distance = (a, b) => Math.hypot(...point(a).map((value, axis) => value - point(b)[axis]));
    const bones = [17, 18, 19].map(index => distance(index, index + 1));
    const length = bones.reduce((sum, value) => sum + value, 0);
    return length > 1e-6 && bones.every(value => value > 1e-6)
      ? { bones, relative, straightness: distance(17, 20) / length } : null;
  };
  const current = extract(frame), initial = extract(reference), last = extract(previous);
  if (!current || !initial || !last) return { valid: false, reason: 'pinky-deformed' };
  // J retains an extended little finger. Reject a collapsed chain or a tip
  // snapped into the palm; never advance a keyframe using this inferred fold.
  if (current.straightness < .65 || current.bones.some((length, index) => {
    const ratio = length / initial.bones[index];
    return ratio < .5 || ratio > 1.9;
  })) return { valid: false, reason: 'pinky-deformed' };
  const elapsed = (frame.time - previous.time) / 1000;
  if (!Number.isFinite(elapsed) || elapsed <= 0) return { valid: false, reason: 'pinky-jump' };
  const displacement = Math.max(...current.relative.map((point, index) =>
    Math.hypot(...point.map((value, axis) => value - last.relative[index][axis]))));
  if (displacement > .5 + 20 * elapsed) return { valid: false, reason: 'pinky-jump' };
  return { valid: true };
}
