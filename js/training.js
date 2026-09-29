import { SignClassifier, validFeatures, featureDistance } from './classifier.js';
import { MotionClassifier, usableMotionClip, MOTION_LABELS } from './dynamic.js';
import { DYNAMIC_CLASSES } from './trajectory.js';
import { validExampleConfidence } from './example-policy.js';

/** One execution occupies one slot. Keep its medoid: the observed frame with
 * the smallest total distance to the other observations. Unlike averaging,
 * this preserves an actual captured hand. All frames still undergo admission.
 * Ties keep the earlier frame. Pending captures retain their observations so
 * a second independent execution can validate the entire first capture.
 */
function staticRepresentative(samples) {
  let selected = samples[0], minimum = Infinity;
  for (const candidate of samples) {
    const distance = samples.reduce((sum, sample) => sum + featureDistance(candidate, sample), 0);
    if (distance < minimum) { minimum = distance; selected = candidate; }
  }
  return selected;
}

/** Admission is evaluated before inserting any candidate into the live bank.
 * No self-comparison, mocked confidence, or target relabeling is permitted.
 * With no reference for a class, one provisional execution is persisted outside
 * the dataset. Only two independent, mutually matching executions can seed it.
 * Repeatability establishes consistency, not linguistic correctness of a sign.
 */
export class TrainingManager {
  constructor(store, clock = () => Date.now()) { this.store = store; this.clock = clock; }

  recordStatic(name, label, samples, classifier) {
    if (!/^[A-Z0-9]$/.test(label) || DYNAMIC_CLASSES.has(label) || !Array.isArray(samples) || !samples.length || samples.length > 5 || !samples.every(validFeatures)) throw new Error('Captura estática inválida.');
    return this.record(name, label, { kind: 'static', samples }, classifier);
  }
  recordMotion(name, label, clip, classifier) {
    if (!MOTION_LABELS.includes(label) || !usableMotionClip(label, clip)) throw new Error('Captura de movimento inválida.');
    return this.record(name, label, { kind: 'motion', clip }, classifier);
  }

  comparatorWithReference(classifier, label, candidate) {
    if (candidate.kind === 'motion') return new MotionClassifier({ ...classifier.examples, [label]: [candidate.clip] });
    const comparator = new SignClassifier([]);
    comparator.base = classifier.base;
    comparator.personal = [...classifier.personal, { label, features: staticRepresentative(candidate.samples), source: 'repeatability' }];
    return comparator;
  }
  evaluate(candidate, label, classifier) {
    const predictions = candidate.kind === 'motion' ? [classifier.predict(candidate.clip)] : candidate.samples.map(features => classifier.predictFeatures(features, /^\d$/.test(label) ? 'numbers' : 'alphabet'));
    return predictions.map(prediction => {
      // UNKNOWN is an explicit negative class: it can seed rejection examples,
      // but its accepted comparison must never become positive game evidence.
      const matchedLabel = label === 'UNKNOWN' ? prediction.alternatives?.[0]?.label : prediction.targetClass;
      const confidence = label === 'UNKNOWN' ? prediction.similarityScore : prediction.confidenceProbability;
      return { confidence, matchedLabel, accepted: matchedLabel === label && validExampleConfidence(confidence) };
    });
  }
  records(candidate, assessments, capturedAt, comparisonSource) {
    const metadata = index => ({ confidenceProbability: assessments[index].confidence, capturedAt, comparisonSource });
    if (candidate.kind === 'motion') return [{ ...candidate.clip, ...metadata(0) }];
    // The capture's weakest admitted observation determines its quality band;
    // choosing a representative must not inflate the stored confidence.
    return [{ features: [...staticRepresentative(candidate.samples)], ...metadata(0), confidenceProbability: Math.min(...assessments.map(item => item.confidence)) }];
  }
  record(name, label, candidate, classifier) {
    const profile = this.store.read(name);
    if (!profile) throw new Error('Perfil não encontrado.');
    const now = this.clock();
    let assessments, records, source = 'reference';
    if (!classifier.hasClass(label)) {
      const pending = profile.pendingExamples?.[label];
      if (!pending || pending.kind !== candidate.kind) {
        return { state: 'pending', profile: this.store.stageExample(name, label, candidate), savedCount: 0 };
      }
      // Evaluate both directions to avoid admitting the first execution solely
      // because the second happened to match one of its easiest observations.
      assessments = this.evaluate(candidate, label, this.comparatorWithReference(classifier, label, pending));
      const previousAssessments = this.evaluate(pending, label, this.comparatorWithReference(classifier, label, candidate));
      if ([...assessments, ...previousAssessments].some(item => !item.accepted)) return this.rejected(profile, [...assessments, ...previousAssessments], true);
      source = 'repeatability';
      records = [...this.records(pending, previousAssessments, pending.createdAt, source), ...this.records(candidate, assessments, now, source)];
    } else {
      assessments = this.evaluate(candidate, label, classifier);
      if (assessments.some(item => !item.accepted)) return this.rejected(profile, assessments, false);
      records = this.records(candidate, assessments, now, source);
    }
    const saved = candidate.kind === 'motion' ? this.store.saveMotions(name, label, records) : this.store.saveExamples(name, label, records);
    return { state: 'saved', profile: saved, savedCount: records.length, confidence: Math.min(...records.map(record => record.confidenceProbability)), comparisonSource: source };
  }
  rejected(profile, assessments, provisional) {
    const failure = assessments.find(item => !item.accepted);
    return { state: 'rejected', profile, savedCount: 0, provisional, confidence: Number.isFinite(failure?.confidence) ? failure.confidence : 0, matchedLabel: failure?.matchedLabel ?? null };
  }
}
