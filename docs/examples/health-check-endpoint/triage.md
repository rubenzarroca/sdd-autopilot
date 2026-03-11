# Triage Result — health-check-endpoint

## TRIAGE_RESULT

```json
{
  "complexity": "medium",
  "estimated_tasks": 4,
  "estimated_files": 3,
  "regression_risk": "medium",
  "estimated_tokens": 1200,
  "proceed": true,
  "reason": "Feature requires architecture clarification (HTTP endpoint vs MCP tool) before implementation."
}
```

## Critical Finding

**Architecture Mismatch**: The feature description asks for "GET /health endpoint" (HTTP REST pattern), but this project is a **pure MCP server over stdio transport**. There is no HTTP server, no framework, no `listen()` call anywhere in the codebase.

### Two Valid Interpretations

#### Option A: Add HTTP server (HIGH COMPLEXITY, NOT RECOMMENDED)
- Requires adding Express, Fastify, or bare `http` module
- Introduces new runtime behavior (dual listeners: stdio MCP + HTTP)
- Adds operational overhead (port management, process lifecycle complexity)
- Breaks from project's pure MCP design
- Estimated: 8-12 tasks, medium regression risk

#### Option B: Implement as MCP tool `sdd_health` (RECOMMENDED)
- Aligns with existing pattern (36 sdd_* tools)
- Returns `{status, uptime_seconds, version}` as JSON from tool response
- Requires: 1 handler function, 1 schema entry, uptime tracking in state
- Estimated: 3-4 tasks, low regression risk
- This is the **intended interpretation** for this pure MCP server

## Recommendation

**Clarify the spec before proceeding.** If the request truly means HTTP, this is a fundamental architecture change. If it means "provide health status in MCP format," the feature is straightforward.

## Estimated Tasks (assuming Option B: MCP tool)

1. Add `sdd_health` tool schema to `index.ts`
2. Implement `handleHealth()` in `handlers.ts`
3. Store process start timestamp in `.sdd/state.json` metadata (on first server startup)
4. Read version from `engine/package.json` at runtime

## Affected Files

- `engine/src/index.ts` — add tool definition
- `engine/src/handlers.ts` — add handler function
- `engine/src/state.ts` — optionally track uptime
- `engine/package.json` — no changes (read at runtime)

## Regression Risk

**Medium** — Adding a new tool is low-risk by itself (no change to existing handlers), but uptime tracking in state requires careful initialization to avoid race conditions on first run.

## Next Step

Request spec clarification: "Should health check be an MCP tool `sdd_health` or an HTTP GET endpoint?" Current architecture strongly favors MCP tool interpretation.
