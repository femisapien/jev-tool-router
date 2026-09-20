import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

const server = new McpServer({
  name: 'jev-router-mock',
  version: '0.1.0',
});

server.registerTool(
  'get_weather',
  {
    description:
      'Read current weather conditions for a city. This is a read-only weather lookup.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      city: z.string().min(1),
    },
  },
  async ({ city }) => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          city,
          temperatureC: 21,
          conditions: 'clear',
        }),
      },
    ],
  }),
);

server.registerTool(
  'calculate',
  {
    description:
      'Evaluate a simple arithmetic expression and return the numeric result.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      expression: z.string().min(1),
    },
  },
  async ({ expression }) => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({ expression, result: 4 }),
      },
    ],
  }),
);

server.registerTool(
  'search_images',
  {
    description:
      'Search an image catalog by text query and return matching image metadata.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      query: z.string().min(1),
    },
  },
  async ({ query }) => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({ query, matches: [] }),
      },
    ],
  }),
);

server.registerTool(
  'slow_lookup',
  {
    description:
      'Read a deliberately slow value. Used only to verify downstream timeout and recovery behavior.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {},
  },
  async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true }),
        },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());
