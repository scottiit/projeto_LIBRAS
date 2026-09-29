import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXAMPLE_LIMIT, MIN_EXAMPLE_CONFIDENCE, validExampleConfidence,
  confidenceBucket, retainExamples, summarizeExamples,
} from '../js/example-policy.js';

const example = (id, confidenceProbability = 0.98) => ({ id, confidenceProbability });
const examples = (count, confidence = 0.98, prefix = 'example') =>
  Array.from({ length: count }, (_, index) => example(`${prefix}-${index}`, confidence));
const ids = records => records.map(record => record.id);

test('quality filter and disjoint bands include only finite scores strictly above 85%', () => {
  assert.equal(EXAMPLE_LIMIT, 30);
  assert.equal(MIN_EXAMPLE_CONFIDENCE, 0.85);
  for (const value of [undefined, null, '0.99', true, NaN, Infinity, -Infinity, -1, 0, 0.85, 1.01]) {
    assert.equal(validExampleConfidence(value), false, `Reject ${value}`);
    assert.equal(confidenceBucket(value), null);
  }
  for (const [value, expected] of [
    [0.850001, '85-90'], [0.9, '85-90'], [0.900001, '90-95'],
    [0.95, '90-95'], [0.950001, '95-100'], [1, '95-100'],
  ]) {
    assert.equal(validExampleConfidence(value), true);
    assert.equal(confidenceBucket(value), expected);
  }
});

test('invalid incoming records are rejected without changing the existing dataset', () => {
  const previous = Object.freeze([Object.freeze(example('existing'))]);
  for (const confidence of [0.85, NaN, Infinity, 1.1, undefined]) {
    assert.throws(() => retainExamples(previous, { id: 'bad', confidenceProbability: confidence }), RangeError);
  }
  for (const incoming of [null, undefined, {}, 'example']) {
    assert.throws(() => retainExamples(previous, incoming), RangeError);
  }
  assert.throws(() => retainExamples(previous, [example('accepted'), example('bad', 0.7)]), RangeError);
  assert.deepEqual(ids(previous), ['existing']);
});

test('ordinary FIFO removes the oldest insertion when all examples share one band', () => {
  const previous = examples(30);
  const retained = retainExamples(previous, example('new'));
  assert.equal(retained.length, 30);
  assert.deepEqual(ids(retained), [...ids(previous).slice(1), 'new']);
  assert.deepEqual(summarizeExamples(retained).buckets['85-90'], { count: 0, protected: 0, missing: 2 });
});

test('FIFO skips the two remaining anchors in each minority band', () => {
  const anchors = [example('low-1', 0.9), example('middle-1', 0.95),
    example('low-2', 0.88), example('middle-2', 0.93)];
  const previous = [...anchors, ...examples(26)];
  const retained = retainExamples(previous, example('new'));
  assert.deepEqual(ids(retained), [...ids(anchors), ...ids(previous).slice(5), 'new']);
  assert.equal(retained.includes(previous[4]), false);
  const { buckets } = summarizeExamples(retained);
  assert.equal(buckets['85-90'].count, 2);
  assert.equal(buckets['90-95'].count, 2);
  assert.equal(buckets['95-100'].count, 26);
});

test('an appended example can free the oldest member of its own band', () => {
  const previous = [example('oldest-low', 0.86), example('last-low', 0.9), ...examples(28)];
  const retained = retainExamples(previous, example('new-low', 0.88));
  assert.deepEqual(ids(retained), [...ids(previous).slice(1), 'new-low']);
  assert.equal(summarizeExamples(retained).buckets['85-90'].count, 2);
});

test('missing anchors are reported honestly and a lone existing anchor stays protected', () => {
  const previous = [example('only-low', 0.9), ...examples(29)];
  const retained = retainExamples(previous, example('new'));
  assert.deepEqual(ids(retained), ['only-low', ...ids(previous).slice(2), 'new']);
  assert.deepEqual(summarizeExamples(retained), {
    total: 30, unscored: 0,
    buckets: {
      '85-90': { count: 1, protected: 1, missing: 1 },
      '90-95': { count: 0, protected: 0, missing: 2 },
      '95-100': { count: 29, protected: 2, missing: 0 },
    },
  });
});

test('legacy examples keep their data but have no fabricated quality or protected quota', () => {
  const legacy = Object.freeze({ id: 'legacy', vector: Object.freeze([1, 2, 3]) });
  const retained = retainExamples([legacy], example('new', 0.9));
  assert.equal(retained[0], legacy);
  assert.equal(Object.hasOwn(legacy, 'confidenceProbability'), false);
  assert.equal(summarizeExamples(retained).unscored, 1);

  const previous = [example('anchor', 0.9), legacy, ...examples(28)];
  const full = retainExamples(previous, example('newest'));
  assert.deepEqual(ids(full), ['anchor', ...ids(previous).slice(2), 'newest']);
  assert.equal(full.includes(legacy), false);
});

test('batch saves equal sequential saves, preserve order and never mutate frozen inputs', () => {
  const previous = Object.freeze([
    Object.freeze(example('first', 0.9)),
    Object.freeze(example('second', 0.95)),
    ...examples(28).map(Object.freeze),
  ]);
  const incoming = Object.freeze([
    Object.freeze(example('low-next', 0.88)),
    Object.freeze(example('middle-next', 0.93)),
    ...examples(35, 0.98, 'new').map(Object.freeze),
    Object.freeze(example('low-last', 0.86)),
  ]);
  const batched = retainExamples(previous, incoming);
  const sequential = incoming.reduce((records, item) => retainExamples(records, item), previous);
  assert.deepEqual(batched, sequential);
  assert.equal(batched.length, 30);
  assert.deepEqual(ids(previous).slice(0, 3), ['first', 'second', 'example-0']);
  assert.equal(incoming.length, 38);
  assert.notEqual(batched, previous);
  assert.equal(batched.at(-1), incoming.at(-1));
  assert.equal(summarizeExamples(batched).buckets['85-90'].count, 2);
  assert.equal(summarizeExamples(batched).buckets['90-95'].count, 2);
});

test('client timestamps never reorder FIFO and empty batches can trim legacy overflow', () => {
  const previous = examples(30).map((record, index) => ({ ...record, timestamp: 100 - index }));
  const retained = retainExamples(previous, { ...example('new'), timestamp: -1000 });
  assert.deepEqual(ids(retained), [...ids(previous).slice(1), 'new']);
  const oversized = [example('anchor', 0.9), ...examples(50)];
  const compacted = retainExamples(oversized, []);
  assert.deepEqual(ids(compacted), ['anchor', ...ids(oversized).slice(-29)]);
  assert.deepEqual(retainExamples([], []), []);
  assert.deepEqual(summarizeExamples([]), {
    total: 0, unscored: 0,
    buckets: {
      '85-90': { count: 0, protected: 0, missing: 2 },
      '90-95': { count: 0, protected: 0, missing: 2 },
      '95-100': { count: 0, protected: 0, missing: 2 },
    },
  });
  assert.throws(() => retainExamples(null, example('new')), TypeError);
  assert.throws(() => summarizeExamples(null), TypeError);
});
