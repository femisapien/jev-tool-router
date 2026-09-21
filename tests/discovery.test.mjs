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

async function withLargeMockRouter(fn) {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), 'jev-tool-router-discovery-'),
  );
  const configPath = path.join(tempDir, 'router.config.json');
  const previousConfigPath = process.env.JEV_ROUTER_CONFIG;
  const previousExtraToolCount = process.env.MOCK_EXTRA_TOOL_COUNT;

  await writeFile(
    configPath,
    JSON.stringify(
      {
        model: 'typesafe-ai/jev',
        threshold: 0.9,
        maxJevChoices: 200,
        descriptionMaxChars: 240,
        fallbackCandidateLimit: 12,
        inventoryTtlMs: 60_000,
        connectTimeoutMs: 10_000,
        toolTimeoutMs: 1_000,
        servers: {
          mock: {
            command: process.execPath,
            args: [path.join(repoRoot, 'tests', 'mock-mcp.mjs')],
            envVars: ['MOCK_EXTRA_TOOL_COUNT'],
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  process.env.JEV_ROUTER_CONFIG = configPath;
  process.env.MOCK_EXTRA_TOOL_COUNT = '270';

  let router;
  try {
    router = await import(
      '../src/router-core.mjs?discovery=' + Date.now()
    );
    await fn(router);
  } finally {
    if (router) await router.closeAllSessions();
    if (previousConfigPath == null) {
      delete process.env.JEV_ROUTER_CONFIG;
    } else {
      process.env.JEV_ROUTER_CONFIG = previousConfigPath;
    }
    if (previousExtraToolCount == null) {
      delete process.env.MOCK_EXTRA_TOOL_COUNT;
    } else {
      process.env.MOCK_EXTRA_TOOL_COUNT = previousExtraToolCount;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

test('compact discovery searches and paginates a large inventory', async () => {
  await withLargeMockRouter(async (router) => {
    const all = await router.listAllTools({ force: true });
    assert.equal(all.tools.length, 275);

    const servers = await router.listServers({ cursor: 0, limit: 10 });
    assert.equal(servers.total, 1);
    assert.equal(servers.nextCursor, null);
    assert.deepEqual(servers.servers, [
      {
        name: 'mock',
        toolCount: 275,
        available: true,
      },
    ]);

    const search = await router.searchTools({
      query: 'current weather conditions for a city',
      limit: 8,
    });
    assert.equal(search.tools[0].name, 'get_weather');
    assert.ok(search.tools.length <= 8);

    const firstPage = await router.listTools({
      server: 'mock',
      cursor: 0,
      limit: 10,
    });
    assert.equal(firstPage.tools.length, 10);
    assert.equal(firstPage.nextCursor, 10);

    const secondPage = await router.listTools({
      server: 'mock',
      cursor: firstPage.nextCursor,
      limit: 10,
    });
    assert.equal(secondPage.cursor, 10);
    assert.equal(secondPage.tools.length, 10);
    assert.notDeepEqual(secondPage.tools, firstPage.tools);
  });
});

test('routing failures return a bounded shortlist, never the full inventory', async () => {
  await withLargeMockRouter(async (router) => {
    const result = await router.routeTool({
      request: 'weather '.repeat(4_000),
    });

    assert.equal(result.mode, 'fallback_shortlist');
    assert.ok(result.shortlist.length <= 12);
    assert.equal(result.shortlist[0].name, 'get_weather');
    assert.equal(Object.hasOwn(result, 'tools'), false);
    assert.equal(Object.hasOwn(result, 'allTools'), false);
    assert.ok(JSON.stringify(result).length < 12_000);
  });
});
