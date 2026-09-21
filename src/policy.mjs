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

function canonicalSearchToken(value) {
  const token = String(value ?? '').toLowerCase();
  if (token.length > 4 && token.endsWith('ies')) {
    return token.slice(0, -3) + 'y';
  }
  if (
    token.length > 3 &&
    token.endsWith('s') &&
    !token.endsWith('ss') &&
    !token.endsWith('us') &&
    !token.endsWith('is')
  ) {
    return token.slice(0, -1);
  }
  return token;
}

export function tokenizeSearchText(value) {
  const normalized = String(value ?? '')
    .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, '$1 $2')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

  if (!normalized) return [];
  return normalized
    .split(/\s+/u)
    .map((token) => canonicalSearchToken(token).slice(0, 80))
    .filter(Boolean);
}

function countTerm(tokens, term) {
  let count = 0;
  for (const token of tokens) {
    if (token === term) count += 1;
  }
  return count;
}

function normalizedPhrase(value) {
  return tokenizeSearchText(value).join(' ');
}

export function rankToolsByQuery(
  tools,
  query,
  { limit = 12, server = null } = {},
) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('limit must be a positive integer.');
  }

  const rawQuery = String(query ?? '');
  const boundedQuery =
    rawQuery.length <= 8_000
      ? rawQuery
      : rawQuery.slice(0, 4_000) + ' ' + rawQuery.slice(-4_000);
  const queryTerms = [
    ...new Set(tokenizeSearchText(boundedQuery)),
  ].slice(0, 64);
  if (queryTerms.length === 0) {
    return {
      queryTerms,
      totalMatches: 0,
      results: [],
    };
  }

  const documents = tools
    .filter((tool) => !server || tool.server === server)
    .map((tool) => {
      const nameTokens = tokenizeSearchText(tool.name);
      const serverTokens = tokenizeSearchText(tool.server);
      const descriptionTokens = tokenizeSearchText(tool.description);
      return {
        tool,
        nameTokens,
        serverTokens,
        descriptionTokens,
        length:
          nameTokens.length +
          serverTokens.length +
          descriptionTokens.length,
      };
    });

  if (documents.length === 0) {
    return {
      queryTerms,
      totalMatches: 0,
      results: [],
    };
  }

  const averageLength =
    documents.reduce((sum, document) => sum + document.length, 0) /
    documents.length;
  const documentFrequency = new Map();
  for (const term of queryTerms) {
    const count = documents.filter((document) =>
      [
        ...document.nameTokens,
        ...document.serverTokens,
        ...document.descriptionTokens,
      ].includes(term),
    ).length;
    documentFrequency.set(term, count);
  }

  const queryPhrase = normalizedPhrase(boundedQuery).slice(0, 4_000);
  const k1 = 1.2;
  const b = 0.75;
  const scored = documents.map((document) => {
    let score = 0;
    let matchedTerms = 0;
    const lengthNormalization =
      1 -
      b +
      b *
        (document.length /
          Math.max(1, averageLength));

    for (const term of queryTerms) {
      const nameTf = countTerm(document.nameTokens, term);
      const serverTf = countTerm(document.serverTokens, term);
      const descriptionTf = countTerm(
        document.descriptionTokens,
        term,
      );
      const weightedTf =
        nameTf * 4 +
        serverTf * 2 +
        descriptionTf;
      if (weightedTf === 0) continue;

      matchedTerms += 1;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(
        1 +
          (documents.length - df + 0.5) /
            (df + 0.5),
      );
      score +=
        idf *
        ((weightedTf * (k1 + 1)) /
          (weightedTf + k1 * lengthNormalization));
    }

    const namePhrase = normalizedPhrase(document.tool.name);
    const serverPhrase = normalizedPhrase(document.tool.server);
    if (queryPhrase === namePhrase) score += 20;
    else if (
      namePhrase &&
      queryPhrase.includes(namePhrase)
    ) {
      score += 8;
    }
    if (
      serverPhrase &&
      queryPhrase.includes(serverPhrase)
    ) {
      score += 2;
    }
    if (
      matchedTerms > 0 &&
      matchedTerms === queryTerms.length
    ) {
      score += 3;
    }

    return {
      tool: document.tool,
      score,
      matchedTerms,
    };
  });

  const matches = scored
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.matchedTerms - a.matchedTerms ||
        a.tool.server.localeCompare(b.tool.server) ||
        a.tool.name.localeCompare(b.tool.name),
    );

  return {
    queryTerms,
    totalMatches: matches.length,
    results: matches.slice(0, limit),
  };
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
