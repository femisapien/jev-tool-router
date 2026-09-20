import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkCandidates,
  conservativePathConfidence,
  shouldSelect,
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
