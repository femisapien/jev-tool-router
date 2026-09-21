import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { experimental_evaluate as evaluate } from 'ai';
import * as z from 'zod/v4';
import {
  callReadOnlyRoutedTool,
  callRoutedTool,
  closeAllSessions,
  getRouterSettings,
  getToolSchema,
  listAllTools,
  listServers,
  listTools,
  refreshInventory,
  routeTool,
  searchTools,
  summarizeUnavailableServers,
} from './router-core.mjs';
import { estimateEvaluationBudgetUsage } from './policy.mjs';

if (!process.env.AI_GATEWAY_API_KEY) {
  throw new Error('AI_GATEWAY_API_KEY is required for the Jev tool router.');
}

const settings = getRouterSettings();

const server = new McpServer({
  name: 'jev-tool-router',
  version: '0.3.0',
});

server.registerTool(
  'find_tool',
  {
    description:
      'Use this FIRST whenever you need an external MCP capability and do not already have the exact routed tool. Jev compares the agent request against every routed tool name + description. If the winning probability reaches the configured threshold, only that tool and its full input schema are returned. Otherwise the router returns a compact ranked shortlist and discovery guidance instead of dumping the full inventory.',
    annotations: {
      title: 'Find external tool with Jev',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      request: z
        .string()
        .min(1)
        .describe('Plain-language capability the agent needs, e.g. "render the current Blender scene".'),
      context: z
        .string()
        .default('')
        .describe('Optional task context that materially disambiguates the tool need.'),
    },
  },
  async ({ request, context }) => {
    const result = await routeTool({ request, context });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  },
);

server.registerTool(
  'get_tool_schema',
  {
    description:
      'Get the full input schema for one routed tool after find_tool/search_tools/list_tools or when the exact tool is already known.',
    annotations: {
      title: 'Get routed tool schema',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      server: z.string().min(1),
      tool: z.string().min(1),
    },
  },
  async ({ server: serverName, tool }) => {
    const result = await getToolSchema(serverName, tool);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  },
);

server.registerTool(
  'search_tools',
  {
    description:
      'Search routed external tools with a compact deterministic lexical/BM25 ranking. Use this after a fallback_shortlist when the first shortlist is unclear, or whenever you want targeted discovery without exposing the full inventory.',
    annotations: {
      title: 'Search routed tools',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      query: z
        .string()
        .min(1)
        .max(4000)
        .describe('Specific capability or tool name to search for.'),
      server: z
        .string()
        .min(1)
        .optional()
        .describe('Optional routed MCP server name to restrict the search.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(settings.fallbackCandidateLimit),
      refresh: z.boolean().default(false),
    },
  },
  async ({ query, server: serverName, limit, refresh }) => {
    const result = await searchTools({
      query,
      server: serverName ?? null,
      limit,
      force: refresh,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  },
);

server.registerTool(
  'list_servers',
  {
    description:
      'List routed MCP server names in bounded pages with compact tool counts and availability. Use this to narrow discovery before listing tools from one server.',
    annotations: {
      title: 'List routed MCP servers',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      cursor: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(50).default(25),
      refresh: z.boolean().default(false),
    },
  },
  async ({ cursor, limit, refresh }) => {
    const result = await listServers({
      cursor,
      limit,
      force: refresh,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  },
);

server.registerTool(
  'list_tools',
  {
    description:
      'List routed tools in bounded pages, optionally restricted to one MCP server. Prefer this over list_all_tools when search_tools is insufficient.',
    annotations: {
      title: 'List routed tools',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      server: z
        .string()
        .min(1)
        .optional()
        .describe('Optional routed MCP server name.'),
      cursor: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(50).default(25),
      refresh: z.boolean().default(false),
    },
  },
  async ({ server: serverName, cursor, limit, refresh }) => {
    const result = await listTools({
      server: serverName ?? null,
      cursor,
      limit,
      force: refresh,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  },
);

server.registerTool(
  'list_all_tools',
  {
    description:
      'Explicit last-resort full routed-tool inventory. Prefer find_tool, search_tools, list_servers, and paginated list_tools first. This can be large.',
    annotations: {
      title: 'List all routed tools',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      reason: z
        .string()
        .default('')
        .describe('Why the router is falling back to full discovery.'),
      refresh: z
        .boolean()
        .default(false)
        .describe('Force refresh the underlying MCP inventories.'),
    },
  },
  async ({ refresh }) => {
    const result = await listAllTools({ force: refresh });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  },
);

server.registerTool(
  'call_readonly_tool',
  {
    description:
      'Execute a routed external MCP tool that is explicitly annotated read-only. Prefer this after find_tool for read-only tools because it does not request mutation approval. The router refuses to run a tool here unless its upstream readOnlyHint is true.',
    annotations: {
      title: 'Call routed read-only tool',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      server: z.string().min(1),
      tool: z.string().min(1),
      arguments: z.record(z.string(), z.unknown()).default({}),
    },
  },
  async ({ server: serverName, tool, arguments: args }) => {
    const result = await callReadOnlyRoutedTool({
      server: serverName,
      name: tool,
      arguments: args,
    });

    if (result.ok && result.upstream?.content) {
      return {
        ...result.upstream,
        structuredContent: {
          router: {
            ok: true,
            fallbackRequired: false,
            server: serverName,
            tool,
            readOnly: true,
          },
          upstream: result.upstream.structuredContent ?? null,
        },
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      isError: false,
      structuredContent: result,
    };
  },
);

server.registerTool(
  'call_tool',
  {
    description:
      'Execute a routed external MCP tool after find_tool/get_tool_schema. If the upstream call fails, this returns fallbackRequired=true with a compact alternative shortlist and search guidance. If the call succeeds but the result is semantically wrong for the task, use search_tools or list_tools before list_all_tools.',
    annotations: {
      title: 'Call routed external tool',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      server: z.string().min(1),
      tool: z.string().min(1),
      arguments: z.record(z.string(), z.unknown()).default({}),
    },
  },
  async ({ server: serverName, tool, arguments: args }) => {
    const result = await callRoutedTool({
      server: serverName,
      name: tool,
      arguments: args,
    });

    if (result.ok && result.upstream?.content) {
      return {
        ...result.upstream,
        structuredContent: {
          router: {
            ok: true,
            fallbackRequired: false,
            server: serverName,
            tool,
          },
          upstream: result.upstream.structuredContent ?? null,
        },
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      isError: false,
      structuredContent: result,
    };
  },
);

server.registerTool(
  'evaluate_work_with_jev',
  {
    description:
      'Evaluate completed or in-progress work with Jev. Use when the user says "valuta con Jev", "fai valutare il lavoro a Jev", or asks Jev to judge whether work matches the brief.',
    annotations: {
      title: 'Evaluate work with Jev',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      goal: z.string().min(1),
      requirements: z.string().default(''),
      work: z.string().min(1),
      evidence: z.string().default(''),
    },
  },
  async ({ goal, requirements, work, evidence }) => {
    const state = {
      goal,
      requirements:
        requirements || 'No additional explicit requirements supplied.',
      work,
      evidence:
        evidence || 'No additional verification evidence supplied.',
    };
    const questions = {
      satisfiesRequirements: {
        type: 'boolean',
        instructions:
          'What is the probability that the work satisfies the stated goal and explicit requirements?',
      },
      complete: {
        type: 'boolean',
        instructions:
          'What is the probability that the requested work is actually complete?',
      },
      needsRevision: {
        type: 'boolean',
        instructions:
          'What is the probability that the work needs a meaningful revision before it should be considered finished?',
      },
      quality: {
        type: 'score',
        instructions:
          'Rate overall execution quality considering correctness, robustness, polish, and fit to the stated goal.',
        criteria: [
          'Unacceptable',
          'Weak',
          'Acceptable',
          'Strong',
          'Excellent',
        ],
      },
      primaryIssue: {
        type: 'choice',
        instructions:
          'Identify the single most important issue category. Choose none only if no material issue is evident.',
        criteria: {
          requirements_mismatch: 'Does not match the brief or constraints.',
          correctness: 'Technically or factually incorrect.',
          incomplete: 'Requested work is missing or unfinished.',
          quality: 'Works but execution quality is the main weakness.',
          none: 'No material problem is evident.',
        },
      },
    };
    const estimatedBudgetUsage = estimateEvaluationBudgetUsage(
      state,
      questions,
    );

    if (
      estimatedBudgetUsage.stateQuestionTokens >
        settings.jevStateQuestionBudgetTokens ||
      estimatedBudgetUsage.totalTokens >
        settings.jevTotalBudgetTokens
    ) {
      const oversized = {
        ok: false,
        error:
          'Evaluation input exceeds the configured Jev context budget. Shorten or summarize the work/evidence before evaluating it.',
        estimatedStateQuestionTokens:
          estimatedBudgetUsage.stateQuestionTokens,
        stateQuestionBudgetTokens:
          settings.jevStateQuestionBudgetTokens,
        estimatedTotalTokens: estimatedBudgetUsage.totalTokens,
        totalBudgetTokens: settings.jevTotalBudgetTokens,
      };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(oversized, null, 2),
          },
        ],
        structuredContent: oversized,
      };
    }

    const result = await evaluate({
      model: settings.model,
      state,
      questions,
    });

    const summary = {
      satisfiesRequirementsProbability:
        result.answers.satisfiesRequirements.probability,
      completeProbability: result.answers.complete.probability,
      needsRevisionProbability: result.answers.needsRevision.probability,
      qualityScore0To4: result.answers.quality.score,
      qualityScaleMax: 4,
      primaryIssue: result.answers.primaryIssue.choice,
      model: result.response.modelId,
      inputTokens: result.usage.inputTokens,
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
      structuredContent: summary,
    };
  },
);

server.registerTool(
  'router_status',
  {
    description:
      'Read-only health check for the Jev router, routed server inventory, confidence threshold, Jev context budgets, and unavailable MCP servers.',
    annotations: {
      title: 'Jev router status',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      refresh: z.boolean().default(false),
    },
  },
  async ({ refresh }) => {
    const inventory = await refreshInventory({ force: refresh });
    const routedServers = [
      ...new Set(inventory.tools.map((tool) => tool.server)),
    ].sort();
    const result = {
      threshold: settings.threshold,
      model: settings.model,
      fallbackCandidateLimit: settings.fallbackCandidateLimit,
      jevStateQuestionBudgetTokens:
        settings.jevStateQuestionBudgetTokens,
      jevTotalBudgetTokens: settings.jevTotalBudgetTokens,
      jevContextBudgetTokens: settings.jevContextBudgetTokens,
      routedToolCount: inventory.tools.length,
      routedServerCount: routedServers.length,
      routedServers: routedServers.slice(0, 50),
      routedServersTruncated: routedServers.length > 50,
      unavailableServers: summarizeUnavailableServers(inventory.errors),
      configPath: settings.configPath,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

const shutdown = async () => {
  await closeAllSessions();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
