import test from 'node:test';
import assert from 'node:assert/strict';
import {
  convertCodexMcpDefinition,
  mergeRouterServers,
  registrationMatchesExpected,
} from '../src/setup-utils.mjs';

test('converts stdio Codex MCP definitions and preserves safe policies', () => {
  const result = convertCodexMcpDefinition('demo', {
    command: 'node',
    args: ['server.mjs'],
    cwd: '/tmp/demo',
    env_vars: ['TOKEN'],
    startup_timeout_sec: 12,
    tool_timeout_sec: 45,
    enabled_tools: ['read_data'],
    disabled_tools: ['delete_data'],
  });

  assert.equal(result.reason, null);
  assert.equal(result.definition.command, 'node');
  assert.deepEqual(result.definition.args, ['server.mjs']);
  assert.deepEqual(result.definition.envVars, ['TOKEN']);
  assert.equal(result.definition.connectTimeoutMs, 12_000);
  assert.equal(result.definition.toolTimeoutMs, 45_000);
  assert.deepEqual(result.definition.enabledTools, ['read_data']);
  assert.deepEqual(result.definition.disabledTools, ['delete_data']);
});

test('does not auto-migrate stdio servers with literal env values', () => {
  const result = convertCodexMcpDefinition('secret-demo', {
    command: 'node',
    args: ['server.mjs'],
    env: { API_TOKEN: 'do-not-copy' },
  });

  assert.equal(result.definition, null);
  assert.match(result.reason, /intentionally skipped/);
});

test('does not auto-migrate stdio servers with credential-like args', () => {
  const result = convertCodexMcpDefinition('secret-args', {
    command: 'node',
    args: ['server.mjs', '--api-key', 'do-not-copy'],
  });

  assert.equal(result.definition, null);
  assert.match(result.reason, /embedded credentials/);
});

test('keeps disabled, required, and custom-approval servers direct', () => {
  const disabled = convertCodexMcpDefinition('disabled', {
    enabled: false,
    command: 'node',
  });
  const required = convertCodexMcpDefinition('required', {
    required: true,
    command: 'node',
  });
  const approval = convertCodexMcpDefinition('approval', {
    command: 'node',
    default_tools_approval_mode: 'always',
  });

  assert.equal(disabled.definition, null);
  assert.equal(required.definition, null);
  assert.equal(approval.definition, null);
});

test('does not auto-migrate servers with explicit Codex auth semantics', () => {
  const result = convertCodexMcpDefinition('chatgpt-auth', {
    url: 'https://example.com/mcp',
    auth: 'chatgpt',
  });

  assert.equal(result.definition, null);
  assert.match(result.reason, /explicit Codex auth semantics/);
});

test('converts plain remote URLs through a pinned mcp-remote wrapper', () => {
  const result = convertCodexMcpDefinition('remote', {
    url: 'https://example.com/mcp',
    startup_timeout_ms: 7000,
    tool_timeout_sec: 20,
  });

  assert.equal(result.reason, null);
  assert.deepEqual(result.definition.args, [
    '-y',
    'mcp-remote@0.14.2',
    'https://example.com/mcp',
  ]);
  assert.equal(result.definition.connectTimeoutMs, 7000);
  assert.equal(result.definition.toolTimeoutMs, 20_000);
});

test('does not auto-migrate remote servers with custom auth headers', () => {
  const result = convertCodexMcpDefinition('secure', {
    url: 'https://example.com/mcp',
    bearer_token_env_var: 'TOKEN',
  });

  assert.equal(result.definition, null);
  assert.match(result.reason, /intentionally skipped/);
});

test('does not auto-migrate remote URLs with embedded credentials', () => {
  const result = convertCodexMcpDefinition('secret-url', {
    url: 'https://example.com/mcp?api_key=do-not-copy',
  });

  assert.equal(result.definition, null);
  assert.match(result.reason, /embedded credentials/);
});

test('merges existing routed servers with newly migrated servers', () => {
  const result = mergeRouterServers(
    {
      existing: {
        command: 'node',
        args: ['existing.mjs'],
      },
    },
    {
      added: {
        command: 'node',
        args: ['added.mjs'],
      },
    },
  );

  assert.deepEqual(Object.keys(result).sort(), ['added', 'existing']);
  assert.deepEqual(result.existing.args, ['existing.mjs']);
  assert.deepEqual(result.added.args, ['added.mjs']);
});

test('detects stale or mismatched router registrations', () => {
  const expected = {
    command: 'powershell.exe',
    args: [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'C:\\Users\\Example\\new\\bin\\launch.ps1',
    ],
  };

  const matching = {
    command: 'POWERSHELL.EXE',
    args: [
      '-noprofile',
      '-executionpolicy',
      'bypass',
      '-file',
      'c:/users/example/new/bin/launch.ps1',
    ],
  };

  const stale = {
    command: 'powershell.exe',
    args: [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'C:\\Users\\Example\\old\\bin\\launch.ps1',
    ],
  };

  assert.equal(
    registrationMatchesExpected(matching, expected, {
      caseInsensitive: true,
    }),
    true,
  );
  assert.equal(
    registrationMatchesExpected(stale, expected, {
      caseInsensitive: true,
    }),
    false,
  );
});
