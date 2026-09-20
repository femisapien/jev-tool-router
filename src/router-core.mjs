import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { experimental_evaluate as evaluate } from 'ai';
import { loadRouterConfig } from './config.mjs';
import {
  chunkCandidates,
  conservativePathConfidence,
  shouldSelect,
} from './policy.mjs';

const config = await loadRouterConfig();
const sessions = new Map();
const connectingSessions = new Map();
let inventoryCache = null;
let inventoryTimestamp = 0;
let inventoryErrors = {};

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
      version: '0.1.0',
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
    model: config.model,
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
    unavailableServers: inventory.errors,
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

async function chooseFrom(candidates, request, context, stage) {
  const idToCandidate = new Map();
  const criteria = {
    none_of_the_above:
      'None of these tools directly supports the requested capability. Choose this when the request is unclear, unrelated, or only weakly matched.',
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

  const result = await evaluate({
    model: config.model,
    state: {
      agentRequest: request,
      context:
        context ||
        'No additional context supplied. Match only the requested capability.',
      routingStage: stage,
    },
    questions: {
      bestTool: {
        type: 'choice',
        instructions:
          'Which available tool is the best match for the capability the agent is looking for? Choose none_of_the_above when no tool directly supports the requested action. Do not infer capabilities that are not stated.',
        criteria,
      },
    },
  });

  const answer = result.answers.bestTool;
  if (answer.choice === 'none_of_the_above') {
    return {
      selected: null,
      probability: 0,
      rejectedProbability:
        answer.probabilities?.none_of_the_above ?? 1,
      model: result.response.modelId,
    };
  }

  const selected = idToCandidate.get(answer.choice) ?? null;
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
  };
}

export async function routeTool({ request, context = '' }) {
  const inventory = await refreshInventory();
  const tools = inventory.tools;

  if (tools.length === 0) {
    return {
      mode: 'fallback_full_list',
      reason: 'No routed tools are currently available.',
      confidence: 0,
      threshold: config.threshold,
      tools: [],
      unavailableServers: inventory.errors,
    };
  }

  let selected;
  let selectedProbability = 0;
  let model = config.model;
  let routingStrategy = 'single-pass';
  let stageConfidences = [];

  try {
    if (tools.length <= config.maxJevChoices) {
      const choice = await chooseFrom(
        tools,
        request,
        context,
        'single-pass',
      );
      selected = choice.selected;
      selectedProbability = choice.probability;
      model = choice.model;
      stageConfidences = [choice.probability];
    } else {
      routingStrategy = 'tournament';
      const chunks = chunkCandidates(
        tools,
        config.maxJevChoices,
      );

      const firstRound = await Promise.all(
        chunks.map(async (chunk, index) => {
          const choice = await chooseFrom(
            chunk,
            request,
            context,
            'round-1-group-' + (index + 1),
          );
          return {
            tool: choice.selected,
            pathConfidence: choice.probability,
            stageConfidence: choice.probability,
            model: choice.model,
          };
        }),
      );

      const finalists = firstRound.filter((entry) => entry.tool);
      if (finalists.length === 0) {
        selected = null;
        selectedProbability = 0;
        stageConfidences = firstRound.map(
          (entry) => entry.stageConfidence,
        );
      } else if (finalists.length === 1) {
        selected = finalists[0].tool;
        selectedProbability = finalists[0].pathConfidence;
        model = finalists[0].model;
        stageConfidences = [finalists[0].stageConfidence];
      } else {
        const finalChoice = await chooseFrom(
          finalists,
          request,
          context,
          'final-round',
        );
        const winningFinalist = finalChoice.selected;
        selected = winningFinalist?.tool ?? null;
        selectedProbability = winningFinalist
          ? conservativePathConfidence(
              winningFinalist.pathConfidence,
              finalChoice.probability,
            )
          : 0;
        model = finalChoice.model;
        stageConfidences = winningFinalist
          ? [
              winningFinalist.stageConfidence,
              finalChoice.probability,
            ]
          : [finalChoice.probability];
      }
    }
  } catch (error) {
    return {
      mode: 'fallback_full_list',
      reason:
        'Jev routing failed: ' +
        (error instanceof Error ? error.message : String(error)),
      confidence: 0,
      threshold: config.threshold,
      routingStrategy,
      tools: tools.map(compactTool),
      unavailableServers: inventory.errors,
    };
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
      tool: selected,
      model,
    };
  }

  return {
    mode: 'fallback_full_list',
    reason: selected
      ? 'Best candidate was below threshold (' +
        selectedProbability.toFixed(2) +
        ' < ' +
        config.threshold.toFixed(2) +
        ').'
      : 'Jev selected none_of_the_above.',
    confidence: selectedProbability,
    threshold: config.threshold,
    routingStrategy,
    stageConfidences,
    bestCandidate: selected ? compactTool(selected) : null,
    tools: tools.map(compactTool),
    unavailableServers: inventory.errors,
    model,
  };
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
      const fallback = await listAllTools();
      return {
        ok: false,
        fallbackRequired: true,
        error: 'Upstream MCP tool returned isError=true.',
        upstream: result,
        allTools: fallback.tools,
        unavailableServers: fallback.unavailableServers,
      };
    }

    return {
      ok: true,
      fallbackRequired: false,
      upstream: result,
    };
  } catch (error) {
    await evictSession(server);
    const fallback = await listAllTools({ force: true });
    return {
      ok: false,
      fallbackRequired: true,
      error: error instanceof Error ? error.message : String(error),
      allTools: fallback.tools,
      unavailableServers: fallback.unavailableServers,
    };
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
    const fallback = await listAllTools({ force: true });
    return {
      ok: false,
      fallbackRequired: true,
      error: error instanceof Error ? error.message : String(error),
      allTools: fallback.tools,
      unavailableServers: fallback.unavailableServers,
    };
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
