import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';

export function defaultConfigPath() {
  return (
    process.env.JEV_ROUTER_CONFIG ??
    path.join(
      os.homedir(),
      '.codex',
      'jev-tool-router',
      'router.config.json',
    )
  );
}

const serverSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    cwd: z.string().min(1).optional(),
    envVars: z.array(z.string().min(1)).default([]),
    connectTimeoutMs: z.number().positive().optional(),
    toolTimeoutMs: z.number().positive().optional(),
    enabledTools: z.array(z.string().min(1)).optional(),
    disabledTools: z.array(z.string().min(1)).optional(),
  })
  .strict();

const routerConfigSchema = z
  .object({
    model: z.string().min(1).default('typesafe-ai/jev'),
    threshold: z.number().min(0).max(1).default(0.9),
    maxJevChoices: z.number().int().min(2).max(254).default(200),
    descriptionMaxChars: z.number().int().positive().default(240),
    fallbackCandidateLimit: z
      .number()
      .int()
      .min(4)
      .max(50)
      .default(12),
    jevStateQuestionBudgetTokens: z
      .number()
      .int()
      .min(4_000)
      .max(28_000)
      .default(24_000),
    jevTotalBudgetTokens: z
      .number()
      .int()
      .min(8_000)
      .max(56_000)
      .default(48_000),
    jevContextBudgetTokens: z
      .number()
      .int()
      .min(0)
      .max(16_000)
      .default(6_000),
    inventoryTtlMs: z.number().positive().default(300_000),
    connectTimeoutMs: z.number().positive().default(15_000),
    toolTimeoutMs: z.number().positive().default(60_000),
    servers: z.record(z.string().min(1), serverSchema).default({}),
  })
  .strict()
  .refine(
    (config) =>
      config.jevContextBudgetTokens <
      config.jevStateQuestionBudgetTokens,
    {
      message:
        'jevContextBudgetTokens must be lower than jevStateQuestionBudgetTokens.',
      path: ['jevContextBudgetTokens'],
    },
  )
  .refine(
    (config) =>
      config.jevStateQuestionBudgetTokens <
      config.jevTotalBudgetTokens,
    {
      message:
        'jevStateQuestionBudgetTokens must be lower than jevTotalBudgetTokens.',
      path: ['jevTotalBudgetTokens'],
    },
  );

export function parseRouterConfig(value) {
  return routerConfigSchema.parse(value);
}

export async function loadRouterConfig() {
  const configPath = defaultConfigPath();
  let raw;

  try {
    raw = await readFile(configPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        'Router config not found at ' +
          configPath +
          '. Run "npm run setup:codex" first or copy templates/router.config.example.json.',
      );
    }
    throw error;
  }

  const parsed = parseRouterConfig(JSON.parse(raw));

  return {
    configPath,
    ...parsed,
  };
}
