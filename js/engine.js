export const CONFIDENCE_THRESHOLD = 0.85;
export const HOLD_DURATION = 1000;
export const MAX_FRAME_GAP = 180;

/** Pure state machine. Only fresh observations can advance a phase, never the UI loop. */
export class GameEngine {
  constructor({ onAdvance = () => {}, onFinish = () => {}, clock = () => performance.now() } = {}) {
    Object.assign(this, { onAdvance, onFinish, clock });
    this.state = 'idle';
    this.resetHold();
  }
  start(sequence) {
    if (!Array.isArray(sequence) || !sequence.length) throw new Error('Sequência vazia.');
    this.sequence = sequence;
    this.index = 0;
    this.startedAt = this.clock();
    this.finishedAt = null;
    this.state = 'running';
    this.resetHold();
  }
  get current() { return this.sequence?.[this.index] ?? null; }
  resetHold() { this.holdStartedAt = null; this.lastObservationAt = null; this.confirmedDuration = 0; }
  invalidate() { this.resetHold(); }
  cancel() { this.state = 'cancelled'; this.resetHold(); }
  elapsed(now = this.clock()) { return this.startedAt === undefined ? 0 : (this.finishedAt ?? now) - this.startedAt; }
  tick(now = this.clock()) {
    if (this.lastObservationAt !== null && now - this.lastObservationAt > MAX_FRAME_GAP) this.resetHold();
    return { elapsed: this.elapsed(now), progress: this.confirmedDuration / HOLD_DURATION };
  }
  /**
   * observedAt is a monotonic capture time (performance.now), not Date.now.
   * Missing/wrong/<=85% predictions reset immediately, including exactly 85%.
   * Duplicate/out-of-order, delayed frames and gaps >180 ms also break continuity.
   * The first good frame starts at zero; approval occurs only on a fresh frame
   * reaching >=1000 ms. No rounding, accumulated disjoint holds or timer shortcut.
   */
  observe(prediction, observedAt = this.clock()) {
    if (this.state !== 'running') return false;
    const now = this.clock();
    const invalid = !prediction || prediction.targetClass !== this.current.target ||
      !Number.isFinite(prediction.confidenceProbability) || prediction.confidenceProbability <= CONFIDENCE_THRESHOLD || prediction.confidenceProbability > 1 ||
      !Number.isFinite(prediction.timestamp) || !Number.isFinite(observedAt) || observedAt < this.startedAt || observedAt > now || now - observedAt > MAX_FRAME_GAP;
    if (invalid) { this.resetHold(); return false; }
    if (this.lastObservationAt !== null && observedAt <= this.lastObservationAt) { this.resetHold(); return false; }
    if (this.lastObservationAt !== null && observedAt - this.lastObservationAt > MAX_FRAME_GAP) this.resetHold();
    this.holdStartedAt ??= observedAt;
    this.lastObservationAt = observedAt;
    this.confirmedDuration = observedAt - this.holdStartedAt;
    if (this.confirmedDuration < HOLD_DURATION) return false;
    this.index++;
    this.resetHold();
    if (this.index === this.sequence.length) {
      this.finishedAt = now;
      this.state = 'finished';
      this.onFinish(this.elapsed());
    } else this.onAdvance(this.current);
    return true;
  }
}
