import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkByConstraints,
  chunkCandidates,
  conservativePathConfidence,
  estimateEvaluationBudgetUsage,
  estimateSerializedTokens,
  shouldSelect,
  tournamentMadeProgress,
  truncateTextToEstimatedTokens,
} from '../src/policy.mjs';

test('chunks inventories under the configured Jev choice limit', () => {
  const tools = Array.from({ length: 273 }, (_, index) => index);
  const chunks = chunkCandidates(tools, 200);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, 200);
  assert.equal(chunks[1].length, 73);
});

test('uses the minimum confidence across a tournament path', () => {
  assert.equal(conservativePathConfidence(0.96, 0.99), 0.96);
  assert.equal(conservativePathConfidence(0.91, 0.72), 0.72);
});

test('gates selected tools at the configured threshold', () => {
  assert.equal(shouldSelect(0.9, 0.9), true);
  assert.equal(shouldSelect(0.899, 0.9), false);
});

test('estimates serialized token usage conservatively from UTF-8 bytes', () => {
  const value = { text: 'abcd'.repeat(100) };
  const estimated = estimateSerializedTokens(value);
  assert.equal(
    estimated,
    Buffer.byteLength(JSON.stringify(value), 'utf8'),
  );
});

test('tracks both total and state-plus-longest-question budgets', () => {
  const usage = estimateEvaluationBudgetUsage(
    { context: 'state' },
    {
      short: {
        type: 'boolean',
        instructions: 'Short?',
      },
      long: {
        type: 'boolean',
        instructions: 'Long '.repeat(100),
      },
    },
  );

  assert.ok(usage.totalTokens >= usage.stateQuestionTokens);
  assert.ok(usage.stateQuestionTokens > 0);
});

test('truncates optional context to an estimated token budget', () => {
  const result = truncateTextToEstimatedTokens(
    'context '.repeat(2_000),
    100,
  );

  assert.equal(result.truncated, true);
  assert.ok(result.originalEstimatedTokens > 100);
  assert.ok(result.usedEstimatedTokens <= 100);
  assert.match(result.text, /truncated for Jev routing context budget/);
});

test('chunks by both item count and evaluation budget', () => {
  const items = ['aaaa', 'bbbb', 'cccc', 'dddd'];
  const chunks = chunkByConstraints(items, {
    maxItems: 3,
    fits: (group) =>
      group.reduce((sum, item) => sum + item.length, 0) <= 8,
  });

  assert.deepEqual(chunks, [
    ['aaaa', 'bbbb'],
    ['cccc', 'dddd'],
  ]);
});

test('fails closed when one item cannot fit the evaluation budget', () => {
  assert.throws(
    () =>
      chunkByConstraints(['too-large'], {
        maxItems: 10,
        fits: () => false,
      }),
    /single item exceeds/,
  );
});

test('detects a tournament round that cannot reduce singleton finalists', () => {
  const candidates = ['a', 'b', 'c', 'd'];
  const singletonChunks = chunkByConstraints(candidates, {
    maxItems: 10,
    fits: (group) => group.length <= 1,
  });

  assert.equal(singletonChunks.length, candidates.length);
  assert.equal(
    tournamentMadeProgress(
      candidates.length,
      singletonChunks.length,
    ),
    false,
  );
  assert.equal(tournamentMadeProgress(4, 3), true);
  assert.equal(tournamentMadeProgress(1, 1), true);
});
