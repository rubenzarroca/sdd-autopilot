# Tasks: Health Check Tool

**Feature**: health-check-endpoint
**Plan**: specs/health-check-endpoint/plan.md
**Generated**: 2026-03-05

---

## TASK-001: Add ENGINE_VERSION constant to handlers.ts

**Status**: pending
**Requirements**: REQ-003, EC-003
**Complexity**: S
**Depends on**: none
**Files**: engine/src/handlers.ts

### Description
Add a module-level constant `ENGINE_VERSION` immediately after the existing `contracts.json` load block (after line 28). Use `resolve(__dirname, "..", "package.json")` to locate `engine/package.json` and read it once with `readFileSync` at import time. All required imports (`readFileSync`, `resolve`, `__dirname`) are already present in the file; no new imports are needed.

### Validation
After `tsc` build, running `node -e "import('./build/handlers.js').then(m => console.log(typeof m))"` completes without error. If `engine/package.json` is temporarily renamed, the process exits non-zero (EC-003 behavior confirmed).

---

## TASK-002: Add handleHealth export to handlers.ts

**Status**: pending
**Requirements**: REQ-001, REQ-002, REQ-005, REQ-006, REQ-007, REQ-008, REQ-009, EC-001, EC-002, EC-004
**Complexity**: S
**Depends on**: TASK-001
**Files**: engine/src/handlers.ts

### Description
Append the exported `handleHealth` function at the end of `handlers.ts`, after `handleAppendSignal`. The function signature must be `export async function handleHealth(_params: Record<string, unknown>): Promise<unknown>`. The body returns exactly `{ status: "ok", uptime_seconds: Math.floor(process.uptime()), version: ENGINE_VERSION }` — no try/catch, no extra keys. The `_params` argument is accepted but never read, satisfying EC-001 (extra arguments ignored).

### Validation
Direct call `await handleHealth({})` returns an object where: `result.status === "ok"`, `Number.isInteger(result.uptime_seconds) && result.uptime_seconds >= 0`, `result.version === "1.0.0"`, and `Object.keys(result).length === 3`. Call `await handleHealth({ foo: "bar" })` returns identical shape (EC-001). Two sequential calls both return integer uptime with second value >= first (EC-002).

---

## TASK-003: Register sdd_health in index.ts (import + TOOLS + HANDLER_MAP)

**Status**: pending
**Requirements**: REQ-004, REQ-005, REQ-006, REQ-007
**Complexity**: S
**Depends on**: TASK-002
**Files**: engine/src/index.ts

### Description
Make three co-located changes to `index.ts`. First, add `handleHealth` to the named import from `./handlers.js` (line 28 area). Second, append a new entry to the `TOOLS` array with `name: "sdd_health"`, a non-empty description, and `inputSchema: { type: "object" as const, properties: {}, required: [] }`. Third, add `sdd_health: handleHealth` to `HANDLER_MAP`. These three changes are inseparable because they all register the same tool in the same file; splitting them would leave the server in a broken intermediate state.

### Validation
After `tsc` build, `node -e "import('./build/index.js')"` starts without error (or rather, the MCP server starts and the process does not exit with code 1). A `ListToolsRequest` sent to the running server returns an array that includes an entry with `name: "sdd_health"` and `inputSchema.required` equal to `[]`.

---

## TASK-004: Add sdd_health test case to test-e2e.mjs

**Status**: pending
**Requirements**: REQ-001, REQ-002, REQ-003, REQ-004, REQ-005, REQ-006, REQ-008, REQ-009, EC-001, EC-002, EC-004
**Complexity**: M
**Depends on**: TASK-002, TASK-003
**Files**: engine/test-e2e.mjs

### Description
Add a new test section `=== Test 13: sdd_health ===` after the existing Test 12 block and before the cleanup section. Import `handleHealth` alongside the existing handler imports at the top of the file. The test section must call `handleHealth` directly (same pattern as all other tests) and assert: `status === "ok"`, `Number.isInteger(uptime_seconds) && uptime_seconds >= 0`, `version === JSON.parse(readFileSync("engine/package.json","utf-8")).version`, `Object.keys(result).length === 3`, extra-args call returns identical shape, and two sequential calls both return valid non-negative integers with second >= first. Also update the stale comment on line 1 from "11 sdd_* tools" to "14 sdd_* tools" to keep it accurate.

### Validation
Running `node engine/test-e2e.mjs` from the project root exits with code 0 and prints `ALL TESTS PASSED`. The output includes a `=== Test 13: sdd_health ===` section with all assertions marked `+`. The total passed count increases by the number of new assertions added.

---
