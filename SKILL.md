---
name: jev-tool-router
description: Install, configure, or maintain a Jev-powered MCP tool router for Codex. Use when the user wants to reduce external MCP tool-schema context, route tool discovery through TypeSafe AI Jev, hide large MCP inventories behind a small router surface, or add confidence-gated tool selection with compact searchable fallback.
---

# Jev Tool Router

This skill installs a small MCP proxy in front of external Codex MCP servers.
The router asks TypeSafe AI Jev to select the best external tool from tool names
and descriptions before exposing the selected tool's full input schema.

## Routing policy

1. The agent describes the external capability it needs.
2. find_tool sends the request plus routed tool names and descriptions to Jev.
3. Before each Jev call, constrain optional context and candidate batches to
   conservative token budgets derived from Jev's documented request limits.
4. If the winning probability is at least the configured threshold, default
   0.90, return only that tool and its full input schema.
5. Otherwise return a bounded lexical/BM25 shortlist, default 12 candidates.
6. If execution fails, return fallbackRequired=true with a compact alternative
   shortlist and targeted-discovery guidance.
7. If the shortlist is insufficient, use search_tools, then paginated
   list_servers and list_tools. Keep list_all_tools as an explicit last resort.
8. If execution succeeds but the tool was semantically wrong, search again
   rather than immediately loading the full inventory.

## Safety invariants

- Never print, commit, or write AI_GATEWAY_API_KEY into Codex config.
- Keep built-in Codex/OpenAI tools native. The setup excludes node_repl,
  cua_repl, codex_app, and jev_router by default.
- Preview migration before applying it.
- Back up ~/.codex/config.toml and ~/.codex/AGENTS.md before mutation.
- Do not automatically migrate remote MCP entries that depend on custom bearer
  headers, custom HTTP headers, or explicit Codex auth modes such as oauth or
  chatgpt.
- Do not automatically migrate stdio MCP entries containing literal env
  values. They may contain credentials. env_vars names are safe to inherit.
- Do not automatically migrate stdio args or remote URLs that appear to embed
  credentials.
- Keep disabled/required MCPs and MCPs with custom Codex approval/output
  policy direct unless their semantics can be preserved explicitly.
- Preserve eligible enabled_tools, disabled_tools, startup timeouts, and tool
  timeouts when moving a server behind the router.
- Store generated router configuration under
  ~/.codex/jev-tool-router/router.config.json, not inside the repository.
- Merge newly migrated servers with the existing routed inventory on reruns;
  never replace previously routed servers accidentally.
- If Codex already has a jev_router entry, verify its command and launcher path
  match this installation before applying any migration. Fail closed on a
  stale or unrelated same-name registration.
- Keep human confirmation behavior for mutating downstream tools.
- Use call_readonly_tool only when the upstream MCP explicitly declares
  readOnlyHint=true.
- Do not blindly retry an uncertain mutating tool call after a transport
  failure. Evict the unhealthy session and fall back to discovery instead.
- Jev Choice supports at most 255 options. This router reserves one choice for
  none_of_the_above and uses conservative tournament routing for larger
  inventories.
- Jev 1.13 documents 64k tokens per request and 32k for state plus the longest
  question. Default working budgets are 48k total and 24k for state + longest
  question, leaving explicit headroom below the provider limits.
- Optional routing context is capped at an estimated 6k tokens by default.
  Context truncation is surfaced in routingUsage; the required capability
  request is never silently truncated.
- Candidate groups are sized by both the Choice option limit and the estimated
  serialized Jev payload size. Large inventories can therefore use multiple
  tournament rounds rather than assuming a fixed 200-tool batch always fits.
- Low-confidence, none-of-the-above, Jev-error, and downstream-call fallback
  paths must stay bounded. Never embed the complete routed inventory
  automatically in those responses.
- Do not echo arbitrary upstream MCP error bodies in fallback responses. Keep
  diagnostics bounded/redacted and unavailable-server summaries capped.
- Deterministic fallback discovery ranks compact tool metadata and defaults to
  12 candidates. Broader discovery must be explicit through search_tools,
  list_servers, paginated list_tools, or finally list_all_tools.
- Estimate preflight size pessimistically at one token per serialized UTF-8
  byte. Provider-reported usage is observability only and must never be used to
  relax the preflight budget.
- Tournament confidence is the minimum confidence along the winning path.
- Every routing choice includes none_of_the_above to avoid forced-choice false
  positives.

## Installation workflow

Work from this skill directory.

1. Check Node.js is at least 22 and Codex is installed.
2. Install dependencies:

       npm install

3. Run local validation:

       npm run check
       npm test

4. Confirm AI_GATEWAY_API_KEY is available without printing its value.
5. Preview which Codex MCP servers would move behind the router:

       npm run setup:codex

6. If the user has authorized installation and config changes, apply:

       npm run setup:codex -- --apply

   Keep specific MCPs direct with:

       npm run setup:codex -- --apply --exclude=my_server,another_server

7. Check the routed inventory:

       npm run status

8. Restart or reload Codex so its MCP surface refreshes.
9. Verify codex mcp list shows jev_router and no duplicate direct MCPs that
   were migrated.
10. Test a natural external-tool request without naming the router. Codex
    should call jev_router/find_tool first.

The apply step is designed to be rerunnable. Existing routed servers are read
from ~/.codex/jev-tool-router/router.config.json and merged with newly eligible
servers before direct MCP entries are removed.

## Agent behavior after installation

For external MCP capabilities:

- Call jev_router/find_tool first.
- When it returns mode selected, use the returned schema.
- Prefer jev_router/call_readonly_tool for tools explicitly marked read-only.
- Use jev_router/call_tool for mutating or unclassified tools.
- When find_tool returns fallback_shortlist, inspect the bounded candidates.
- If the shortlist is unclear, call jev_router/search_tools with a more
  specific capability query.
- Use jev_router/list_servers and paginated jev_router/list_tools to expand
  discovery without loading the full inventory.
- When a routed call returns fallbackRequired=true, inspect its compact
  shortlist or search again.
- If the selected tool worked technically but did not satisfy the capability,
  search again rather than immediately expanding everything.
- Use jev_router/list_all_tools only as an explicit last resort.
- Use jev_router/get_tool_schema when a discovered tool's full schema is needed.

When the user asks to evaluate the work with Jev, use
jev_router/evaluate_work_with_jev.

## Plugin-provided tools

Codex plugins can expose tools outside the mcp_servers config. The setup script
cannot safely hide arbitrary plugin-owned tool surfaces. If a plugin duplicates
an MCP that has moved behind the router, inspect it and disable that plugin
separately only with the user's authorization.
