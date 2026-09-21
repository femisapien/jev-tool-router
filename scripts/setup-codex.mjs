import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import { parseRouterConfig } from '../src/config.mjs';
import {
  DEFAULT_CODEX_EXCLUDES,
  convertCodexMcpDefinition,
  mergeRouterServers,
  registrationMatchesExpected,
  upsertManagedMarkdownSection,
} from '../src/setup-utils.mjs';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const CODEX_DIR = path.join(os.homedir(), '.codex');
const CODEX_CONFIG = path.join(CODEX_DIR, 'config.toml');
const CODEX_AGENTS = path.join(CODEX_DIR, 'AGENTS.md');
const ROUTER_CONFIG_DIR = path.join(CODEX_DIR, 'jev-tool-router');
const ROUTER_CONFIG = path.join(
  ROUTER_CONFIG_DIR,
  'router.config.json',
);
const EXPECTED_ROUTER_REGISTRATION =
  process.platform === 'win32'
    ? {
        command: 'powershell.exe',
        args: [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(REPO_ROOT, 'bin', 'launch.ps1'),
        ],
      }
    : {
        command: 'bash',
        args: [path.join(REPO_ROOT, 'bin', 'launch.sh')],
      };
const args = process.argv.slice(2);
const apply = args.includes('--apply');

function readOption(name) {
  const prefix = '--' + name + '=';
  const item = args.find((value) => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : null;
}

function runCodex(argsList, { ignoreFailure = false } = {}) {
  const command =
    process.platform === 'win32' ? 'powershell.exe' : 'codex';
  const commandArgs =
    process.platform === 'win32'
      ? [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(REPO_ROOT, 'scripts', 'run-codex.ps1'),
          ...argsList,
        ]
      : argsList;
  const result = spawnSync(command, commandArgs, {
    stdio: ignoreFailure ? 'ignore' : 'inherit',
    shell: false,
  });

  if (!ignoreFailure && (result.error || result.status !== 0)) {
    throw new Error(
      'Codex command failed: codex ' +
        argsList.join(' ') +
        (result.error ? ' (' + result.error.message + ')' : ''),
    );
  }
}

const extraExcludes = new Set(
  (readOption('exclude') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
const excludes = new Set([
  ...DEFAULT_CODEX_EXCLUDES,
  ...extraExcludes,
]);

if (!existsSync(CODEX_CONFIG)) {
  throw new Error(
    'Codex config not found at ' +
      CODEX_CONFIG +
      '. Install/configure Codex first.',
  );
}

const rawConfig = readFileSync(CODEX_CONFIG, 'utf8');
const parsed = parse(rawConfig);
const mcpServers = parsed.mcp_servers ?? {};
const selected = {};
const skipped = {};

let existingRouterConfig = null;
if (existsSync(ROUTER_CONFIG)) {
  try {
    existingRouterConfig = parseRouterConfig(
      JSON.parse(readFileSync(ROUTER_CONFIG, 'utf8')),
    );
  } catch (error) {
    throw new Error(
      'Existing router.config.json is invalid: ' +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

const existingServers = existingRouterConfig?.servers ?? {};
const routerAlreadyRegistered = mcpServers.jev_router != null;
const routerRegistrationMatches =
  routerAlreadyRegistered &&
  registrationMatchesExpected(
    mcpServers.jev_router,
    EXPECTED_ROUTER_REGISTRATION,
    { caseInsensitive: process.platform === 'win32' },
  );
if (
  routerAlreadyRegistered &&
  (!existingRouterConfig || !routerRegistrationMatches) &&
  apply
) {
  throw new Error(
    !existingRouterConfig
      ? 'Codex already has an MCP named jev_router, but this installation has no router.config.json. Refusing to overwrite an unknown MCP registration.'
      : 'Codex already has an MCP named jev_router, but its command/args do not match this installation. Refusing to remove any direct MCPs. Remove or repair the stale/unknown jev_router registration, then rerun setup.',
  );
}

for (const [name, definition] of Object.entries(mcpServers)) {
  if (excludes.has(name)) {
    skipped[name] = 'excluded';
    continue;
  }

  const converted = convertCodexMcpDefinition(name, definition);
  if (!converted.definition) {
    skipped[name] = converted.reason;
    continue;
  }

  selected[name] = converted.definition;
}

console.log('Jev Tool Router Codex migration preview');
console.log('--------------------------------------');
console.log(
  'Already routed: ' +
    (Object.keys(existingServers).length
      ? Object.keys(existingServers).join(', ')
      : '(none)'),
);
console.log(
  'Newly eligible: ' +
    (Object.keys(selected).length
      ? Object.keys(selected).join(', ')
      : '(none)'),
);
console.log(
  'Will keep direct: ' +
    (Object.keys(skipped).length
      ? Object.entries(skipped)
          .map(([name, reason]) => name + ' (' + reason + ')')
          .join(', ')
      : '(none)'),
);

const mergedServers = mergeRouterServers(
  existingServers,
  selected,
);

if (Object.keys(mergedServers).length === 0) {
  throw new Error(
    'No MCP servers are routed or eligible for migration.',
  );
}

// Validate the managed AGENTS.md section before any apply-side mutation. If an
// older install has user-modified/ambiguous content after our marker, fail
// closed before writing config or removing any direct MCP registration.
const marker = '# Jev external tool routing';
const endMarker = '<!-- /jev-tool-router -->';
const legacyRoutingInstructions = [
  marker,
  '',
  'For external MCP capabilities, use `jev_router/find_tool` first instead of enumerating or guessing an external tool. Pass the capability you need in plain language and only task context that helps disambiguate it.',
  '',
  'If `find_tool` returns `mode: selected`, use the returned schema. Prefer `jev_router/call_readonly_tool` when the upstream tool is explicitly read-only; use `jev_router/call_tool` for mutating or unclassified tools.',
  '',
  'If `find_tool` returns `mode: fallback_full_list`, use the full list already returned. If a routed call returns `fallbackRequired: true`, use the returned `allTools` list. If a selected tool succeeds technically but is semantically wrong, call `jev_router/list_all_tools`.',
  '',
  'Use `jev_router/get_tool_schema` after full-list discovery when needed.',
  '',
  'When the user asks to evaluate work with Jev, use `jev_router/evaluate_work_with_jev`.',
  '',
  'This applies only to external MCPs behind `jev_router`. Built-in Codex/OpenAI tools remain native.',
].join('\n');
const installedLegacyRoutingInstructions = [
  marker,
  '',
  'For external MCP capabilities, use `jev_router/find_tool` first instead of enumerating or guessing an external tool. Pass the capability you need in plain language and only the task context that helps disambiguate it.',
  '',
  'If `find_tool` returns `mode: selected` with confidence at or above the router threshold, use the returned tool. Prefer `jev_router/call_readonly_tool` when the selected tool is explicitly annotated read-only; use `jev_router/call_tool` for mutating or non-read-only tools. Use `jev_router/get_tool_schema` when you need the full schema after fallback or when the exact routed tool is already known.',
  '',
  'If `find_tool` returns `mode: fallback_full_list`, use the full tool list already returned in that response; do not repeat discovery. If a routed call fails and returns `fallbackRequired=true`, use the `allTools` list returned with the failure. If a selected tool succeeds technically but is not the capability you were looking for, call `jev_router/list_all_tools` to search the full inventory. After choosing from a full list, fetch its schema if needed and call it through the router.',
  '',
  'When the user says to evaluate the work with Jev, use `jev_router/evaluate_work_with_jev`.',
  '',
  'This routing rule applies to external MCPs behind `jev_router`. Built-in Codex tools and OpenAI-provided computer/browser/file tools remain native and should be used normally.',
].join('\n');
const routingInstructions = [
  marker,
  '',
  'For external MCP capabilities, use `jev_router/find_tool` first instead of enumerating or guessing an external tool. Pass the capability you need in plain language and only task context that helps disambiguate it.',
  '',
  'If `find_tool` returns `mode: selected`, use the returned schema. Prefer `jev_router/call_readonly_tool` when the upstream tool is explicitly read-only; use `jev_router/call_tool` for mutating or unclassified tools.',
  '',
  'If `find_tool` returns `mode: fallback_shortlist`, inspect the compact shortlist. If no candidate clearly fits, call `jev_router/search_tools` with a more specific capability query. Use `jev_router/list_servers` and paginated `jev_router/list_tools` to expand discovery without loading the entire inventory.',
  '',
  'If a routed call returns `fallbackRequired: true`, inspect its compact shortlist or use `search_tools`. If a selected tool succeeds technically but is semantically wrong, search again rather than jumping directly to the full inventory.',
  '',
  'Use `jev_router/list_all_tools` only as an explicit last resort when targeted search and paginated discovery are insufficient. Use `jev_router/get_tool_schema` when a discovered candidate needs its full schema.',
  '',
  'When the user asks to evaluate work with Jev, use `jev_router/evaluate_work_with_jev`.',
  '',
  'This applies only to external MCPs behind `jev_router`. Built-in Codex/OpenAI tools remain native.',
  '',
  endMarker,
].join('\n');
const existingAgents = existsSync(CODEX_AGENTS)
  ? readFileSync(CODEX_AGENTS, 'utf8')
  : '';
const updatedAgents = upsertManagedMarkdownSection(existingAgents, {
  marker,
  endMarker,
  content: routingInstructions,
  legacyContent: [
    legacyRoutingInstructions,
    installedLegacyRoutingInstructions,
  ],
});

if (!apply) {
  console.log('');
  console.log('Preview validation passed. To apply:');
  console.log('  npm run setup:codex -- --apply');
  process.exit(0);
}

mkdirSync(ROUTER_CONFIG_DIR, { recursive: true });

const timestamp = new Date()
  .toISOString()
  .replace(/[:.]/g, '-');
const configBackup =
  CODEX_CONFIG + '.backup-jev-router-' + timestamp;
copyFileSync(CODEX_CONFIG, configBackup);

let agentsBackup = null;
if (existsSync(CODEX_AGENTS)) {
  agentsBackup =
    CODEX_AGENTS + '.backup-jev-router-' + timestamp;
  copyFileSync(CODEX_AGENTS, agentsBackup);
}

let routerConfigBackup = null;
if (existsSync(ROUTER_CONFIG)) {
  routerConfigBackup =
    ROUTER_CONFIG + '.backup-jev-router-' + timestamp;
  copyFileSync(ROUTER_CONFIG, routerConfigBackup);
}

const routerConfig = {
  model: 'typesafe-ai/jev',
  threshold: 0.9,
  maxJevChoices: 200,
  descriptionMaxChars: 240,
  fallbackCandidateLimit: 12,
  jevStateQuestionBudgetTokens: 24000,
  jevTotalBudgetTokens: 48000,
  jevContextBudgetTokens: 6000,
  inventoryTtlMs: 300000,
  connectTimeoutMs: 15000,
  toolTimeoutMs: 60000,
  ...(existingRouterConfig ?? {}),
  servers: mergedServers,
};
writeFileSync(
  ROUTER_CONFIG,
  JSON.stringify(routerConfig, null, 2) + '\n',
  'utf8',
);

if (!routerAlreadyRegistered) {
  runCodex([
    'mcp',
    'add',
    'jev_router',
    '--',
    EXPECTED_ROUTER_REGISTRATION.command,
    ...EXPECTED_ROUTER_REGISTRATION.args,
  ]);
}

for (const name of Object.keys(selected)) {
  runCodex(['mcp', 'remove', name]);
}

if (updatedAgents !== existingAgents) {
  writeFileSync(
    CODEX_AGENTS,
    updatedAgents,
    'utf8',
  );
}

console.log('');
console.log('Applied Jev Tool Router migration.');
console.log('Router config: ' + ROUTER_CONFIG);
console.log('Codex config backup: ' + configBackup);
if (agentsBackup) {
  console.log('Codex AGENTS backup: ' + agentsBackup);
}
if (routerConfigBackup) {
  console.log('Router config backup: ' + routerConfigBackup);
}
if (!process.env.AI_GATEWAY_API_KEY) {
  console.warn(
    'AI_GATEWAY_API_KEY is not visible in this shell. Set it in the environment before starting Codex. The secret was not written to config.',
  );
}
console.log('Restart Codex, then run: npm run status');
