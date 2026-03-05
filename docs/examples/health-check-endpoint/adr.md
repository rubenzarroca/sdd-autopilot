# ADR-001: Health Check as MCP Tool

**Date**: 2026-03-05
**Status**: Accepted
**Feature**: health-check-endpoint

## Context

The original feature request described a `GET /health` HTTP endpoint that would return server liveness information. The SDD Autopilot engine has no HTTP server — it is a pure MCP server using stdio transport via `@modelcontextprotocol/sdk`. There is no Express, no Fastify, and no `http.createServer()` anywhere in the codebase.

The engine already exposes 13 tools (`sdd_get_state`, `sdd_transition`, etc.) following a uniform pattern: tools are declared in `TOOLS` with a JSON Schema `inputSchema`, handlers are exported from `handlers.ts`, and responses are wrapped in `{ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }`. Adding an HTTP layer solely for a health check would introduce a new transport, a new dependency, and a new operational concern (port binding, HTTP lifecycle) that the rest of the codebase does not have.

## Alternatives Considered

**Alternative A: HTTP endpoint via `node:http`**
Add a minimal `http.createServer()` alongside the MCP stdio transport, binding to a fixed port (e.g., 3000) and responding to `GET /health`.

Pros: satisfies the original ticket literally; familiar to external monitoring tools (load balancers, uptime checkers) that expect HTTP.

Cons: adds a second transport to a single-purpose MCP server; requires port configuration, conflict avoidance, and lifecycle management (start/stop); the process is typically spawned by a Claude Code session and not long-lived in an environment with an HTTP monitor; adds operational complexity for zero observability gain given actual usage context.

**Alternative B: sdd_health MCP tool (chosen)**
Add a new MCP tool `sdd_health` following the exact same pattern as all existing tools.

Pros: zero new dependencies; zero new transports; fully consistent with the codebase architecture; testable with the existing MCP e2e test harness; the calling agent (Claude Code) can invoke it directly via the MCP protocol it already uses for all other tools.

Cons: cannot be polled by an HTTP-based external monitor; not reachable from a browser or `curl` without an MCP client. This is acceptable because the primary consumer is the orchestrator agent, not an external monitoring system.

**Alternative C: No health check at all**
The MCP SDK surfaces connection status implicitly. A tool list response confirms the server is alive.

Cons: no way to retrieve uptime or version programmatically; does not satisfy the feature request.

## Decision

Implement `sdd_health` as an MCP tool in the existing server. The tool returns `{ status: "ok", uptime_seconds: Math.floor(process.uptime()), version: <string> }` where `version` is read from `engine/package.json` once at module load time via `readFileSync`, consistent with how `contracts.json` is loaded. No HTTP server is added. No new npm dependencies are introduced. Error handling is delegated entirely to the existing dispatcher `try/catch` in `index.ts`.

## Consequences

Positive:
- The feature is delivered with changes to exactly two files (`handlers.ts`, `index.ts`) and no new dependencies.
- The implementation is testable by the existing e2e harness using the same `CallToolRequest` mechanism used to test every other tool.
- The `version` field provides a reliable way for the orchestrator to confirm it is talking to the expected engine build.
- `uptime_seconds` provides a lightweight liveness signal (non-zero value confirms the process restarted at a known time).

Negative:
- External HTTP-based monitors (uptime checkers, load balancers) cannot reach this endpoint without an MCP client. If the project ever gains an HTTP layer, a separate `GET /health` implementation would be needed.
- The tool count increases from 13 to 14; any test that hard-codes the count must be updated.
