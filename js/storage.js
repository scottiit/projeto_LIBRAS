import { MOTION_VERSION, MOTION_LABELS, MOTION_LIMIT, validMotionClip } from './dynamic.js';
import { DYNAMIC_CLASSES } from './trajectory.js';
const PREFIX = 'libras:v1:profile:';
const validTime = value => Number.isFinite(value) && value > 0;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
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
    return profile;
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
  write(profile) { this.storage.setItem(this.key(profile.name), JSON.stringify(profile)); }
  login(name) {
    const profile = this.read(name) ?? { version: 1, name: this.normalize(name), createdAt: Date.now(), accessHistory: [], bestTimes: {}, demoBestTimes: {}, settings: { simulation: false } };
    // One-time migration: old profiles defaulted to mock mode. Keep their scores.
    if (profile.settings.recognizerVersion !== 1) {
      profile.settings.simulation = false;
      profile.settings.recognizerVersion = 1;
    }
    profile.accessHistory.push(Date.now());
    this.write(profile);
    return profile;
  }
  saveSettings(name, settings) {
    const profile = this.read(name);
    if (!profile) throw new Error('Perfil não encontrado.');
    profile.settings = { ...profile.settings, simulation: Boolean(settings.simulation) };
    this.write(profile);
    return profile;
  }
  saveExamples(name, label, samples) {
    if (!/^[A-Z0-9]$/.test(label) || DYNAMIC_CLASSES.has(label) || !Array.isArray(samples) || !samples.length || samples.length > 12 || samples.some(sample => !Array.isArray(sample) || sample.length !== 63 || !sample.every(value => Number.isFinite(value) && Math.abs(value) <= 20))) throw new Error('Exemplos de sinal inválidos.');
    const profile = this.read(name);
    if (!profile) throw new Error('Perfil não encontrado.');
    if (!isRecord(profile.signExamples)) profile.signExamples = {};
    const previous = Array.isArray(profile.signExamples[label]) ? profile.signExamples[label] : [];
    profile.signExamples[label] = [...previous, ...samples].slice(-12);
    this.write(profile);
    return profile;
  }
  saveScore(name, mode, elapsed, simulated = false) {
    if (!validTime(elapsed)) throw new Error('Tempo inválido.');
    const profile = this.read(name);
    if (!profile) throw new Error('Perfil não encontrado.');
    const records = simulated ? profile.demoBestTimes : profile.bestTimes;
    const previous = Object.hasOwn(records, mode) ? records[mode] : undefined;
    const improved = !validTime(previous) || elapsed < previous;
    if (improved) {
      records[mode] = elapsed;
      this.write(profile);
    }
    return { profile, improved, best: improved ? elapsed : previous };
  }
  saveMotion(name, label, clip) {
    return this.importMotion(name, { version: MOTION_VERSION, examples: { [label]: [clip] } });
  }
  importMotion(name, payload) {
    if (![1, MOTION_VERSION].includes(payload?.version) || !isRecord(payload.examples) || !Object.keys(payload.examples).length || Object.keys(payload.examples).some(label => !MOTION_LABELS.includes(label)) ||
      Object.values(payload.examples).some(clips => !Array.isArray(clips) || clips.length > MOTION_LIMIT || !clips.every(clip => validMotionClip(clip) && clip.version <= payload.version))) throw new Error('Arquivo de movimentos inválido ou de versão incompatível.');
    const profile = this.read(name);
    if (!profile) throw new Error('Perfil não encontrado.');
    const examples = {};
    for (const label of MOTION_LABELS) {
      const previous = Array.isArray(profile.motionExamples?.[label]) ? profile.motionExamples[label].filter(validMotionClip) : [];
      examples[label] = [...previous, ...(payload.examples[label] ?? [])].slice(-MOTION_LIMIT).map(clip => ({ version: clip.version, durationMs: clip.durationMs, frames: clip.frames.map(frame => [...frame]) }));
    }
    profile.motionExamples = examples;
    this.write(profile); // One write: quota failure cannot leave a partial import.
    return profile;
  }
  removeLastMotion(name, label) {
    if (!MOTION_LABELS.includes(label)) throw new Error('Classe dinâmica inválida.');
    const profile = this.read(name);
    if (!profile) throw new Error('Perfil não encontrado.');
    if (Array.isArray(profile.motionExamples?.[label])) profile.motionExamples[label].pop();
    this.write(profile);
    return profile;
  }
}
