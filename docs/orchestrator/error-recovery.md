# Error Recovery Reference

## Transition error recovery

If `sdd_transition` returns an error:

1. **UNAUTHORIZED**: Log the error. Consult the delegation table to find the correct agent. Spawn that agent to call `sdd_transition`.
2. **INVALID_TRANSITION**: Log the error. Escalate to the user — the state machine does not support this path.
3. **PRECONDITION_FAILED**: Log the error. Fix the precondition (e.g. register tasks, create worktree) and retry.
4. **CIRCUIT_BREAKER**: Do NOT retry. Escalate immediately.

**NEVER edit state.json to bypass a failed transition.** The state machine in `state.ts` is the single source of truth. Direct edits bypass governance, skip precondition checks, and corrupt the audit trail. The only acceptable direct writes to state.json are: creating the initial feature entry and registering tasks after decomposition.

## Escalation protocol

1. Write escalation report to `.sdd/escalation/{feature}/{timestamp}.md`
2. Include: current state, last agent, error code, diagnosis, suggested human action
3. Transition to `escalated`. Halt all agents. Report to user.

## Error Translation

When an MCP tool returns an error, NEVER show the raw JSON to the developer. Translate using these patterns:

**Transition errors** (`ok: false, code`):
- `PRECONDITION_FAILED` → ❌ Can't move to [{target}]: {reason}. {suggested_action}.
- `INVALID_TRANSITION` → ❌ Invalid transition: {from} → {to}. Allowed: {allowed_transitions}.
- `CIRCUIT_BREAKER` → ❌ Circuit breaker tripped on [{phase}] after repeated failures. Pipeline stopped. Review `.sdd/escalation/` for diagnosis.
- `UNAUTHORIZED` → ❌ Agent not allowed to perform this transition. This is an orchestrator bug — report it.

**Not-found errors** (`"X not found"`):
- Feature → ❌ Feature "{X}" doesn't exist. Check the feature name or run `/sdd-auto:init`.
- Pattern/Experiment → ❌ {type} "{X}" not found. Ignore if this is a first run.

**File/data errors** (`"metrics.jsonl not found"`, `"summary.json not found"`):
- → ❌ Missing {file}. A previous phase likely didn't complete. Re-run or check `.sdd/` directory.

**Catch-all** (any error not matching above):
- → ❌ Unexpected error: {message}. Check MCP server logs for details.

Every error shown to the developer must: (1) start with ❌, (2) say WHAT happened, (3) say WHAT TO DO next. Never show JSON payloads, error codes, or internal field names.
