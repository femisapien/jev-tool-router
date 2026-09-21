import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.AI_GATEWAY_API_KEY) {
  throw new Error(
    'AI_GATEWAY_API_KEY is required for the live smoke test.',
  );
}

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const tempDir = await mkdtemp(
  path.join(os.tmpdir(), 'jev-tool-router-'),
);
const configPath = path.join(tempDir, 'router.config.json');
const previousExtraToolCount = process.env.MOCK_EXTRA_TOOL_COUNT;
process.env.MOCK_EXTRA_TOOL_COUNT = '220';

const config = {
  model: 'typesafe-ai/jev',
  threshold: 0.9,
  maxJevChoices: 254,
  descriptionMaxChars: 240,
  jevStateQuestionBudgetTokens: 24_000,
  jevTotalBudgetTokens: 48_000,
  jevContextBudgetTokens: 6_000,
  inventoryTtlMs: 60000,
  connectTimeoutMs: 10000,
  servers: {
    mock: {
      command: process.execPath,
      args: [path.join(repoRoot, 'tests', 'mock-mcp.mjs')],
      envVars: ['MOCK_EXTRA_TOOL_COUNT'],
    },
  },
};

await writeFile(
  configPath,
  JSON.stringify(config, null, 2),
  'utf8',
);
process.env.JEV_ROUTER_CONFIG = configPath;

try {
  const router = await import(
    '../src/router-core.mjs?smoke=' + Date.now()
  );

  const selected = await router.routeTool({
    request: 'I need current weather conditions for a city.',
    context:
      'The requested capability is a read-only current weather lookup. '.repeat(
        1_000,
      ),
  });
  assert.equal(selected.mode, 'selected');
  assert.equal(selected.tool.server, 'mock');
  assert.equal(selected.tool.name, 'get_weather');
  assert.ok(selected.confidence >= 0.9);
  assert.equal(selected.routingStrategy, 'tournament');
  assert.ok(selected.routingUsage.jevCalls >= 2);
  assert.equal(selected.routingUsage.contextTruncated, true);
  assert.ok(
    selected.routingUsage.maxEstimatedStateQuestionTokensPerCall <=
      config.jevStateQuestionBudgetTokens,
  );
  assert.ok(
    selected.routingUsage.maxEstimatedTotalTokensPerCall <=
      config.jevTotalBudgetTokens,
  );
  if (selected.routingUsage.callsWithReportedUsage > 0) {
    assert.ok(
      selected.routingUsage.maxReportedInputTokensPerCall < 32_000,
    );
  }

  const call = await router.callReadOnlyRoutedTool({
    server: 'mock',
    name: 'get_weather',
    arguments: { city: 'Rome' },
  });
  assert.equal(call.ok, true);

  const vague = await router.routeTool({
    request:
      'I need an external tool but I cannot describe the capability I need.',
  });
  assert.equal(vague.mode, 'fallback_full_list');

  console.log(
    JSON.stringify(
      {
        selectedTool:
          selected.tool.server + '/' + selected.tool.name,
        confidence: selected.confidence,
        routingStrategy: selected.routingStrategy,
        jevCalls: selected.routingUsage.jevCalls,
        contextTruncated: selected.routingUsage.contextTruncated,
        maxReportedInputTokens:
          selected.routingUsage.maxReportedInputTokensPerCall,
        maxEstimatedStateQuestionTokens:
          selected.routingUsage.maxEstimatedStateQuestionTokensPerCall,
        maxEstimatedTotalTokens:
          selected.routingUsage.maxEstimatedTotalTokensPerCall,
        readOnlyCallSucceeded: call.ok,
        vagueRequestMode: vague.mode,
      },
      null,
      2,
    ),
  );

  await router.closeAllSessions();
} finally {
  if (previousExtraToolCount == null) {
    delete process.env.MOCK_EXTRA_TOOL_COUNT;
  } else {
    process.env.MOCK_EXTRA_TOOL_COUNT = previousExtraToolCount;
  }
  await rm(tempDir, { recursive: true, force: true });
}
