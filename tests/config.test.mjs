import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  loadRouterConfig,
  parseRouterConfig,
} from '../src/config.mjs';

async function withConfig(config, fn) {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), 'jev-tool-router-config-'),
  );
  const configPath = path.join(tempDir, 'router.config.json');
  const previousConfigPath = process.env.JEV_ROUTER_CONFIG;

  await writeFile(
    configPath,
    JSON.stringify(config, null, 2),
    'utf8',
  );
  process.env.JEV_ROUTER_CONFIG = configPath;

  try {
    return await fn(configPath);
  } finally {
    if (previousConfigPath == null) {
      delete process.env.JEV_ROUTER_CONFIG;
    } else {
      process.env.JEV_ROUTER_CONFIG = previousConfigPath;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

test('loads a valid router config with defaults', async () => {
  await withConfig(
    {
      servers: {
        demo: {
          command: 'node',
          args: ['server.mjs'],
          envVars: ['TOKEN'],
        },
      },
    },
    async (configPath) => {
      const config = await loadRouterConfig();
      assert.equal(config.configPath, configPath);
      assert.equal(config.threshold, 0.9);
      assert.equal(config.maxJevChoices, 200);
      assert.equal(config.jevStateQuestionBudgetTokens, 24_000);
      assert.equal(config.jevTotalBudgetTokens, 48_000);
      assert.equal(config.jevContextBudgetTokens, 6_000);
      assert.deepEqual(config.servers.demo.envVars, ['TOKEN']);
    },
  );
});

test('rejects invalid servers values', async () => {
  await withConfig(
    {
      servers: null,
    },
    async () => {
      await assert.rejects(loadRouterConfig());
    },
  );
});

test('rejects literal env objects in router config', async () => {
  await withConfig(
    {
      servers: {
        demo: {
          command: 'node',
          env: {
            API_TOKEN: 'do-not-store',
          },
        },
      },
    },
    async () => {
      await assert.rejects(loadRouterConfig());
    },
  );
});

test('rejects valid JSON that violates the runtime router schema', () => {
  assert.throws(() =>
    parseRouterConfig({
      threshold: 'not-a-number',
      legacyField: true,
      servers: {},
    }),
  );
});

test('rejects a context budget that is not below the Jev state/question budget', () => {
  assert.throws(() =>
    parseRouterConfig({
      jevStateQuestionBudgetTokens: 8_000,
      jevContextBudgetTokens: 8_000,
      servers: {},
    }),
  );
});

test('rejects a Jev state/question budget that is not below the total budget', () => {
  assert.throws(() =>
    parseRouterConfig({
      jevStateQuestionBudgetTokens: 24_000,
      jevTotalBudgetTokens: 20_000,
      servers: {},
    }),
  );
});

test('keeps configurable Jev budgets below provider hard limits', () => {
  assert.throws(() =>
    parseRouterConfig({
      jevStateQuestionBudgetTokens: 32_000,
      servers: {},
    }),
  );
  assert.throws(() =>
    parseRouterConfig({
      jevTotalBudgetTokens: 64_000,
      servers: {},
    }),
  );
});
