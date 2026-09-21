# Jev Tool Router

Jev-powered MCP tool routing for Codex.

Unofficial community project. Not affiliated with or endorsed by TypeSafe AI,
Vercel, or OpenAI.

Instead of exposing hundreds of external MCP tool schemas directly to the
agent, Jev Tool Router exposes a small routing surface and resolves external
tool discovery on demand.

The core flow is:

    agent: "I need capability X"
                  |
                  v
        jev_router/find_tool
                  |
                  v
      Jev sees request + tool
        names + descriptions
                  |
          +-------+-------+
          |               |
      >= threshold     < threshold
          |               |
          v               v
    one tool + schema   full tool list
          |
          v
       call tool
          |
    failure or mismatch
          |
          v
      full discovery

Default selection threshold: 0.90.

## Why

Large MCP setups can expose hundreds of tool definitions to an agent even when
only one tool is relevant to the current task. This project moves external MCP
tool discovery behind a small router:

- find_tool
- get_tool_schema
- list_all_tools
- call_readonly_tool
- call_tool
- evaluate_work_with_jev
- router_status

The underlying tool inventory remains available. The router narrows discovery;
it does not permanently remove the fallback path.

## What Jev does

For routing, Jev receives:

- the capability the agent is looking for
- optional task context
- tool names
- tool descriptions

It does not receive every full input schema during routing.

Every routing choice includes none_of_the_above. A tool is selected only when
its probability reaches the configured threshold. Otherwise the router returns
the normal full routed-tool list.

If the inventory cannot fit safely in one Jev call because of either Choice
cardinality or context size, the router runs a conservative tournament. Batches
are constrained by both limits. Each group produces a finalist, finalists are
compared again, and final confidence is the minimum confidence along the winning
path.

## Jev context budgeting

Jev 1.13 documents two separate limits:

- 64k tokens for the whole request
- 32k tokens for `state` plus the single longest question

See https://docs.typesafe.ai/models.

The router does not wait for the provider to reject an oversized request.
Before every Jev routing call it estimates the serialized input size and builds
candidate batches that fit conservative working budgets:

- 24k estimated tokens for `state + longest question`
- 48k estimated tokens for the whole request
- 6k estimated tokens for optional agent-supplied routing context

The optional context is truncated when necessary and the response reports that
in `routingUsage.contextTruncated`. The required capability request itself is
not silently truncated; if it cannot fit safely, routing falls back to the full
tool list.

The preflight deliberately treats every serialized UTF-8 byte as one estimated
token. This is intentionally pessimistic because TypeSafe does not publish a
tokenizer or a safe bytes-per-token lower bound. Live provider usage from AI
SDK's `result.usage.inputTokens` is returned separately in compact
`routingUsage` diagnostics for measurement, but it is never used to weaken
the hard preflight.

`maxJevChoices` remains a hard upper bound per Choice call. The effective batch
size can be smaller when tool names/descriptions or task context are larger.

## Requirements

- Node.js 22 or newer
- Codex CLI/Desktop
- Vercel AI Gateway API key in AI_GATEWAY_API_KEY
- Access to typesafe-ai/jev through Vercel AI Gateway

The API key is never written into router.config.json or Codex config.

## Install as a skill

Install directly from GitHub:

    npx skills add jackbarunz/jev-tool-router --global -y

Then ask your coding agent to set up Jev Tool Router, or follow the manual
steps below.

## Manual quick start

Clone and install:

    git clone https://github.com/jackbarunz/jev-tool-router.git
    cd jev-tool-router
    npm install
    npm run check
    npm test

Preview which Codex MCP servers would be moved behind the router:

    npm run setup:codex

Apply the migration:

    npm run setup:codex -- --apply

Keep specific MCP servers direct:

    npm run setup:codex -- --apply --exclude=my_server,another_server

Then restart Codex and check:

    npm run status
    codex mcp list

## What setup changes

The setup script:

1. Reads ~/.codex/config.toml.
2. Leaves native Codex entries such as node_repl, cua_repl, and codex_app
   direct.
3. Converts eligible external MCP entries into
   ~/.codex/jev-tool-router/router.config.json.
4. Skips remote entries with explicit Codex auth semantics or custom
   bearer/header authentication rather than guessing how to proxy them.
5. Skips stdio entries that contain literal env values rather than copying
   possible credentials into router.config.json. env_vars names are supported.
6. Skips stdio args and remote URLs that look like they contain embedded
   credentials.
7. Keeps disabled/required MCPs and servers with custom Codex approval/output
   policy direct instead of weakening their semantics.
8. Preserves eligible per-server tool allow/deny lists and startup/tool
   timeouts inside the router config.
9. Merges newly migrated servers with servers already routed by an earlier run,
   so setup is safe to rerun.
10. Validates any existing jev_router registration points to this installation;
    a stale or unrelated same-name registration makes apply fail before any
    direct MCP is removed.
11. Creates timestamped backups of config.toml, AGENTS.md, and an existing
    router config before mutation.
12. Registers jev_router before removing any migrated direct MCPs.
13. Removes migrated external MCPs through `codex mcp remove`.
14. Appends routing instructions to ~/.codex/AGENTS.md if they are not already
    present.

The generated router config lives under the user's Codex configuration
directory, not inside this repository. A root-level router.config.json is still
gitignored for local/manual overrides. The generated config may contain
machine-specific executable paths and environment-variable names, but the
automatic migration refuses literal env values and credential-like args/URLs.

## Remote MCPs and OAuth

Plain remote URL MCP entries are wrapped with mcp-remote. On first use, an
OAuth-capable server may open its own authorization flow. This is expected.

Remote servers configured with bearer token environment variables or custom
HTTP headers, as well as servers using explicit Codex auth modes such as
`auth = "oauth"` or `auth = "chatgpt"`, are intentionally not
auto-migrated. Keep them direct or provide a safe stdio wrapper whose auth
semantics you control.

The wrapper version used by automatic migration is pinned so a future
mcp-remote release cannot silently change an existing generated command.

## Example

Suppose the routed inventory contains 273 tools.

Request:

    I need to generate a video with one of my connected external tools.

Jev may return:

    mode: selected
    tool: video_generation/generate_video
    confidence: 0.97

For an intentionally vague request:

    I need some external tool, but I do not know which capability.

The winning probability may remain below 0.90, so find_tool returns
fallback_full_list with the complete routed inventory.

## Failure behavior

Technical failure:

    call_tool
      -> fallbackRequired: true
      -> allTools: [...]

Semantic mismatch:

    selected tool technically succeeds
      -> agent sees it was the wrong capability
      -> list_all_tools
      -> choose from full inventory

This makes the optimization reversible on every turn.

If a downstream MCP connection becomes unhealthy, the router evicts that
session and rebuilds discovery through a fresh connection. Tool execution is
not automatically replayed after an uncertain transport failure: replaying a
mutating tool could duplicate a side effect.

## Work evaluation

The router also keeps the separate Jev workflow used to review completed work:

    "Evaluate the work with Jev."

Codex can call evaluate_work_with_jev to score:

- requirement satisfaction probability
- completion probability
- revision probability
- quality on a 0-4 rubric
- primary issue category

## Scope

The automatic setup targets external MCP servers configured under Codex
mcp_servers.

Built-in OpenAI/Codex browser, computer-use, filesystem, and internal runtime
tools remain native.

Plugin-owned tool surfaces can exist outside mcp_servers. If a plugin duplicates
a server that was moved behind the router, disable that plugin separately only
when you actually want to hide its direct tool surface.

## Configuration

See templates/router.config.example.json.

By default the runtime reads:

    ~/.codex/jev-tool-router/router.config.json

Set JEV_ROUTER_CONFIG to use an explicit config path instead.

Main options:

- model: defaults to typesafe-ai/jev
- threshold: defaults to 0.90
- maxJevChoices: defaults to 200; must remain at most 254 because the router
  reserves one Choice option for none_of_the_above
- descriptionMaxChars: tool-description characters passed to Jev
- jevStateQuestionBudgetTokens: defaults to 24000; conservative working budget
  below Jev 1.13's documented 32k `state + longest question` limit; config is
  capped at 28000 to preserve headroom
- jevTotalBudgetTokens: defaults to 48000; conservative working budget below
  Jev 1.13's documented 64k total request limit; config is capped at 56000 to
  preserve headroom
- jevContextBudgetTokens: defaults to 6000; maximum estimated optional task
  context sent into routing before truncation
- inventoryTtlMs: cached MCP inventory lifetime
- connectTimeoutMs: default downstream MCP connection timeout
- toolTimeoutMs: default downstream tool-call timeout

Per-server config can also include envVars, connectTimeoutMs, toolTimeoutMs,
enabledTools, and disabledTools. Literal env objects are intentionally rejected;
inherit secrets by environment-variable name instead.

## Related work

fast-jev-compaction by Tamara Tran uses Jev for a complementary problem:
deciding which historical tool calls/results should remain in conversation
context during compaction.

https://github.com/tamaratran/fast-jev-compaction

Jev Tool Router acts earlier in the loop: it reduces the external MCP tool
surface before tool selection.

## License

MIT.
