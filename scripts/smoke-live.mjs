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

const config = {
  model: 'typesafe-ai/jev',
  threshold: 0.9,
  maxJevChoices: 200,
  descriptionMaxChars: 240,
  inventoryTtlMs: 60000,
  connectTimeoutMs: 10000,
  servers: {
    mock: {
      command: process.execPath,
      args: [path.join(repoRoot, 'tests', 'mock-mcp.mjs')],
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
  });
  assert.equal(selected.mode, 'selected');
  assert.equal(selected.tool.server, 'mock');
  assert.equal(selected.tool.name, 'get_weather');
  assert.ok(selected.confidence >= 0.9);

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
        readOnlyCallSucceeded: call.ok,
        vagueRequestMode: vague.mode,
      },
      null,
      2,
    ),
  );

  await router.closeAllSessions();
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
