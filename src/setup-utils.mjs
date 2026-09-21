export const DEFAULT_CODEX_EXCLUDES = new Set([
  'node_repl',
  'cua_repl',
  'codex_app',
  'jev_router',
]);

const SENSITIVE_ARG_PATTERN =
  /(token|api[-_]?key|secret|password|passwd|bearer|authorization)(=|:)/i;
const SENSITIVE_FLAG_PATTERN =
  /^--?(token|api[-_]?key|secret|password|passwd|bearer|authorization)$/i;

function containsSensitiveArgs(args) {
  return (args ?? []).some(
    (arg) =>
      SENSITIVE_ARG_PATTERN.test(String(arg)) ||
      SENSITIVE_FLAG_PATTERN.test(String(arg)) ||
      /:\/\/[^/@\s]+:[^/@\s]+@/.test(String(arg)),
  );
}

function containsSensitiveUrl(url) {
  const value = String(url);
  return (
    SENSITIVE_ARG_PATTERN.test(value) ||
    /:\/\/[^/@\s]+:[^/@\s]+@/.test(value)
  );
}

export function convertCodexMcpDefinition(name, definition) {
  void name;

  if (definition.enabled === false) {
    return {
      definition: null,
      reason: 'server is disabled in Codex and should remain direct',
    };
  }

  if (definition.required === true) {
    return {
      definition: null,
      reason:
        'server is required in Codex; automatic migration would weaken startup-failure semantics',
    };
  }

  if (definition.auth != null) {
    return {
      definition: null,
      reason:
        'server has explicit Codex auth semantics; automatic migration is intentionally skipped',
    };
  }

  if (
    definition.default_tools_approval_mode != null ||
    definition.tools != null
  ) {
    return {
      definition: null,
      reason:
        'server has explicit approval/output policy overrides; automatic migration is intentionally skipped',
    };
  }

  if (
    definition.experimental_environment != null &&
    definition.experimental_environment !== 'local'
  ) {
    return {
      definition: null,
      reason:
        'server uses a non-local experimental execution environment; automatic migration is skipped',
    };
  }

  if (definition.command) {
    if (
      definition.env &&
      Object.keys(definition.env).length > 0
    ) {
      return {
        definition: null,
        reason:
          'stdio server contains literal env values; automatic migration is intentionally skipped to avoid copying credentials',
      };
    }

    const envVars = definition.env_vars ?? [];
    if (envVars.some((entry) => typeof entry !== 'string')) {
      return {
        definition: null,
        reason:
          'stdio server uses structured env_vars entries; automatic migration is intentionally skipped',
      };
    }

    if (containsSensitiveArgs(definition.args)) {
      return {
        definition: null,
        reason:
          'stdio args appear to contain embedded credentials; automatic migration is intentionally skipped',
      };
    }

    return {
      definition: {
        command: definition.command,
        args: definition.args ?? [],
        cwd: definition.cwd,
        envVars,
        connectTimeoutMs:
          typeof definition.startup_timeout_ms === 'number'
            ? definition.startup_timeout_ms
            : typeof definition.startup_timeout_sec === 'number'
              ? definition.startup_timeout_sec * 1000
              : undefined,
        toolTimeoutMs:
          typeof definition.tool_timeout_sec === 'number'
            ? definition.tool_timeout_sec * 1000
            : undefined,
        enabledTools: definition.enabled_tools ?? undefined,
        disabledTools: definition.disabled_tools ?? undefined,
      },
      reason: null,
    };
  }

  if (definition.url) {
    if (
      definition.bearer_token_env_var ||
      definition.http_headers ||
      definition.env_http_headers ||
      definition.http_headers_helper ||
      definition.scopes ||
      definition.oauth_resource ||
      definition.oauth
    ) {
      return {
        definition: null,
        reason:
          'remote server uses explicit auth/header/OAuth configuration; automatic migration is intentionally skipped',
      };
    }

    if (containsSensitiveUrl(definition.url)) {
      return {
        definition: null,
        reason:
          'remote URL appears to contain embedded credentials; automatic migration is intentionally skipped',
      };
    }

    return {
      definition: {
        command: 'npx',
        args: ['-y', 'mcp-remote@0.14.2', definition.url],
        connectTimeoutMs:
          typeof definition.startup_timeout_ms === 'number'
            ? definition.startup_timeout_ms
            : typeof definition.startup_timeout_sec === 'number'
              ? definition.startup_timeout_sec * 1000
              : undefined,
        toolTimeoutMs:
          typeof definition.tool_timeout_sec === 'number'
            ? definition.tool_timeout_sec * 1000
            : undefined,
        enabledTools: definition.enabled_tools ?? undefined,
        disabledTools: definition.disabled_tools ?? undefined,
      },
      reason: null,
    };
  }

  return {
    definition: null,
    reason: 'unsupported MCP definition shape',
  };
}

export function mergeRouterServers(existingServers, newServers) {
  return {
    ...(existingServers ?? {}),
    ...(newServers ?? {}),
  };
}

export function registrationMatchesExpected(
  actual,
  expected,
  { caseInsensitive = false } = {},
) {
  if (!actual || !expected) return false;

  const normalize = (value) => {
    const text = String(value);
    if (!caseInsensitive) return text;
    return text.replaceAll('/', '\\').toLowerCase();
  };

  if (normalize(actual.command) !== normalize(expected.command)) {
    return false;
  }

  const actualArgs = actual.args ?? [];
  const expectedArgs = expected.args ?? [];
  if (actualArgs.length !== expectedArgs.length) {
    return false;
  }

  return actualArgs.every(
    (value, index) =>
      normalize(value) === normalize(expectedArgs[index]),
  );
}

export function upsertManagedMarkdownSection(
  existing,
  {
    marker,
    endMarker,
    content,
    legacyContent = null,
  },
) {
  const text = String(existing ?? '');
  const block = String(content ?? '').trim();
  if (!marker || !endMarker || !block) {
    throw new Error(
      'marker, endMarker, and content are required for a managed markdown section.',
    );
  }

  const start = text.indexOf(marker);
  if (start < 0) {
    return [text.trimEnd(), block]
      .filter(Boolean)
      .join('\n\n')
      .concat('\n');
  }

  const explicitEnd = text.indexOf(
    endMarker,
    start + marker.length,
  );
  let end;
  if (explicitEnd >= 0) {
    end = explicitEnd + endMarker.length;
  } else if (legacyContent) {
    const legacyBlocks = (Array.isArray(legacyContent)
      ? legacyContent
      : [legacyContent]
    )
      .map((value) => String(value).trim())
      .filter(Boolean);
    const legacyBlock = legacyBlocks.find((block) =>
      text.slice(start).startsWith(block),
    );
    if (!legacyBlock) {
      throw new Error(
        'Existing managed-section marker does not match the known legacy block. Refusing to rewrite AGENTS.md automatically.',
      );
    }
    end = start + legacyBlock.length;
  } else {
    throw new Error(
      'Existing managed-section marker has no end marker. Refusing to guess where the section ends.',
    );
  }

  const prefix = text.slice(0, start).trimEnd();
  const suffix = text.slice(end).trimStart();
  return [prefix, block, suffix]
    .filter(Boolean)
    .join('\n\n')
    .concat('\n');
}
