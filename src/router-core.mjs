import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { experimental_evaluate as evaluate } from 'ai';
import { loadRouterConfig } from './config.mjs';
import {
  chunkByConstraints,
  conservativePathConfidence,
  estimateEvaluationBudgetUsage,
  rankToolsByQuery,
  shouldSelect,
  tournamentMadeProgress,
  truncateTextToEstimatedTokens,
} from './policy.mjs';

const config = await loadRouterConfig();
const sessions = new Map();
const connectingSessions = new Map();
let inventoryCache = null;
let inventoryTimestamp = 0;
let inventoryErrors = {};

const NO_MATCH_DESCRIPTION =
  'None of these tools directly supports the requested capability. Choose this when the request is unclear, unrelated, or only weakly matched.';
const ROUTING_INSTRUCTIONS =
  'Which available tool is the best match for the capability the agent is looking for? Choose none_of_the_above when no tool directly supports the requested action. Do not infer capabilities that are not stated.';
const NO_ADDITIONAL_CONTEXT =
  'No additional context supplied. Match only the requested capability.';

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(label + ' timed out after ' + ms + 'ms')),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function cleanDescription(value) {
  if (!value) return 'No description provided.';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, 800);
}

function compactTool(tool) {
  return {
    server: tool.server,
    name: tool.name,
    description: tool.description,
  };
}

function compactRankedTool(entry) {
  return {
    ...compactTool(entry.tool),
    score: Number(entry.score.toFixed(4)),
  };
}

const MAX_DIAGNOSTIC_CHARS = 600;
const MAX_UNAVAILABLE_SERVERS = 20;

function sanitizeDiagnosticText(value) {
  const text = String(value ?? '')
    .slice(0, MAX_DIAGNOSTIC_CHARS * 4)
    .replace(
      /(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/giu,
      '$1[redacted]',
    )
    .replace(
      /((?:api[-_]?key|token|secret|password|passwd|bearer)\s*[:=]\s*)[^\s,;]+/giu,
      '$1[redacted]',
    )
    .replace(/\s+/gu, ' ')
    .trim();

  if (text.length <= MAX_DIAGNOSTIC_CHARS) return text;
  return text.slice(0, MAX_DIAGNOSTIC_CHARS) + '…';
}

export function summarizeUnavailableServers(
  errors,
  limit = MAX_UNAVAILABLE_SERVERS,
) {
  const entries = Object.entries(errors ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, limit)
    .map(([server, error]) => ({
      server,
      error: sanitizeDiagnosticText(error),
    }));

  return {
    count: Object.keys(errors ?? {}).length,
    shown: entries.length,
    items: entries,
  };
}

function compactUpstreamError(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return {
    isError: result?.isError === true,
    contentItemCount: content.length,
    contentTypes: [...new Set(content
      .slice(0, 20)
      .map((item) => item?.type)
      .filter(Boolean)
      .map((type) => String(type).slice(0, 40)))]
      .slice(0, 10),
    hasStructuredContent: result?.structuredContent != null,
  };
}

function assertKnownServer(server) {
  if (server && !Object.hasOwn(config.servers, server)) {
    throw new Error('Unknown routed MCP server: ' + server);
  }
}

function validateDiscoveryLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error('limit must be an integer between 1 and 50.');
  }
}

function buildEnvironment(definition) {
  const environment = {
    ...getDefaultEnvironment(),
  };

  for (const key of definition.envVars ?? []) {
    if (process.env[key] != null) {
      environment[key] = process.env[key];
    }
  }

  return environment;
}

async function evictSession(serverName) {
  const session = sessions.get(serverName);
  sessions.delete(serverName);
  if (!session) return;

  try {
    await session.client.close();
  } catch {
    try {
      await session.transport.close();
    } catch {}
  }
}

async function createServerSession(serverName) {
  const definition = config.servers[serverName];
  if (!definition) {
    throw new Error('Unknown routed MCP server: ' + serverName);
  }

  if (!definition.command) {
    throw new Error(
      'Server ' +
        serverName +
        ' has no command. URL servers should be wrapped with mcp-remote during setup.',
    );
  }

  const transport = new StdioClientTransport({
    command: definition.command,
    args: definition.args ?? [],
    cwd: definition.cwd,
    env: buildEnvironment(definition),
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {});

  const client = new Client(
    {
      name: 'jev-tool-router-' + serverName,
      version: '0.3.0',
    },
    { capabilities: {} },
  );

  try {
    await withTimeout(
      client.connect(transport),
      definition.connectTimeoutMs ?? config.connectTimeoutMs,
      'connect ' + serverName,
    );
  } catch (error) {
    try {
      await transport.close();
    } catch {}
    throw error;
  }

  const session = { client, transport };
  sessions.set(serverName, session);
  return session;
}

async function connectServer(serverName) {
  if (sessions.has(serverName)) {
    return sessions.get(serverName);
  }

  if (connectingSessions.has(serverName)) {
    return connectingSessions.get(serverName);
  }

  const pending = createServerSession(serverName).finally(() => {
    connectingSessions.delete(serverName);
  });
  connectingSessions.set(serverName, pending);
  return pending;
}

async function readServerTools(serverName) {
  const definition = config.servers[serverName];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { client } = await connectServer(serverName);
      const result = await withTimeout(
        client.listTools(),
        definition.connectTimeoutMs ?? config.connectTimeoutMs,
        'listTools ' + serverName,
      );

      const enabledTools = definition.enabledTools
        ? new Set(definition.enabledTools)
        : null;
      const disabledTools = new Set(definition.disabledTools ?? []);
      const visibleTools = (result.tools ?? []).filter((tool) => {
        if (enabledTools && !enabledTools.has(tool.name)) return false;
        if (disabledTools.has(tool.name)) return false;
        return true;
      });

      return visibleTools.map((tool) => ({
        server: serverName,
        name: tool.name,
        description: cleanDescription(tool.description),
        inputSchema: tool.inputSchema ?? {
          type: 'object',
          additionalProperties: true,
        },
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      }));
    } catch (error) {
      await evictSession(serverName);
      if (attempt === 1) throw error;
    }
  }

  return [];
}

export function getRouterSettings() {
  return {
    threshold: config.threshold,
    maxJevChoices: config.maxJevChoices,
    fallbackCandidateLimit: config.fallbackCandidateLimit,
    model: config.model,
    jevStateQuestionBudgetTokens:
      config.jevStateQuestionBudgetTokens,
    jevTotalBudgetTokens: config.jevTotalBudgetTokens,
    jevContextBudgetTokens: config.jevContextBudgetTokens,
    configPath: config.configPath,
  };
}

export async function refreshInventory({ force = false } = {}) {
  if (
    !force &&
    inventoryCache &&
    Date.now() - inventoryTimestamp < config.inventoryTtlMs
  ) {
    return {
      tools: inventoryCache,
      errors: inventoryErrors,
      cached: true,
    };
  }

  const entries = await Promise.all(
    Object.keys(config.servers).map(async (serverName) => {
      try {
        const tools = await readServerTools(serverName);
        return { serverName, tools, error: null };
      } catch (error) {
        return {
          serverName,
          tools: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  inventoryCache = entries.flatMap((entry) => entry.tools);
  inventoryErrors = Object.fromEntries(
    entries
      .filter((entry) => entry.error)
      .map((entry) => [entry.serverName, entry.error]),
  );
  inventoryTimestamp = Date.now();

  return {
    tools: inventoryCache,
    errors: inventoryErrors,
    cached: false,
  };
}

export async function listAllTools({ force = false } = {}) {
  const inventory = await refreshInventory({ force });
  return {
    tools: inventory.tools.map(compactTool),
    unavailableServers: summarizeUnavailableServers(inventory.errors),
  };
}

export async function listServers({
  cursor = 0,
  limit = 25,
  force = false,
} = {}) {
  validateDiscoveryLimit(limit);
  if (!Number.isInteger(cursor) || cursor < 0) {
    throw new Error('cursor must be a non-negative integer.');
  }
  const inventory = await refreshInventory({ force });
  const counts = new Map();
  for (const tool of inventory.tools) {
    counts.set(tool.server, (counts.get(tool.server) ?? 0) + 1);
  }

  const names = Object.keys(config.servers).sort();
  const end = Math.min(names.length, cursor + limit);

  return {
    cursor,
    limit,
    total: names.length,
    nextCursor: end < names.length ? end : null,
    servers: names
      .slice(cursor, end)
      .map((name) => ({
        name,
        toolCount: counts.get(name) ?? 0,
        available: inventory.errors[name] == null,
        ...(inventory.errors[name]
          ? { error: sanitizeDiagnosticText(inventory.errors[name]) }
          : {}),
      })),
  };
}

export async function listTools({
  server = null,
  cursor = 0,
  limit = 25,
  force = false,
} = {}) {
  assertKnownServer(server);
  validateDiscoveryLimit(limit);
  if (!Number.isInteger(cursor) || cursor < 0) {
    throw new Error('cursor must be a non-negative integer.');
  }

  const inventory = await refreshInventory({ force });
  const filtered = inventory.tools.filter(
    (tool) => !server || tool.server === server,
  );
  const end = Math.min(filtered.length, cursor + limit);

  return {
    server,
    cursor,
    limit,
    total: filtered.length,
    nextCursor: end < filtered.length ? end : null,
    tools: filtered.slice(cursor, end).map(compactTool),
    unavailableServers: summarizeUnavailableServers(inventory.errors),
  };
}

export async function searchTools({
  query,
  server = null,
  limit = config.fallbackCandidateLimit,
  force = false,
}) {
  assertKnownServer(server);
  validateDiscoveryLimit(limit);
  const inventory = await refreshInventory({ force });
  const ranked = rankToolsByQuery(inventory.tools, query, {
    server,
    limit,
  });

  return {
    server,
    limit,
    queryTerms: ranked.queryTerms,
    totalMatches: ranked.totalMatches,
    tools: ranked.results.map(compactRankedTool),
    unavailableServers: summarizeUnavailableServers(inventory.errors),
  };
}

export async function getToolSchema(server, name) {
  const inventory = await refreshInventory();
  let tool = inventory.tools.find(
    (candidate) =>
      candidate.server === server && candidate.name === name,
  );

  if (!tool) {
    const refreshed = await refreshInventory({ force: true });
    tool = refreshed.tools.find(
      (candidate) =>
        candidate.server === server && candidate.name === name,
    );
  }

  if (!tool) {
    throw new Error('Tool not found: ' + server + '/' + name);
  }

  return tool;
}

function buildEvaluationPayload(
  candidates,
  request,
  context,
  stage,
) {
  const idToCandidate = new Map();
  const criteria = {
    none_of_the_above: NO_MATCH_DESCRIPTION,
  };

  candidates.forEach((candidate, index) => {
    const id = 't' + index;
    idToCandidate.set(id, candidate);
    const tool = candidate.tool ?? candidate;
    criteria[id] =
      tool.server +
      '/' +
      tool.name +
      ' — ' +
      tool.description.slice(0, config.descriptionMaxChars);
  });

  const state = {
    agentRequest: request,
    context: context || NO_ADDITIONAL_CONTEXT,
    routingStage: stage,
  };
  const questions = {
    bestTool: {
      type: 'choice',
      instructions: ROUTING_INSTRUCTIONS,
      criteria,
    },
  };
  const estimatedBudgetUsage = estimateEvaluationBudgetUsage(
    state,
    questions,
  );

  return {
    idToCandidate,
    state,
    questions,
    estimatedTotalTokens: estimatedBudgetUsage.totalTokens,
    estimatedStateQuestionTokens:
      estimatedBudgetUsage.stateQuestionTokens,
  };
}

function prepareRoutingContext(context) {
  return truncateTextToEstimatedTokens(
    context || '',
    config.jevContextBudgetTokens,
  );
}

function chunkForEvaluation(
  candidates,
  request,
  context,
  stage,
) {
  return chunkByConstraints(candidates, {
    maxItems: config.maxJevChoices,
    fits: (group) =>
      payloadFitsJevBudget(
        buildEvaluationPayload(
          group,
          request,
          context,
          stage,
        ),
      ),
  });
}

function payloadFitsJevBudget(payload) {
  return (
    payload.estimatedStateQuestionTokens <=
      config.jevStateQuestionBudgetTokens &&
    payload.estimatedTotalTokens <= config.jevTotalBudgetTokens
  );
}

function createRoutingUsage(contextInfo) {
  return {
    jevCalls: 0,
    callsWithReportedUsage: 0,
    reportedInputTokens: 0,
    maxReportedInputTokensPerCall: 0,
    maxEstimatedTotalTokensPerCall: 0,
    maxEstimatedStateQuestionTokensPerCall: 0,
    stateQuestionBudgetTokens:
      config.jevStateQuestionBudgetTokens,
    totalBudgetTokens: config.jevTotalBudgetTokens,
    contextBudgetTokens: config.jevContextBudgetTokens,
    contextTruncated: contextInfo.truncated,
    originalContextEstimatedTokens:
      contextInfo.originalEstimatedTokens,
    usedContextEstimatedTokens:
      contextInfo.usedEstimatedTokens,
  };
}

function recordRoutingUsage(routingUsage, choice) {
  routingUsage.jevCalls += 1;
  routingUsage.maxEstimatedTotalTokensPerCall = Math.max(
    routingUsage.maxEstimatedTotalTokensPerCall,
    choice.estimatedTotalTokens ?? 0,
  );
  routingUsage.maxEstimatedStateQuestionTokensPerCall = Math.max(
    routingUsage.maxEstimatedStateQuestionTokensPerCall,
    choice.estimatedStateQuestionTokens ?? 0,
  );

  if (
    typeof choice.inputTokens === 'number' &&
    Number.isFinite(choice.inputTokens)
  ) {
    routingUsage.callsWithReportedUsage += 1;
    routingUsage.reportedInputTokens += choice.inputTokens;
    routingUsage.maxReportedInputTokensPerCall = Math.max(
      routingUsage.maxReportedInputTokensPerCall,
      choice.inputTokens,
    );
  }
}

function buildRoutingFallback({
  inventory,
  request,
  reason,
  confidence = 0,
  routingStrategy = 'single-pass',
  routingUsage = null,
  stageConfidences = [],
  bestCandidate = null,
  model = config.model,
}) {
  const ranked = rankToolsByQuery(inventory.tools, request, {
    limit: config.fallbackCandidateLimit,
  });
  const shortlist = ranked.results.map(compactRankedTool);

  return {
    mode: 'fallback_shortlist',
    reason: sanitizeDiagnosticText(reason),
    confidence,
    threshold: config.threshold,
    routingStrategy,
    ...(routingUsage ? { routingUsage } : {}),
    ...(stageConfidences.length > 0 ? { stageConfidences } : {}),
    ...(bestCandidate
      ? { bestCandidate: compactTool(bestCandidate) }
      : {}),
    shortlist,
    search: {
      strategy: 'bm25_lexical',
      limit: config.fallbackCandidateLimit,
      queryTerms: ranked.queryTerms,
      totalMatches: ranked.totalMatches,
    },
    suggestedNextAction:
      shortlist.length > 0
        ? 'Choose from this shortlist if one candidate clearly fits; otherwise call search_tools with a more specific query, then list_tools by server if needed. Use list_all_tools only as a last resort.'
        : 'No lexical match was strong enough. Call search_tools with a more specific capability query or list_servers/list_tools. Use list_all_tools only as a last resort.',
    unavailableServers: summarizeUnavailableServers(inventory.errors),
    model,
  };
}

async function buildExecutionFallback({
  server,
  name,
  error,
  force = false,
  upstream = null,
}) {
  const inventory = await refreshInventory({ force });
  const failedTool = inventory.tools.find(
    (tool) => tool.server === server && tool.name === name,
  );
  const query = failedTool
    ? name + ' ' + failedTool.description
    : name;
  const ranked = rankToolsByQuery(inventory.tools, query, {
    limit: config.fallbackCandidateLimit + 1,
  });
  const shortlist = ranked.results
    .filter(
      (entry) =>
        entry.tool.server !== server || entry.tool.name !== name,
    )
    .slice(0, config.fallbackCandidateLimit)
    .map(compactRankedTool);

  return {
    ok: false,
    fallbackRequired: true,
    error: sanitizeDiagnosticText(error),
    failedTool: { server, name },
    ...(upstream
      ? { upstreamError: compactUpstreamError(upstream) }
      : {}),
    shortlist,
    suggestedNextAction:
      'Inspect this compact shortlist or call search_tools with the intended capability. Use list_all_tools only as an explicit last resort.',
    unavailableServers: summarizeUnavailableServers(inventory.errors),
  };
}

async function chooseFrom(candidates, request, context, stage) {
  const payload = buildEvaluationPayload(
    candidates,
    request,
    context,
    stage,
  );
  if (!payloadFitsJevBudget(payload)) {
    throw new Error(
      'Estimated Jev evaluation size exceeds the configured routing budget (state + longest question: ' +
        payload.estimatedStateQuestionTokens +
        '/' +
        config.jevStateQuestionBudgetTokens +
        ', total request: ' +
        payload.estimatedTotalTokens +
        '/' +
        config.jevTotalBudgetTokens +
        ' tokens).',
    );
  }

  const result = await evaluate({
    model: config.model,
    state: payload.state,
    questions: payload.questions,
  });

  const answer = result.answers.bestTool;
  if (answer.choice === 'none_of_the_above') {
    return {
      selected: null,
      probability: 0,
      rejectedProbability:
        answer.probabilities?.none_of_the_above ?? 1,
      model: result.response.modelId,
      inputTokens: result.usage.inputTokens,
      estimatedTotalTokens: payload.estimatedTotalTokens,
      estimatedStateQuestionTokens:
        payload.estimatedStateQuestionTokens,
    };
  }

  const selected =
    payload.idToCandidate.get(answer.choice) ?? null;
  const probability =
    answer.probabilities?.[answer.choice] ??
    result.providerMetadata?.typesafe?.confidence?.bestTool ??
    0;

  return {
    selected,
    probability,
    rejectedProbability:
      answer.probabilities?.none_of_the_above ?? 0,
    model: result.response.modelId,
    inputTokens: result.usage.inputTokens,
    estimatedTotalTokens: payload.estimatedTotalTokens,
    estimatedStateQuestionTokens:
      payload.estimatedStateQuestionTokens,
  };
}

export async function routeTool({ request, context = '' }) {
  const inventory = await refreshInventory();
  const tools = inventory.tools;

  if (tools.length === 0) {
    return buildRoutingFallback({
      inventory,
      request,
      reason: 'No routed tools are currently available.',
      confidence: 0,
    });
  }

  let selected;
  let selectedProbability = 0;
  let model = config.model;
  let routingStrategy = 'single-pass';
  let stageConfidences = [];
  const contextInfo = prepareRoutingContext(context);
  const routingContext = contextInfo.text;
  const routingUsage = createRoutingUsage(contextInfo);

  try {
    const preflight = buildEvaluationPayload(
      [],
      request,
      routingContext,
      'preflight',
    );
    if (!payloadFitsJevBudget(preflight)) {
      throw new Error(
        'The routing request itself exceeds the configured Jev evaluation budget even after optional context trimming.',
      );
    }

    let round = 1;
    let candidates = tools.map((tool) => ({
      tool,
      pathConfidence: null,
      stageConfidences: [],
      model: config.model,
    }));

    while (candidates.length > 0) {
      // Size chunks against a stage label that is at least as long as any
      // concrete group label used later in this round. Previously round 1
      // was budgeted as "single-pass" but multi-chunk execution used
      // "round-1-group-N", which could push a boundary chunk a few bytes
      // over the configured Jev budget after it had already passed preflight.
      const stagePrefix =
        'round-' + round + '-group-' + candidates.length;
      const chunks = chunkForEvaluation(
        candidates,
        request,
        routingContext,
        stagePrefix,
      );

      if (round === 1 && chunks.length > 1) {
        routingStrategy = 'tournament';
      }

      const winners = (
        await Promise.all(
          chunks.map(async (chunk, index) => {
            const stage =
              chunks.length === 1 && round === 1
                ? 'single-pass'
                : 'round-' +
                  round +
                  '-group-' +
                  (index + 1);
            const choice = await chooseFrom(
              chunk,
              request,
              routingContext,
              stage,
            );
            recordRoutingUsage(routingUsage, choice);

            if (!choice.selected) {
              return null;
            }

            const previous = choice.selected.pathConfidence;
            return {
              ...choice.selected,
              pathConfidence:
                previous == null
                  ? choice.probability
                  : conservativePathConfidence(
                      previous,
                      choice.probability,
                    ),
              stageConfidences: [
                ...(choice.selected.stageConfidences ?? []),
                choice.probability,
              ],
              model: choice.model,
            };
          }),
        )
      ).filter(Boolean);

      if (winners.length === 0) {
        selected = null;
        selectedProbability = 0;
        stageConfidences = [];
        break;
      }

      if (winners.length === 1) {
        selected = winners[0].tool;
        selectedProbability = winners[0].pathConfidence ?? 0;
        model = winners[0].model;
        stageConfidences = winners[0].stageConfidences;
        break;
      }

      if (
        !tournamentMadeProgress(
          candidates.length,
          winners.length,
        )
      ) {
        throw new Error(
          'Token-aware tournament could not reduce the candidate set within the configured Jev budget.',
        );
      }

      routingStrategy = 'tournament';
      candidates = winners;
      round += 1;
    }
  } catch (error) {
    return buildRoutingFallback({
      inventory,
      request,
      reason:
        'Jev routing failed: ' +
        (error instanceof Error ? error.message : String(error)),
      confidence: 0,
      routingStrategy,
      routingUsage,
    });
  }

  if (
    selected &&
    shouldSelect(selectedProbability, config.threshold)
  ) {
    return {
      mode: 'selected',
      confidence: selectedProbability,
      threshold: config.threshold,
      routingStrategy,
      stageConfidences,
      routingUsage,
      tool: selected,
      model,
    };
  }

  return buildRoutingFallback({
    inventory,
    request,
    reason: selected
      ? 'Best candidate was below threshold (' +
        selectedProbability.toFixed(2) +
        ' < ' +
        config.threshold.toFixed(2) +
        ').'
      : 'Jev selected none_of_the_above.',
    confidence: selectedProbability,
    routingStrategy,
    routingUsage,
    stageConfidences,
    bestCandidate: selected,
    model,
  });
}

export async function callRoutedTool({
  server,
  name,
  arguments: args = {},
}) {
  try {
    await getToolSchema(server, name);
    const { client } = await connectServer(server);
    const definition = config.servers[server];
    const result = await withTimeout(
      client.callTool({
        name,
        arguments: args,
      }),
      definition.toolTimeoutMs ?? config.toolTimeoutMs,
      'callTool ' + server + '/' + name,
    );

    if (result.isError) {
      return buildExecutionFallback({
        server,
        name,
        error: 'Upstream MCP tool returned isError=true.',
        upstream: result,
      });
    }

    return {
      ok: true,
      fallbackRequired: false,
      upstream: result,
    };
  } catch (error) {
    await evictSession(server);
    return buildExecutionFallback({
      server,
      name,
      error: error instanceof Error ? error.message : String(error),
      force: true,
    });
  }
}

export async function callReadOnlyRoutedTool({
  server,
  name,
  arguments: args = {},
}) {
  try {
    const tool = await getToolSchema(server, name);
    if (tool.annotations?.readOnlyHint !== true) {
      return {
        ok: false,
        fallbackRequired: false,
        requiresMutatingCaller: true,
        error:
          'This upstream tool is not explicitly marked read-only. Use call_tool instead.',
        tool: compactTool(tool),
        annotations: tool.annotations ?? null,
      };
    }

    return callRoutedTool({ server, name, arguments: args });
  } catch (error) {
    return buildExecutionFallback({
      server,
      name,
      error: error instanceof Error ? error.message : String(error),
      force: true,
    });
  }
}

export async function closeAllSessions() {
  await Promise.allSettled([...connectingSessions.values()]);
  const closing = [];
  for (const { client, transport } of sessions.values()) {
    closing.push(
      (async () => {
        try {
          await client.close();
        } catch {
          try {
            await transport.close();
          } catch {}
        }
      })(),
    );
  }
  await Promise.allSettled(closing);
  sessions.clear();
  connectingSessions.clear();
}
