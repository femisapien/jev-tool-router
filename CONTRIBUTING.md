# Contributing

Issues and pull requests are welcome.

Before submitting a change:

    npm install
    npm run check
    npm test

Do not commit:

- AI Gateway keys
- router.config.json from a real machine
- OAuth tokens
- personal MCP credentials
- machine-specific config backups

Keep routing changes conservative. When uncertain, prefer full-list fallback
over a forced tool selection.
