# Spec: health-check-endpoint

## Metadata

| Field   | Value                    |
|---------|--------------------------|
| Name    | Health Check Tool        |
| Version | 1.0.0                    |
| Status  | specified                |
| Date    | 2026-03-05               |

---

## Overview

This project is a pure MCP server (stdio transport via `@modelcontextprotocol/sdk`). It has no HTTP server, no Express, no Fastify, and no `http.listen()`. The original feature request asked for `GET /health`, but HTTP endpoints do not exist in this architecture.

The feature is therefore reinterpreted as a new MCP tool named `sdd_health`, consistent with the project's existing patterns: tools registered in `TOOLS` with `inputSchema`, handlers exported from `handlers.ts` and mapped in `HANDLER_MAP`, and responses wrapped in `{ content: [{ type: "text", text: JSON.stringify(result) }] }`.

`sdd_health` returns a snapshot of server liveness: status string, uptime in seconds derived from `process.uptime()`, and the version string read from `engine/package.json` at handler initialization time (same pattern as `contracts.json` loaded via `readFileSync` at startup).

---

## Requirements

**REQ-001:** When `sdd_health` is called with no arguments, it MUST return a JSON object with a key `status` whose value is exactly the string `"ok"`.

**REQ-002:** When `sdd_health` is called with no arguments, it MUST return a JSON object with a key `uptime_seconds` whose value is a non-negative finite number equal to `Math.floor(process.uptime())` at the moment the handler executes.

**REQ-003:** When `sdd_health` is called with no arguments, it MUST return a JSON object with a key `version` whose value is the string read from the `version` field of `engine/package.json` (currently `"1.0.0"`). The value MUST be read once at module load time using `readFileSync`, the same pattern used for `contracts.json` in `handlers.ts`.

**REQ-004:** The tool entry in the `TOOLS` array in `engine/src/index.ts` MUST have `name: "sdd_health"`, a non-empty `description`, and an `inputSchema` of `{ type: "object", properties: {}, required: [] }` (no required arguments).

**REQ-005:** The handler MUST be exported from `engine/src/handlers.ts` as `handleHealth` and MUST be mapped in `HANDLER_MAP` in `engine/src/index.ts` under the key `"sdd_health"`.

**REQ-006:** The MCP response envelope for `sdd_health` MUST follow the exact same structure as all existing tools: `{ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }`. The `isError` flag MUST NOT be set on a successful call.

**REQ-007:** If any unexpected runtime error is thrown inside `handleHealth`, the MCP dispatcher (existing `try/catch` in `index.ts`) MUST catch it and return `{ content: [{ type: "text", text: JSON.stringify({ error: "<message>" }) }], isError: true }`. No additional error handling is required inside `handleHealth` itself because `package.json` is read at module load time (failure would crash the process before any call reaches the handler).

**REQ-008:** The `uptime_seconds` value MUST be a JavaScript `number` (not a string, not `null`). It MUST satisfy `Number.isFinite(uptime_seconds) && uptime_seconds >= 0`.

**REQ-009:** The response object MUST contain exactly the three keys `status`, `uptime_seconds`, and `version` — no additional keys, no missing keys.

---

## Edge Cases

**EC-001 (Extra arguments ignored):** If a caller passes unexpected arguments (e.g., `{ foo: "bar" }`), the tool MUST still return a valid response identical to a no-argument call. The MCP SDK passes `args ?? {}` to the handler; extra fields MUST be silently ignored.

**EC-002 (Uptime precision):** `process.uptime()` returns a float. The implementation MUST apply `Math.floor()` before returning so `uptime_seconds` is always an integer number. A test that calls `sdd_health` twice within one second MUST observe that `uptime_seconds` is a non-negative integer on both calls and that the second value is greater than or equal to the first.

**EC-003 (Package.json unavailable at module load):** If `engine/package.json` cannot be found or parsed when `handlers.ts` is first imported, `readFileSync` will throw and the MCP server process will fail to start. This is acceptable and consistent with how `contracts.json` is handled. No silent fallback to a hardcoded version string is permitted, as that would mask deployment errors.

**EC-004 (Concurrent calls):** Multiple simultaneous `sdd_health` calls MUST each independently read `process.uptime()` at their own execution moment. There is no shared mutable state; concurrent calls MUST NOT interfere with each other.

---

## Out of Scope

- **HTTP endpoint:** There is no HTTP server in this project. Exposing `/health` over HTTP is explicitly out of scope. Adding any HTTP server dependency (Express, Fastify, `http.createServer`) is forbidden.
- **Dependency health checks:** Checking whether `.sdd/state.json` exists, whether `contracts.json` is valid, or whether any downstream service is reachable is out of scope. The tool reports only process-level liveness.
- **Authentication or rate-limiting:** MCP tools in this server have no auth layer; `sdd_health` follows the same pattern and requires none.
- **Dynamic version re-reading:** Re-reading `package.json` on every call is out of scope. The version is read once at module load, consistent with the `contracts.json` pattern.
- **Structured logging of health calls:** Calls to `sdd_health` MUST NOT write to `.sdd/runs/*/run.log` or `signals.jsonl`. Health checks are stateless and leave no audit trail.
