/** Maximum stored examples for one class within one profile. */
export const EXAMPLE_LIMIT = 30;

/** The lower boundary is exclusive: 0.85 itself cannot be saved. */
export const MIN_EXAMPLE_CONFIDENCE = 0.85;

const BUCKET_NAMES = ['85-90', '90-95', '95-100'];
const MIN_BUCKET_EXAMPLES = 2;

/** Reject missing, coerced, non-finite and out-of-range similarity scores. */
export function validExampleConfidence(value) {
  return Number.isFinite(value) && value > MIN_EXAMPLE_CONFIDENCE && value <= 1;
}

/**
 * Return the disjoint similarity band, or null for an unscored legacy record.
 * Bands are (0.85, 0.90], (0.90, 0.95] and (0.95, 1.00].
 */
export function confidenceBucket(value) {
  if (!validExampleConfidence(value)) return null;
  if (value <= 0.90) return '85-90';
  if (value <= 0.95) return '90-95';
  return '95-100';
}

/**
 * Summarize actual coverage without inventing scores or missing anchors.
 * `protected` is the number of representatives guaranteed in a band, not a
 * permanent designation on particular records. Once a band has >2 members,
 * its oldest record can leave the queue again.
 *
 * @returns {{ total: number, unscored: number, buckets: Object<string,
 *   { count: number, protected: number, missing: number }> }}
 */
export function summarizeExamples(records) {
  if (!Array.isArray(records)) throw new TypeError('Examples must be an array.');
  const buckets = Object.fromEntries(BUCKET_NAMES.map(name => [name, {
    count: 0, protected: 0, missing: MIN_BUCKET_EXAMPLES,
  }]));
  let unscored = 0;
  for (const record of records) {
    const bucket = confidenceBucket(record?.confidenceProbability);
    if (bucket) buckets[bucket].count++;
    else unscored++;
  }
  for (const bucket of Object.values(buckets)) {
    bucket.protected = Math.min(bucket.count, MIN_BUCKET_EXAMPLES);
    bucket.missing = Math.max(0, MIN_BUCKET_EXAMPLES - bucket.count);
  }
  return { total: records.length, unscored, buckets };
}

/**
 * Append accepted examples with stratified FIFO eviction. The array order is
 * authoritative; client-provided timestamps never change insertion order.
 *
 * After each append, delete the oldest record whose removal preserves up to
 * two surviving examples per populated band. A third member in a band frees
 * its oldest member for eviction. Legacy records with absent/invalid scores
 * are kept until ordinary FIFO eviction, without receiving protected slots.
 *
 * A batch is processed exactly like individual saves in the supplied order.
 * Empty batches can also compact an oversized legacy queue. Missing bands
 * leave capacity available to other bands; their examples cannot be invented.
 * Inputs and record objects are never mutated; shallow references are kept.
 *
 * @param {Array<object>} previous Previously stored examples for one class.
 * @param {object|Array<object>} incoming One example or an ordered batch.
 * @returns {Array<object>} The retained examples, oldest insertion first.
 * @throws {RangeError} If any incoming confidence is not finite and in (.85, 1].
 */
export function retainExamples(previous, incoming) {
  if (!Array.isArray(previous)) throw new TypeError('Previous examples must be an array.');
  const batch = Array.isArray(incoming) ? incoming : [incoming];
  for (const example of batch) {
    if (!validExampleConfidence(example?.confidenceProbability)) {
      throw new RangeError('Example confidenceProbability must be greater than 0.85 and at most 1.');
    }
  }

  const retained = [...previous];
  const trimOverflow = () => {
    while (retained.length > EXAMPLE_LIMIT) {
      const { buckets } = summarizeExamples(retained);
      const removableIndex = retained.findIndex(example => {
        const bucket = confidenceBucket(example?.confidenceProbability);
        return bucket === null || buckets[bucket].count > MIN_BUCKET_EXAMPLES;
      });
      // Only six representatives can be protected, so overflow above 30 must
      // always contain a removable example. Fail clearly if policy changes.
      if (removableIndex < 0) throw new Error('Example limit is smaller than protected coverage.');
      retained.splice(removableIndex, 1);
    }
  };
  for (const example of batch) {
    retained.push(example);
    trimOverflow();
  }
  trimOverflow();
  return retained;
}
