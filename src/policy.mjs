export function chunkCandidates(candidates, maxChoices) {
  if (!Number.isInteger(maxChoices) || maxChoices < 2 || maxChoices > 254) {
    throw new Error('maxChoices must be an integer between 2 and 254.');
  }

  const chunks = [];
  for (let index = 0; index < candidates.length; index += maxChoices) {
    chunks.push(candidates.slice(index, index + maxChoices));
  }
  return chunks;
}

export function conservativePathConfidence(...values) {
  const finite = values.filter(
    (value) => typeof value === 'number' && Number.isFinite(value),
  );
  return finite.length === 0 ? 0 : Math.min(...finite);
}

export function shouldSelect(confidence, threshold) {
  return (
    typeof confidence === 'number' &&
    Number.isFinite(confidence) &&
    confidence >= threshold
  );
}
