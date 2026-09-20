import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

test('enforces tool filters, times out safely, and recovers the downstream session', async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), 'jev-tool-router-runtime-'),
  );
  const configPath = path.join(tempDir, 'router.config.json');
  const previousConfigPath = process.env.JEV_ROUTER_CONFIG;

  await writeFile(
    configPath,
    JSON.stringify(
      {
        model: 'typesafe-ai/jev',
        threshold: 0.9,
        maxJevChoices: 200,
        descriptionMaxChars: 240,
        inventoryTtlMs: 60_000,
        connectTimeoutMs: 10_000,
        toolTimeoutMs: 50,
        servers: {
          mock: {
            command: process.execPath,
            args: [path.join(repoRoot, 'tests', 'mock-mcp.mjs')],
            enabledTools: ['get_weather', 'slow_lookup'],
            disabledTools: ['calculate'],
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  process.env.JEV_ROUTER_CONFIG = configPath;

  let router;
  try {
    router = await import(
      '../src/router-core.mjs?runtime=' + Date.now()
    );

    const inventory = await router.listAllTools({ force: true });
    assert.deepEqual(
      inventory.tools.map((tool) => tool.name).sort(),
      ['get_weather', 'slow_lookup'],
    );

    const slowResult = await router.callReadOnlyRoutedTool({
      server: 'mock',
      name: 'slow_lookup',
      arguments: {},
    });
    assert.equal(slowResult.ok, false);
    assert.equal(slowResult.fallbackRequired, true);
    assert.match(slowResult.error, /timed out/);

    const recovered = await router.callReadOnlyRoutedTool({
      server: 'mock',
      name: 'get_weather',
      arguments: { city: 'Rome' },
    });
    assert.equal(recovered.ok, true);
  } finally {
    if (router) {
      await router.closeAllSessions();
    }
    if (previousConfigPath == null) {
      delete process.env.JEV_ROUTER_CONFIG;
    } else {
      process.env.JEV_ROUTER_CONFIG = previousConfigPath;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});
