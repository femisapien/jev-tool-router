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

export function estimateSerializedTokens(value) {
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  return bytes;
}

export function estimateEvaluationBudgetUsage(
  state,
  questions,
) {
  const entries = Object.entries(questions ?? {});
  const totalTokens = estimateSerializedTokens(
    { state, questions },
  );
  const stateQuestionTokens =
    entries.length === 0
      ? estimateSerializedTokens({ state })
      : Math.max(
          ...entries.map(([id, question]) =>
            estimateSerializedTokens(
              {
                state,
                questions: {
                  [id]: question,
                },
              },
            ),
          ),
        );

  return {
    totalTokens,
    stateQuestionTokens,
  };
}

export function truncateTextToEstimatedTokens(
  text,
  maxTokens,
  {
    suffix = '\n[truncated for Jev routing context budget]',
  } = {},
) {
  if (!Number.isInteger(maxTokens) || maxTokens < 0) {
    throw new Error('maxTokens must be a non-negative integer.');
  }

  const value = String(text ?? '');
  const originalEstimatedTokens = estimateSerializedTokens(value);
  if (originalEstimatedTokens <= maxTokens) {
    return {
      text: value,
      truncated: false,
      originalEstimatedTokens,
      usedEstimatedTokens: originalEstimatedTokens,
    };
  }

  if (maxTokens === 0) {
    return {
      text: '',
      truncated: value.length > 0,
      originalEstimatedTokens,
      usedEstimatedTokens: 0,
    };
  }

  const suffixValue = String(suffix);
  let low = 0;
  let high = value.length;
  let best = '';

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate =
      value.slice(0, middle).trimEnd() + suffixValue;
    const estimated = estimateSerializedTokens(candidate);

    if (estimated <= maxTokens) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (!best) {
    const suffixOnly = truncateTextToEstimatedTokens(
      suffixValue,
      maxTokens,
      { suffix: '' },
    );
    best = suffixOnly.text;
  }

  return {
    text: best,
    truncated: true,
    originalEstimatedTokens,
    usedEstimatedTokens: estimateSerializedTokens(best),
  };
}

export function chunkByConstraints(
  items,
  {
    maxItems,
    fits,
  },
) {
  if (!Number.isInteger(maxItems) || maxItems < 1) {
    throw new Error('maxItems must be a positive integer.');
  }
  if (typeof fits !== 'function') {
    throw new Error('fits must be a function.');
  }

  const chunks = [];
  let current = [];

  for (const item of items) {
    const candidate = [...current, item];
    if (
      current.length > 0 &&
      (candidate.length > maxItems || !fits(candidate))
    ) {
      chunks.push(current);
      current = [item];
    } else {
      current = candidate;
    }

    if (!fits(current)) {
      throw new Error(
        'A single item exceeds the configured evaluation budget.',
      );
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

export function tournamentMadeProgress(
  candidateCount,
  winnerCount,
) {
  if (
    !Number.isInteger(candidateCount) ||
    candidateCount < 0 ||
    !Number.isInteger(winnerCount) ||
    winnerCount < 0
  ) {
    throw new Error(
      'Tournament counts must be non-negative integers.',
    );
  }

  return candidateCount <= 1 || winnerCount < candidateCount;
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
