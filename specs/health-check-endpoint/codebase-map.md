# Codebase Map — sdd-autopilot

## Tech stack
- **Runtime**: Node.js (ESM modules, `"type": "module"`)
- **Language**: TypeScript 5.7, compiled to `engine/build/`
- **MCP SDK**: `@modelcontextprotocol/sdk` ^1.12.1 (stdio transport)
- **Entry point**: `engine/build/index.js` (MCP server, no HTTP server, no framework)

## Project structure
```
sdd-autopilot/
├── engine/
│   ├── src/
│   │   ├── index.ts         — MCP Server entry, tool definitions + dispatcher
│   │   ├── handlers.ts      — 13 tool handler functions (sdd_*)
│   │   ├── state.ts         — StateManager: read/write .sdd/state.json, AGENT_PERMISSIONS
│   │   ├── memory.ts        — 2-layer memory manager (.sdd/memory.md)
│   │   ├── types.ts         — Shared TypeScript types
│   │   └── contracts.json   — 11 phase contracts (single source of truth)
│   ├── build/               — Compiled JS output
│   └── package.json
├── .claude/agents/          — 9 subagent mission briefs
├── skills/                  — 3 skills (auto-run, auto-init, auto-status)
├── .sdd/                    — Runtime state (state.json, memory.md, runs/)
└── specs/                   — Feature specs per run
```

## Key patterns
- **No HTTP server**: this is a pure MCP server over stdio. No Express, no Fastify, no http module.
- **No REST endpoints**: all tools are MCP tool calls, not HTTP routes.
- **Tool responses**: all handlers return plain JS objects; `index.ts` wraps them in `{ content: [{ type: "text", text: JSON.stringify(result) }] }`.
- **State persistence**: `.sdd/state.json` via `StateManager` in `state.ts`. Handlers call `StateManager.read()` / `StateManager.write()`.
- **Observability**: `sdd_log_event` appends JSON lines to `.sdd/runs/{feature_id}/run.log`.

## CRITICAL: No existing HTTP/health endpoint pattern
This project is an **MCP server**, not an HTTP server. There is no existing GET /health pattern, no Express app, no server listen() call. Any "health check endpoint" feature must be evaluated against the actual architecture — an MCP server exposes tools, not HTTP routes. The feature as described (GET /health returning JSON) would require adding an HTTP server alongside the MCP stdio server OR reinterpreting as an MCP tool `sdd_health` that returns status/uptime/version.
