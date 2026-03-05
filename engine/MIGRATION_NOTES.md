# Migration Notes: PTC CLI -> MCP Server

## What changed

- `index.ts`: Rewrote from PTC pipeline orchestrator to MCP server with stdio transport using `@modelcontextprotocol/sdk`
- `handlers.ts`: Replaced 9 PTC tool handlers (read_file, write_file, etc.) with 11 `sdd_*` MCP tool handlers
- `phase.ts`: Deleted (PTC agentic loop runner)
- `tools.ts`: Deleted (PTC tool definitions with allowed_callers)
- `package.json`: Replaced `@anthropic-ai/sdk` with `@modelcontextprotocol/sdk`
- `test-e2e.mjs`: Rewritten to test all 11 handlers directly (92 assertions)

## Files preserved (no changes)

- `state.ts` — StateManager + AGENT_PERMISSIONS (exported for handlers)
- `contracts.json` — 11 phase contracts
- `memory.ts` — MemoryManager (two-layer memory)
- `observability.ts` — RunLogger (still available but not directly used by MCP handlers; sdd_log_event writes to per-feature run dirs)
- `tasks.ts` — parseTasks/computeWaves
- `types.ts` — all shared types
- `git.ts` — worktree operations
- `prompts/` — all prompt builders (not used by MCP server but kept for potential skill use)

## Design decisions

1. **contracts.json loading**: Loaded synchronously at startup via `readFileSync`. Fallback path tries `../src/contracts.json` for dev scenarios where build dir doesn't have the JSON file. Also added a `cp` step to copy contracts.json to build/.

2. **sdd_delta_check state storage**: Uses an ad-hoc `fix_loop_history` array field on the FeatureEntry in state.json. This extends the state schema minimally without requiring a types.ts change (cast via `as any`).

3. **sdd_evaluate_gate semantic checks**: The gate evaluator handles mechanical checks (file exists, section non-empty, JSON valid, emitted artifacts, task completion). For checks requiring semantic understanding (e.g., "plan covers all spec requirements", "no circular dependencies"), it returns `needs_semantic_validation` so the calling agent can invoke a validator.

4. **sdd_append_signal dual storage**: Signals go to both `.sdd/runs/{feature_id}/signals.jsonl` (new, file-based) AND state.json (via StateManager.appendSignal). The MCP handler uses the file-based approach for append-only guarantees. The state.json signals array is still populated by direct StateManager calls.

5. **sdd_log_event path**: Logs go to `.sdd/runs/{feature_id}/run.log` (per-feature) rather than the global `.sdd/run.log` used by the old RunLogger. This allows parallel feature runs without log interleaving.

6. **prompts/ directory kept**: The 16 prompt builder files are not imported by the MCP server but are kept in the repo. They may be useful if skills or subagents need to construct prompts.

## Entry point unchanged

The server still starts with `node build/index.js`. The bin field in package.json still points there. Skills and plugin.json do not need to change invocation.
