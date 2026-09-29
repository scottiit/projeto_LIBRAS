import { MOTION_VERSION, MOTION_LABELS, validMotionClip } from './dynamic.js';
import { DYNAMIC_CLASSES } from './trajectory.js';
import { EXAMPLE_LIMIT, retainExamples, validExampleConfidence } from './example-policy.js';
import { encodeProfileExamples, decodeProfileExamples } from './storage-codec.js';

const PREFIX = 'libras:v1:profile:';
const validTime = value => Number.isFinite(value) && value > 0;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validStaticLabel = label => /^[A-Z0-9]$/.test(label) && !DYNAMIC_CLASSES.has(label);
const validTrainingLabel = label => validStaticLabel(label) || MOTION_LABELS.includes(label);
const validStoredVector = vector => Array.isArray(vector) && vector.length === 63 && vector.every(value => Number.isFinite(value) && Math.abs(value) <= 20);
const legacyStaticExample = example => validStoredVector(example) && !Object.hasOwn(example, 'confidenceProbability');
const validExampleMetadata = example => isRecord(example) && validExampleConfidence(example.confidenceProbability) && Number.isFinite(example.capturedAt) && example.capturedAt >= 0 && ['reference', 'repeatability'].includes(example.comparisonSource);
const approvedStaticExample = example => validExampleMetadata(example) && validStoredVector(example.features);
const approvedMotionExample = example => validExampleMetadata(example) && validMotionClip(example);
const legacyMotionExample = example => validMotionClip(example) && !Object.hasOwn(example, 'confidenceProbability');
const storedStaticExample = example => legacyStaticExample(example) || approvedStaticExample(example);
const storedMotionExample = example => legacyMotionExample(example) || approvedMotionExample(example);
const copyExampleMetadata = example => ({ confidenceProbability: example.confidenceProbability, capturedAt: example.capturedAt, comparisonSource: example.comparisonSource });
const copyStaticExample = example => Array.isArray(example) ? [...example] : { features: [...example.features], ...copyExampleMetadata(example) };
const copyMotionExample = example => ({ version: example.version, durationMs: example.durationMs, frames: example.frames.map(frame => [...frame]), ...(Object.hasOwn(example, 'confidenceProbability') ? copyExampleMetadata(example) : {}) });

function validPendingExample(label, pending, requireCreatedAt = true) {
  return isRecord(pending) && (!requireCreatedAt || (Number.isFinite(pending.createdAt) && pending.createdAt >= 0)) && (pending.kind === 'static'
    ? validStaticLabel(label) && Array.isArray(pending.samples) && pending.samples.length > 0 && pending.samples.length <= EXAMPLE_LIMIT && pending.samples.every(validStoredVector)
    : pending.kind === 'motion' && MOTION_LABELS.includes(label) && legacyMotionExample(pending.clip));
}
const copyPendingExample = pending => pending.kind === 'static'
  ? { kind: 'static', samples: pending.samples.map(sample => [...sample]), createdAt: pending.createdAt }
  : { kind: 'motion', clip: copyMotionExample(pending.clip), createdAt: pending.createdAt };

function validateTrainingBank(bank, labelValidator, exampleValidator) {
  if (!isRecord(bank) || Object.entries(bank).some(([label, examples]) => !labelValidator(label) || !Array.isArray(examples) || examples.length > EXAMPLE_LIMIT || !examples.every(exampleValidator))) throw new Error('Coleção de exemplos inválida; novos registros precisam de semelhança maior que 85% e metadados válidos.');
}

/** Restore optional explicit FIFO order without trusting client timestamps. */
function restoreExampleOrder(approved, legacy, order) {
  if (order === undefined) return [...legacy, ...approved];
  if (!Array.isArray(order) || order.length !== approved.length + legacy.length || order.some(value => value !== 'legacy' && value !== 'approved') || order.filter(value => value === 'legacy').length !== legacy.length) throw new Error('Ordem dos exemplos no backup inválida.');
  let approvedIndex = 0, legacyIndex = 0;
  return order.map(value => value === 'legacy' ? legacy[legacyIndex++] : approved[approvedIndex++]);
}

export class ProfileStore {
  constructor(storage) { this.storage = storage; }
  normalize(name) {
    const normalized = String(name).normalize('NFC').trim().replace(/\s+/g, ' ');
    if (!normalized || normalized.length > 32 || /[\p{Cc}\p{Cf}]/u.test(normalized)) throw new Error('Use um nome de 1 a 32 caracteres, sem caracteres de controle.');
    return normalized;
  }
  key(name) { return PREFIX + encodeURIComponent(this.normalize(name).toLocaleLowerCase('pt-BR')); }
  read(name) {
    const raw = this.storage.getItem(this.key(name));
    if (raw === null) return null;
    let profile;
    try { profile = JSON.parse(raw); } catch { throw new Error('Este perfil tem dados corrompidos. Use outro nome para preservar o original.'); }
    if (!profile || profile.version !== 1 || typeof profile.name !== 'string' || this.key(profile.name) !== this.key(name) || !Array.isArray(profile.accessHistory) || !profile.accessHistory.every(Number.isFinite) || !isRecord(profile.bestTimes) || !isRecord(profile.demoBestTimes) || !isRecord(profile.settings)) throw new Error('O formato deste perfil não é compatível. Use outro nome.');
    return decodeProfileExamples(profile);
  }
  list() {
    const names = [];
    for (let index = 0; index < this.storage.length; index++) {
      const key = this.storage.key(index);
      if (!key?.startsWith(PREFIX)) continue;
      try {
        const profile = JSON.parse(this.storage.getItem(key));
        if (typeof profile?.name === 'string') names.push(profile.name);
      } catch { /* Keep damaged entries untouched; other profiles remain accessible. */ }
    }
    return names.sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }
  write(profile) {
    const value = JSON.stringify(encodeProfileExamples(profile));
    try { this.storage.setItem(this.key(profile.name), value); }
    catch (error) {
      if (error?.name === 'QuotaExceededError' || /quota/i.test(error?.message ?? '')) throw new Error('Limite do armazenamento local (quota) atingido. Nenhum dado desta operação foi salvo. Exporte um backup antes de liberar espaço.', { cause: error });
      throw error;
    }
  }
  requireProfile(name) {
    const profile = this.read(name);
    if (!profile) throw new Error('Perfil não encontrado.');
    return profile;
  }
  login(name) {
    const profile = this.read(name) ?? { version: 1, name: this.normalize(name), createdAt: Date.now(), accessHistory: [], bestTimes: {}, demoBestTimes: {}, settings: { simulation: false } };
    if (profile.settings.recognizerVersion !== 1) {
      profile.settings.simulation = false;
      profile.settings.recognizerVersion = 1;
    }
    profile.accessHistory.push(Date.now());
    this.write(profile);
    return profile;
  }
  saveSettings(name, settings) {
    const profile = this.requireProfile(name);
    profile.settings = { ...profile.settings, simulation: Boolean(settings.simulation) };
    this.write(profile);
    return profile;
  }
  saveExamples(name, label, records) {
    if (!validStaticLabel(label) || !Array.isArray(records) || !records.length || records.length > EXAMPLE_LIMIT || !records.every(approvedStaticExample)) throw new Error('Exemplos inválidos: a semelhança deve ser maior que 85%, com origem e instante da avaliação.');
    const profile = this.requireProfile(name);
    if (!isRecord(profile.signExamples)) profile.signExamples = {};
    const previous = Array.isArray(profile.signExamples[label]) ? profile.signExamples[label].filter(storedStaticExample) : [];
    profile.signExamples[label] = retainExamples(previous, records.map(copyStaticExample));
    if (isRecord(profile.pendingExamples)) delete profile.pendingExamples[label];
    this.write(profile);
    return profile;
  }
  saveScore(name, mode, elapsed, simulated = false) {
    if (!validTime(elapsed)) throw new Error('Tempo inválido.');
    const profile = this.requireProfile(name);
    const records = simulated ? profile.demoBestTimes : profile.bestTimes;
    const previous = Object.hasOwn(records, mode) ? records[mode] : undefined;
    const improved = !validTime(previous) || elapsed < previous;
    if (improved) { records[mode] = elapsed; this.write(profile); }
    return { profile, improved, best: improved ? elapsed : previous };
  }
  saveMotion(name, label, clip) { return this.saveMotions(name, label, [clip]); }
  saveMotions(name, label, clips) {
    if (!MOTION_LABELS.includes(label) || !Array.isArray(clips) || !clips.length || clips.length > EXAMPLE_LIMIT || !clips.every(approvedMotionExample)) throw new Error('Movimentos inválidos: a semelhança deve ser maior que 85%, com origem e instante da avaliação.');
    return this.importMotion(name, { version: MOTION_VERSION, examples: { [label]: clips } });
  }
  importMotion(name, payload) {
    if (![1, MOTION_VERSION].includes(payload?.version) || !isRecord(payload.examples) || !Object.keys(payload.examples).length) throw new Error('Arquivo de movimentos inválido ou de versão incompatível.');
    validateTrainingBank(payload.examples, label => MOTION_LABELS.includes(label), clip => approvedMotionExample(clip) && clip.version <= payload.version);
    const profile = this.requireProfile(name);
    if (!isRecord(profile.motionExamples)) profile.motionExamples = {};
    for (const [label, clips] of Object.entries(payload.examples)) {
      const previous = Array.isArray(profile.motionExamples[label]) ? profile.motionExamples[label].filter(storedMotionExample) : [];
      profile.motionExamples[label] = retainExamples(previous, clips.map(copyMotionExample));
      if (clips.length && isRecord(profile.pendingExamples)) delete profile.pendingExamples[label];
    }
    this.write(profile);
    return profile;
  }
  stageExample(name, label, pending) {
    if (!validPendingExample(label, pending, false)) throw new Error('Referência provisória inválida.');
    const profile = this.requireProfile(name);
    if (!isRecord(profile.pendingExamples)) profile.pendingExamples = {};
    profile.pendingExamples[label] = copyPendingExample({ ...pending, createdAt: Date.now() });
    this.write(profile);
    return profile;
  }
  clearPendingExample(name, label) {
    if (!validTrainingLabel(label)) throw new Error('Classe de sinal inválida.');
    const profile = this.requireProfile(name);
    if (isRecord(profile.pendingExamples)) delete profile.pendingExamples[label];
    this.write(profile);
    return profile;
  }
  removeLastMotion(name, label) {
    if (!MOTION_LABELS.includes(label)) throw new Error('Classe dinâmica inválida.');
    const profile = this.requireProfile(name);
    if (Array.isArray(profile.motionExamples?.[label])) profile.motionExamples[label].pop();
    this.write(profile);
    return profile;
  }
  exportTraining(name) {
    const profile = this.requireProfile(name);
    const backup = { version: 1, kind: 'libras-training', signExamples: {}, motionExamples: {}, legacyReferences: { signExamples: {}, motionExamples: {} }, exampleOrder: { signExamples: {}, motionExamples: {} }, pendingExamples: {} };
    for (const [bank, isValid, clone, isApproved] of [['signExamples', storedStaticExample, copyStaticExample, approvedStaticExample], ['motionExamples', storedMotionExample, copyMotionExample, approvedMotionExample]]) {
      for (const [label, examples] of Object.entries(profile[bank] ?? {})) {
        if (!(bank === 'signExamples' ? validStaticLabel(label) : MOTION_LABELS.includes(label)) || !Array.isArray(examples)) continue;
        const valid = retainExamples(examples.filter(isValid), []);
        backup[bank][label] = valid.filter(isApproved).map(clone);
        backup.legacyReferences[bank][label] = valid.filter(example => !isApproved(example)).map(clone);
        backup.exampleOrder[bank][label] = valid.map(example => isApproved(example) ? 'approved' : 'legacy');
      }
    }
    for (const [label, pending] of Object.entries(profile.pendingExamples ?? {})) if (validPendingExample(label, pending)) backup.pendingExamples[label] = copyPendingExample(pending);
    return backup;
  }
  importTraining(name, payload) {
    if (!isRecord(payload) || payload.version !== 1 || payload.kind !== 'libras-training') throw new Error('Backup de treinamento incompatível.');
    const signs = payload.signExamples ?? {}, motions = payload.motionExamples ?? {};
    const legacy = payload.legacyReferences ?? {};
    if (!isRecord(legacy)) throw new Error('Referências anteriores inválidas.');
    validateTrainingBank(signs, validStaticLabel, approvedStaticExample);
    validateTrainingBank(motions, label => MOTION_LABELS.includes(label), approvedMotionExample);
    validateTrainingBank(legacy.signExamples ?? {}, validStaticLabel, legacyStaticExample);
    validateTrainingBank(legacy.motionExamples ?? {}, label => MOTION_LABELS.includes(label), legacyMotionExample);
    const pending = payload.pendingExamples ?? {};
    if (!isRecord(pending) || Object.entries(pending).some(([label, example]) => !validPendingExample(label, example))) throw new Error('Referências provisórias inválidas no backup.');
    const order = payload.exampleOrder ?? {};
    if (!isRecord(order) || Object.keys(order).some(bank => !['signExamples', 'motionExamples'].includes(bank))) throw new Error('Ordem dos exemplos no backup inválida.');
    const profile = this.requireProfile(name);
    for (const [bank, incoming, isValid, clone] of [['signExamples', signs, storedStaticExample, copyStaticExample], ['motionExamples', motions, storedMotionExample, copyMotionExample]]) {
      const previousLegacy = legacy[bank] ?? {};
      if (order[bank] !== undefined && (!isRecord(order[bank]) || Object.keys(order[bank]).some(label => !Object.hasOwn(incoming, label) && !Object.hasOwn(previousLegacy, label)))) throw new Error('Ordem dos exemplos no backup inválida.');
      if (!isRecord(profile[bank])) profile[bank] = {};
      for (const label of new Set([...Object.keys(incoming), ...Object.keys(previousLegacy)])) {
        const approved = incoming[label] ?? [], unscored = previousLegacy[label] ?? [];
        if (approved.length + unscored.length > EXAMPLE_LIMIT) throw new Error('O backup excede 30 exemplos na mesma classe.');
        const ordered = restoreExampleOrder(approved, unscored, order[bank]?.[label]);
        let retained = Array.isArray(profile[bank][label]) ? profile[bank][label].filter(isValid) : [];
        for (const example of ordered) {
          const copy = clone(example);
          retained = validExampleConfidence(copy?.confidenceProbability) ? retainExamples(retained, [copy]) : retainExamples([...retained, copy], []);
        }
        profile[bank][label] = retained;
        if (approved.length && isRecord(profile.pendingExamples)) delete profile.pendingExamples[label];
      }
    }
    if (Object.keys(pending).length) profile.pendingExamples = { ...(isRecord(profile.pendingExamples) ? profile.pendingExamples : {}), ...Object.fromEntries(Object.entries(pending).map(([label, example]) => [label, copyPendingExample(example)])) };
    this.write(profile); // Validate everything before this single atomic write.
    return profile;
  }
}
