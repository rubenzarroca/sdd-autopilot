# Plan: Health Check Tool (sdd_health)

## Architecture

The MCP server (`engine/src/index.ts`) exposes all capabilities as tools registered in a `TOOLS` array and dispatched through `HANDLER_MAP`. Handlers live in `engine/src/handlers.ts` and are imported at the top of `index.ts`. This plan adds exactly one new tool — `sdd_health` — following that pattern with zero structural changes to the server.

Data flow for a `sdd_health` call:

1. MCP client sends `CallToolRequest` with `name: "sdd_health"` and optional arguments.
2. `index.ts` dispatcher looks up `HANDLER_MAP["sdd_health"]` — finds `handleHealth`.
3. Dispatcher calls `await handler(args ?? {})` inside the existing `try/catch`.
4. `handleHealth` reads `process.uptime()`, applies `Math.floor`, constructs the result object, and returns it.
5. Dispatcher wraps the return value: `{ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }` — identical to every other tool.
6. On unexpected error the existing `catch` block sets `isError: true` automatically; no error handling is needed inside `handleHealth`.

The `version` string is read once at module load time via `readFileSync` pointed at `engine/package.json`, mirroring how `contracts.json` is loaded. If the file is absent at startup the process fails to start, which is the specified and correct behavior (EC-003).

No new dependencies are required. All node built-ins (`node:fs`, `node:path`, `node:url`) are already imported in `handlers.ts`.

## Dependencies

No new npm packages. All runtime capabilities are already present:

- `readFileSync` from `node:fs` — already imported in `handlers.ts` (line 11)
- `fileURLToPath` from `node:url` — already imported in `handlers.ts` (line 12)
- `dirname`, `resolve` from `node:path` — already imported in `handlers.ts` (line 13)
- `__filename`, `__dirname` — already computed in `handlers.ts` (lines 17-18)
- `process.uptime()` — Node.js global, no import needed

`engine/package.json` version field is `"1.0.0"` as of the current state.

## Files Affected

### engine/src/handlers.ts [modify]

Add a module-level constant that reads `engine/package.json` once at import time:

```
const pkgPath = resolve(__dirname, "..", "package.json");
const ENGINE_VERSION: string = JSON.parse(readFileSync(pkgPath, "utf-8")).version;
```

Then add the exported handler (append after the existing handlers, before or after `handleAppendSignal`):

```
export async function handleHealth(_params: Record<string, unknown>): Promise<unknown> {
  return {
    status: "ok",
    uptime_seconds: Math.floor(process.uptime()),
    version: ENGINE_VERSION,
  };
}
```

The function accepts `_params` to match the `HandlerFn` signature. No try/catch. Exactly three keys in the returned object (REQ-009).

### engine/src/index.ts [modify]

Two changes:

1. Add `handleHealth` to the named import from `./handlers.js` (join the existing list at lines 14-28).

2. Add a new entry to `TOOLS` (append after the last existing tool entry):

```typescript
{
  name: "sdd_health",
  description: "Return server liveness: status, uptime in seconds, and engine version.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
},
```

3. Add a new entry to `HANDLER_MAP`:

```
sdd_health: handleHealth,
```

No other files require modification.

## Test Strategy

Each spec requirement maps to a verifiable assertion:

| Requirement | Verification |
|---|---|
| REQ-001: `status === "ok"` | Parse `content[0].text`; assert `result.status === "ok"` |
| REQ-002: `uptime_seconds` is `Math.floor(process.uptime())` | Assert `Number.isInteger(result.uptime_seconds) && result.uptime_seconds >= 0` |
| REQ-003: `version === "1.0.0"` | Assert `result.version === require("../package.json").version` |
| REQ-004: TOOLS entry has correct shape | Inspect the `ListToolsRequest` response for the `sdd_health` entry |
| REQ-005: handler exported and mapped | Import `handleHealth` from `handlers.js`; call it directly |
| REQ-006: response envelope | Assert `content[0].type === "text"` and `isError` is absent/falsy |
| REQ-007: dispatcher error catch | Unit-test with a mock that throws; verify `isError: true` in response |
| REQ-008: `uptime_seconds` is finite number | `Number.isFinite` + `>= 0` assertion |
| REQ-009: exactly three keys | `Object.keys(result).length === 3` |
| EC-001: extra args ignored | Call with `{ foo: "bar" }`; assert same output |
| EC-002: `Math.floor` applied | Two sequential calls; assert both values are integers, second `>=` first |
| EC-004: concurrent calls | `Promise.all([handleHealth({}), handleHealth({})])`; assert both resolve independently |

The existing `test-e2e.mjs` can be extended with a `testHealth()` case that spawns the MCP server and sends a `CallToolRequest` for `sdd_health`.

## Risks and Trade-offs

**Risk 1 — `package.json` path resolution after TypeScript build**
The compiled output is at `build/index.js` and `build/handlers.js`; `__dirname` inside the build directory is `engine/build/`. The `package.json` is at `engine/package.json`, so the correct relative path from `__dirname` is `"../package.json"`. This mirrors the fallback pattern used for `contracts.json` (`resolve(__dirname, "..", "src", "contracts.json")`). If the path is wrong the server fails at startup — loud and immediate, not a silent bug.
Mitigation: use `resolve(__dirname, "..", "package.json")` and verify manually by running the built server once.

**Risk 2 — `uptime_seconds` precision drift in tests**
`process.uptime()` is a float; `Math.floor` is applied in the handler. Any test that records an expected uptime before calling the tool will see a value `>=` but not necessarily `===` the pre-recorded value because time passes during the MCP round-trip.
Mitigation: tests must assert `Number.isInteger` and `>= 0` rather than an exact value. The EC-002 sequential-call test asserts `second >= first`, not equality.

**Risk 3 — Tool count in smoke tests**
If `test-e2e.mjs` asserts an exact tool count (e.g., `tools.length === 13`), adding `sdd_health` will increment it to 14 and break that assertion.
Mitigation: search `test-e2e.mjs` for hard-coded tool counts before implementing, and update any such assertion.

## Decision

See `docs/adr/001-health-check-as-mcp-tool.md`
