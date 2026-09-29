import { encodeProfileExamples } from './storage-codec.js';
import { ProfileStore } from './storage.js';

const EMPTY = () => ({ version: 1, kind: 'libras-training', signExamples: {}, motionExamples: {}, legacyReferences: { signExamples: {}, motionExamples: {} }, exampleOrder: { signExamples: {}, motionExamples: {} }, pendingExamples: {} });
const bankNames = ['signExamples', 'motionExamples'];

function orderedExamples(backup, bank, label) {
  const accepted = backup[bank]?.[label] ?? [], legacy = backup.legacyReferences?.[bank]?.[label] ?? [];
  let a = 0, b = 0;
  return (backup.exampleOrder?.[bank]?.[label] ?? [...legacy.map(() => 'legacy'), ...accepted.map(() => 'approved')])
    .map(value => value === 'legacy' ? legacy[b++] : accepted[a++]);
}
function trainingBanks(backup) {
  const banks = {};
  for (const bank of bankNames) {
    const labels = new Set([...Object.keys(backup[bank] ?? {}), ...Object.keys(backup.legacyReferences?.[bank] ?? {})]);
    banks[bank] = Object.fromEntries([...labels].map(label => [label, orderedExamples(backup, bank, label)]));
  }
  banks.pendingExamples = backup.pendingExamples ?? {};
  return banks;
}
const hasTraining = backup => bankNames.some(bank => Object.values(backup[bank] ?? {}).some(examples => examples.length) || Object.values(backup.legacyReferences?.[bank] ?? {}).some(examples => examples.length)) || Object.keys(backup.pendingExamples ?? {}).length > 0;

/** file:// and HTTP have distinct browser storage. The file-page exporter
 * contains training fields only; reconstruct metadata solely for validation. */
export function trainingFromBrowserProfiles(payload, profileName) {
  if (payload?.version !== 1 || payload.kind !== 'libras-browser-profiles' || !Array.isArray(payload.profiles)) throw new Error('Exportação de perfis antigos inválida.');
  const validator = new ProfileStore({ getItem: () => null });
  const match = payload.profiles.find(item => item && typeof item.name === 'string' && validator.key(item.name) === validator.key(profileName));
  if (!match) throw new Error(`O arquivo não contém exemplos do perfil ${profileName}. Abra o mesmo nome de perfil e importe novamente.`);
  const raw = JSON.stringify({ version: 1, name: match.name, accessHistory: [], bestTimes: {}, demoBestTimes: {}, settings: {}, signExamples: match.signExamples, motionExamples: match.motionExamples, pendingExamples: match.pendingExamples });
  const store = new ProfileStore({ getItem: key => key === validator.key(match.name) ? raw : null });
  return store.exportTraining(match.name);
}

/** Existing profiles, scores and preferences remain local. Training banks only
 * live in memory here; browser localStorage receives metadata without them.
 */
export class SplitProfileStorage {
  constructor(browserStorage) { this.browserStorage = browserStorage; this.training = new Map(); }
  get length() { return this.browserStorage.length; }
  key(index) { return this.browserStorage.key(index); }
  getItem(key) {
    const raw = this.browserStorage.getItem(key);
    if (raw === null) return null;
    const banks = this.training.get(key);
    return banks ? JSON.stringify({ ...JSON.parse(raw), ...banks }) : raw;
  }
  setItem(key, value) {
    const profile = JSON.parse(value);
    const { signExamples, motionExamples, pendingExamples, ...metadata } = profile;
    this.browserStorage.setItem(key, JSON.stringify(metadata));
    this.training.set(key, { signExamples, motionExamples, pendingExamples });
  }
  seed(name, backup) {
    const key = new ProfileStore(this).key(name);
    this.training.set(key, encodeProfileExamples(trainingBanks(backup)));
  }
}

async function request(url, options) {
  let response;
  try { response = await fetch(url, { cache: 'no-store', ...options }); }
  catch { throw new Error('Não foi possível acessar o servidor do projeto. Execute npm start e abra http://127.0.0.1:5173.'); }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Falha HTTP ${response.status} ao acessar dataset_libras.csv.`);
  return payload;
}

/** Merge legacy browser examples once, deduplicated against CSV rows. */
function missingFromCsv(previous, csv) {
  const missing = EMPTY();
  for (const bank of bankNames) {
    const labels = new Set([...Object.keys(previous[bank] ?? {}), ...Object.keys(previous.legacyReferences?.[bank] ?? {})]);
    for (const label of labels) {
      const existing = new Set(orderedExamples(csv, bank, label).map(example => JSON.stringify(example)));
      const accepted = previous[bank]?.[label] ?? [], legacy = previous.legacyReferences?.[bank]?.[label] ?? [];
      let a = 0, b = 0;
      for (const value of previous.exampleOrder?.[bank]?.[label] ?? [...legacy.map(() => 'legacy'), ...accepted.map(() => 'approved')]) {
        const example = value === 'legacy' ? legacy[b++] : accepted[a++];
        const signature = JSON.stringify(example);
        if (existing.has(signature)) continue;
        existing.add(signature);
        const destination = value === 'legacy' ? missing.legacyReferences[bank] : missing[bank];
        (destination[label] ??= []).push(example);
        (missing.exampleOrder[bank][label] ??= []).push(value);
      }
    }
  }
  for (const [label, pending] of Object.entries(previous.pendingExamples ?? {})) {
    if (!csv.pendingExamples?.[label] && !csv.signExamples?.[label]?.length && !csv.motionExamples?.[label]?.length) missing.pendingExamples[label] = pending;
  }
  return missing;
}

export class CsvTrainingRepository {
  constructor(store, splitStorage, browserStorage) {
    Object.assign(this, { store, splitStorage, browserStorage });
    this.committed = new Map();
  }
  async load(name) {
    const key = this.store.key(name);
    const original = this.browserStorage.getItem(key);
    const oldProfile = original ? JSON.parse(original) : null;
    const hadBrowserTraining = Boolean(oldProfile && ('signExamples' in oldProfile || 'motionExamples' in oldProfile || 'pendingExamples' in oldProfile));
    const legacy = hadBrowserTraining
      ? new ProfileStore(this.browserStorage).exportTraining(name) : EMPTY();
    const csv = await request(`/api/training?profile=${encodeURIComponent(name)}`);
    this.splitStorage.seed(name, csv);
    this.committed.set(key, csv);
    if (hasTraining(legacy)) {
      const missing = missingFromCsv(legacy, csv);
      if (hasTraining(missing)) {
        try { this.store.importTraining(name, missing); await this.persist(name); }
        catch (error) {
          this.splitStorage.seed(name, csv);
          this.browserStorage.setItem(key, original);
          throw new Error(`Não foi possível migrar os exemplos antigos para o CSV: ${error.message}`);
        }
      } else this.store.write(this.store.read(name));
    } else if (hadBrowserTraining) this.store.write(this.store.read(name));
    return this.store.read(name);
  }
  async persist(name) {
    const key = this.store.key(name);
    const before = this.committed.get(key) ?? EMPTY();
    try {
      const accepted = await request('/api/training', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile: name, training: this.store.exportTraining(name) }) });
      this.splitStorage.seed(name, accepted);
      this.committed.set(key, accepted);
      return this.store.read(name);
    } catch (error) { this.splitStorage.seed(name, before); throw error; }
  }
}
