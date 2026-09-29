import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ProfileStore } from '../js/storage.js';

const file = new URL('../dataset_libras.csv', import.meta.url);
const COORDINATES = Array.from({ length: 63 }, (_, index) => String(index));
const BASE_HEADER = [...COORDINATES, 'label'];
const EXTRA_HEADER = ['record_type', 'profile', 'confidence', 'captured_at', 'comparison_source', 'payload_json'];
const HEADER = [...BASE_HEADER, ...EXTRA_HEADER];
const EMPTY_COORDINATES = Array(63).fill('');
const emptyBackup = () => ({ version: 1, kind: 'libras-training', signExamples: {}, motionExamples: {}, legacyReferences: { signExamples: {}, motionExamples: {} }, exampleOrder: { signExamples: {}, motionExamples: {} }, pendingExamples: {} });

function parseCsv(source) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') { field += '"'; index++; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"' && !field) quoted = true;
    else if (character === ',') { row.push(field); field = ''; }
    else if (character === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (character !== '\r') field += character;
  }
  if (quoted) throw new Error('CSV contém campo sem fechamento.');
  if (row.length || field) { row.push(field); rows.push(row); }
  return rows;
}
const cell = value => {
  const string = String(value ?? '');
  return /[",\r\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
};
const serializeCsv = rows => rows.map(row => row.map(cell).join(',')).join('\n') + '\n';

async function loadRows(csvFile = file) {
  const rows = parseCsv(await readFile(csvFile, 'utf8'));
  if (!rows.length || BASE_HEADER.some((value, index) => rows[0][index] !== value) || (rows[0].length !== 64 && rows[0].join(',') !== HEADER.join(','))) throw new Error('Cabeçalho de dataset_libras.csv incompatível.');
  for (const row of rows.slice(1)) if (row.length !== 64 && row.length !== HEADER.length) throw new Error('Linha inválida em dataset_libras.csv.');
  return rows;
}

function restoreTraining(rows, profileName) {
  const backup = emptyBackup();
  for (const row of rows.slice(1)) {
    const [type, profile, confidence, capturedAt, comparisonSource, payload] = row.slice(64);
    if (profile !== profileName || !type) continue;
    const label = row[63];
    if (type === 'pending-static' || type === 'pending-motion') {
      backup.pendingExamples[label] = JSON.parse(payload);
      continue;
    }
    const bank = type.endsWith('static') ? 'signExamples' : 'motionExamples';
    const legacy = type.startsWith('legacy-');
    const records = legacy ? backup.legacyReferences[bank] : backup[bank];
    const order = backup.exampleOrder[bank];
    records[label] ??= []; order[label] ??= [];
    let record = bank === 'signExamples' ? row.slice(0, 63).map(Number) : JSON.parse(payload);
    if (!legacy) {
      const metadata = { confidenceProbability: Number(confidence), capturedAt: Number(capturedAt), comparisonSource };
      record = bank === 'signExamples' ? { features: record, ...metadata } : { ...record, ...metadata };
    }
    records[label].push(record); order[label].push(legacy ? 'legacy' : 'approved');
  }
  return backup;
}

function validateBackup(profileName, backup) {
  const data = new Map();
  const memory = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const store = new ProfileStore(memory);
  store.login(profileName);
  store.importTraining(profileName, backup);
  return store.exportTraining(profileName);
}

function rowsForTraining(profileName, backup) {
  const rows = [];
  const append = (label, type, example, metadata = null) => rows.push([
    ...(type.endsWith('static') && !type.startsWith('pending-') ? (Array.isArray(example) ? example : example.features) : EMPTY_COORDINATES),
    label, type, profileName, metadata?.confidenceProbability ?? '', metadata?.capturedAt ?? '', metadata?.comparisonSource ?? '',
    type.endsWith('static') && !type.startsWith('pending-') ? '' : JSON.stringify(example),
  ]);
  for (const [bank, approvedType, legacyType] of [['signExamples', 'static', 'legacy-static'], ['motionExamples', 'motion', 'legacy-motion']]) {
    const labels = new Set([...Object.keys(backup[bank]), ...Object.keys(backup.legacyReferences[bank])]);
    for (const label of labels) {
      const approved = backup[bank][label] ?? [], legacy = backup.legacyReferences[bank][label] ?? [];
      const order = backup.exampleOrder[bank][label] ?? [...legacy.map(() => 'legacy'), ...approved.map(() => 'approved')];
      let approvedIndex = 0, legacyIndex = 0;
      for (const value of order) value === 'legacy'
        ? append(label, legacyType, legacy[legacyIndex++])
        : append(label, approvedType, approved[approvedIndex++], approved[approvedIndex - 1]);
    }
  }
  for (const [label, pending] of Object.entries(backup.pendingExamples)) append(label, `pending-${pending.kind}`, pending);
  return rows;
}

/** The existing 137 reference rows remain unchanged in meaning. Each new
 * capture is one CSV row; motion trajectories and provisional captures live
 * in payload_json. Profile names and confidence live in explicit columns.
 */
export async function readTraining(profileName, csvFile = file) {
  return validateBackup(profileName, restoreTraining(await loadRows(csvFile), profileName));
}

let pendingWrite = Promise.resolve();
export function writeTraining(profileName, backup, csvFile = file) {
  const task = pendingWrite.catch(() => {}).then(async () => {
    const normalized = new ProfileStore({ getItem: () => null }).normalize(profileName);
    const accepted = validateBackup(normalized, backup);
    const rows = await loadRows(csvFile);
    const previous = rows.slice(1).filter(row => row[65] !== normalized).map(row => [...row, ...Array(Math.max(0, HEADER.length - row.length)).fill('')]);
    const content = serializeCsv([HEADER, ...previous, ...rowsForTraining(normalized, accepted)]);
    const temporary = new URL(`./.dataset_libras.${randomUUID()}.tmp`, csvFile);
    try { await writeFile(temporary, content, { flag: 'wx' }); await rename(temporary, csvFile); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    return accepted;
  });
  pendingWrite = task;
  return task;
}
