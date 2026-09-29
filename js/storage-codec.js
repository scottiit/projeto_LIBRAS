// Compact legacy/browser-in-memory coordinates. CSV backups use ordinary arrays.
const COORDINATE_ENCODING = 'float32-le-base64';

function packCoordinates(rows, columns) {
  const bytes = new Uint8Array(rows.length * columns * 4);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== columns) throw new Error('Dimensões de coordenadas inválidas.');
    for (const value of row) {
      if (!Number.isFinite(value) || Math.abs(value) > 20) throw new Error('Coordenadas inválidas.');
      view.setFloat32(offset, value, true); offset += 4;
    }
  }
  return { encoding: COORDINATE_ENCODING, rows: rows.length, columns, data: btoa(String.fromCharCode(...bytes)) };
}

function unpackCoordinates(value, columns, expectedRows) {
  if (Array.isArray(value)) return value;
  if (!value || value.encoding !== COORDINATE_ENCODING || value.columns !== columns || !Number.isInteger(value.rows) || value.rows < 1 || value.rows > 32 || (expectedRows !== undefined && value.rows !== expectedRows) || typeof value.data !== 'string') throw new Error('Coordenadas salvas têm formato inválido.');
  const byteLength = value.rows * columns * 4;
  if (value.data.length !== 4 * Math.ceil(byteLength / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) throw new Error('Coordenadas salvas estão corrompidas.');
  const binary = atob(value.data);
  if (binary.length !== byteLength) throw new Error('Coordenadas salvas estão incompletas.');
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const rows = Array.from({ length: value.rows }, (_, row) => Array.from({ length: columns }, (_, column) => view.getFloat32((row * columns + column) * 4, true)));
  if (rows.some(row => row.some(coordinate => !Number.isFinite(coordinate) || Math.abs(coordinate) > 20))) throw new Error('Coordenadas salvas contêm valores inválidos.');
  return rows;
}

function mapStoredBank(bank, transform) {
  if (!bank || typeof bank !== 'object' || Array.isArray(bank)) return bank;
  return Object.fromEntries(Object.entries(bank).map(([label, records]) => [label, Array.isArray(records) ? records.map(transform) : records]));
}
function encodeStoredMotion(clip, provisional = false) {
  if (!clip || (!provisional && !Number.isFinite(clip.confidenceProbability))) return clip;
  return { ...clip, frames: packCoordinates(clip.frames, clip.version === 1 ? 65 : 66) };
}
function decodeStoredMotion(clip) {
  if (!clip || Array.isArray(clip.frames) || clip.frames === undefined) return clip;
  if (clip.version !== 1 && clip.version !== 2) throw new Error('Versão das coordenadas salvas incompatível.');
  return { ...clip, frames: unpackCoordinates(clip.frames, clip.version === 1 ? 65 : 66, 32) };
}

/** Float32 bounds a full 30-example collection without changing public schemas.
 * Each coordinate uses four bytes before base64, instead of long JSON doubles.
 * Only new scored records and provisional captures are encoded. Unscored legacy
 * coordinates are never silently rounded during migration.
 */
export function encodeProfileExamples(profile) {
  const encoded = { ...profile };
  if (profile.signExamples) encoded.signExamples = mapStoredBank(profile.signExamples, record => Array.isArray(record) || !Number.isFinite(record?.confidenceProbability) ? record : { ...record, features: packCoordinates([record.features], 63) });
  if (profile.motionExamples) encoded.motionExamples = mapStoredBank(profile.motionExamples, clip => encodeStoredMotion(clip));
  if (profile.pendingExamples) encoded.pendingExamples = Object.fromEntries(Object.entries(profile.pendingExamples).map(([label, pending]) => [label, pending.kind === 'static'
    ? { ...pending, samples: packCoordinates(pending.samples, 63) }
    : { ...pending, clip: encodeStoredMotion(pending.clip, true) }]));
  return encoded;
}

/** Decode a freshly parsed object; caller/runtime never sees packed vectors. */
export function decodeProfileExamples(profile) {
  const decoded = { ...profile };
  if (profile.signExamples) decoded.signExamples = mapStoredBank(profile.signExamples, record => !record || Array.isArray(record) || Array.isArray(record.features) || record.features === undefined ? record : { ...record, features: unpackCoordinates(record.features, 63, 1)[0] });
  if (profile.motionExamples) decoded.motionExamples = mapStoredBank(profile.motionExamples, decodeStoredMotion);
  if (profile.pendingExamples) decoded.pendingExamples = Object.fromEntries(Object.entries(profile.pendingExamples).map(([label, pending]) => {
    if (!pending || !['static', 'motion'].includes(pending.kind)) throw new Error('Referência provisória salva inválida.');
    return [label, pending.kind === 'static' ? { ...pending, samples: unpackCoordinates(pending.samples, 63) } : { ...pending, clip: decodeStoredMotion(pending.clip) }];
  }));
  return decoded;
}
