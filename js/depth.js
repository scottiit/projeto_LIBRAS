// Use only the wrist and MCP joints: fingertip motion must not look like depth.
const PALM_SPANS = [[0, 5], [0, 9], [0, 13], [0, 17], [5, 17], [5, 13], [9, 17]];
export const DEPTH_WEIGHT = 1.2;
export const DEPTH_AXIS = 65;
const MIN_RETREAT = .1;
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

function projectedSpans(pose) {
  return PALM_SPANS.map(([a, b]) => Math.hypot(pose[a * 3] - pose[b * 3], pose[a * 3 + 1] - pose[b * 3 + 1]));
}
function palmNormal(pose) {
  const a = [0, 1, 2].map(axis => pose[5 * 3 + axis] - pose[axis]);
  const b = [0, 1, 2].map(axis => pose[17 * 3 + axis] - pose[axis]);
  const cross = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const length = Math.hypot(...cross), denominator = Math.hypot(...a) * Math.hypot(...b);
  // Nearly collinear bases make orientation unreliable; do not invent an angle.
  return denominator > 1e-6 && length / denominator > .12 ? cross.map(value => value / length) : null;
}

/** Apparent palm size, in image-height units, BEFORE per-frame normalization.
 * RMS of seven projected bone spans; x is corrected for aspect ratio.
 * No absolute depth is available from MediaPipe's wrist-relative z coordinates.
 * Pinhole approximation with fixed focal length and unchanged orientation:
 *   s(t) ~ f * L / Z(t), Z(t)/Z(0) ~ s(0)/s(t).
 * We store log(s(0)/s(t)): positive = retreat, negative = approach, unitless.
 * Palm spans avoid the bounding-box changes caused by flexing a fingertip.
 * RMS stays defined when some joints overlap during H. Such frames can still
 * describe rotation; coherentPalmScale reports uncertainty in scale evidence.
 */
export function apparentPalmSize(hand, aspectRatio) {
  const spans = projectedSpans(hand.flatMap(point => [point.x * aspectRatio, point.y, 0]));
  if (spans.some(value => !Number.isFinite(value))) return null;
  const size = Math.sqrt(spans.reduce((sum, value) => sum + value * value, 0) / spans.length);
  return size > .001 ? size : null;
}

/** Uniform contraction changes all spans by the same ratio. Rotation generally
 * contracts different spans differently (foreshortening). Remove the median
 * log ratio and require a majority of consistent spans. One noisy joint must
 * not veto an entire motion. Sequence-level inconsistency is a quality warning;
 * pose/orientation identity is learned from the user's templates by DTW.
 * This is a plausibility check, not recovery of true 3D motion: zoom and camera
 * translation can still produce exactly the same monocular observation.
 */
export function coherentPalmScale(firstPose, currentPose) {
  const initial = projectedSpans(firstPose), current = projectedSpans(currentPose);
  const ratios = initial.flatMap((value, index) => value >= .001 && current[index] >= .001 ? [Math.log(current[index] / value)] : []);
  if (ratios.length < 5 || !ratios.every(Number.isFinite)) return false;
  const center = median(ratios);
  return ratios.filter(value => Math.abs(value - center) <= .12).length >= Math.ceil(ratios.length * .7);
}

/** Validate depth evidence for X, independently of the exact finger pose.
 * Requires >=~9.5% apparent shrink and progressive retreat over multiple samples.
 * Finger/modest orientation variation produces warnings, not a training veto:
 * DTW compares those changes with personal templates during recognition.
 * Median endpoint windows and a 3-sample median tolerate isolated noisy frames.
 * Broad sustained palm rotation, raw jumps, approach and instability still fail.
 * Thresholds are engineering defaults, not calibrated recognition accuracy.
 * featureDistance is supplied so this module does not depend on the classifier.
 */
export function depthRetreat(clip, featureDistance) {
  if (clip?.version !== 2 || !Array.isArray(clip.frames) || clip.frames.length !== 32 || clip.frames.some(frame => !Array.isArray(frame) || frame.length !== 66 || !frame.every(Number.isFinite))) return { eligible: false, reason: 'missing-depth' };
  const first = clip.frames[0].map((_, axis) => median(clip.frames.slice(0, 3).map(frame => frame[axis])));
  const raw = clip.frames.map(frame => frame[DEPTH_AXIS]);
  const net = median(raw.slice(-3)) - median(raw.slice(0, 3));
  const poseDistances = clip.frames.map(frame => featureDistance(first, frame));
  const poseVariationFraction = poseDistances.filter(value => value > .14).length / clip.frames.length;
  const palmIncoherenceFraction = clip.frames.filter(frame => !coherentPalmScale(first, frame)).length / clip.frames.length;
  const warnings = [];
  if (poseVariationFraction > .2) warnings.push('pose-variation');
  if (palmIncoherenceFraction > .2) warnings.push('palm-variation');
  const initialNormal = palmNormal(first);
  const angles = clip.frames.map(frame => {
    const normal = palmNormal(frame);
    return initialNormal && normal ? Math.acos(Math.max(-1, Math.min(1, initialNormal.reduce((sum, value, axis) => sum + value * normal[axis], 0)))) * 180 / Math.PI : null;
  });
  const endAngles = angles.slice(-3).filter(Number.isFinite);
  const palmRotationDegrees = endAngles.length >= 2 ? median(endAngles) : null;
  const result = { eligible: false, reason: 'insufficient-retreat', scaleRatio: Math.exp(-net), relativeDistanceRatio: Math.exp(net), minShrinkPercent: (1 - Math.exp(-MIN_RETREAT)) * 100, poseVariationFraction, palmIncoherenceFraction, palmRotationDegrees, warnings };
  if (net < -.04) return { ...result, reason: 'approach' };
  if (net < MIN_RETREAT) return result;
  if (net > 1.2) return { ...result, reason: 'excessive-retreat' };
  // Broad, sustained wrist rotations remain distinct from a retreat. Unlike the
  // old any-frame RMS veto, this palm-only check tolerates finger motion, small
  // tilts and isolated angle outliers. 60 degrees is an initial engineering cap.
  if (palmRotationDegrees > 60 && angles.filter(angle => angle !== null && angle > 60).length / angles.length > .2) return { ...result, reason: 'palm-rotation' };
  if (raw.some((value, index) => index > 0 && Math.abs(value - raw[index - 1]) > .1)) return { ...result, reason: 'scale-jump' };
  const smoothed = raw.map((_, index) => median(raw.slice(Math.max(0, index - 1), Math.min(raw.length, index + 2))));
  let backward = 0, advancingSamples = 0;
  for (let index = 1; index < smoothed.length; index++) {
    const delta = smoothed[index] - smoothed[index - 1];
    if (delta < 0) backward -= delta;
    if (delta > .003) advancingSamples++;
  }
  if (advancingSamples < 4 || backward > .05 + net * .35) return { ...result, reason: 'unstable-retreat' };
  return { ...result, eligible: true, reason: 'retreat' };
}
