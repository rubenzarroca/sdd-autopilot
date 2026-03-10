# Observability Reference

Call `mcp__sdd-autopilot__sdd_log_event` at these exact moments. No wrapper, no abstraction — just call it inline.

## Common MCP call signatures

These signatures are used throughout the pipeline. Reference by name instead of repeating the full call.

### sdd_log_event (LOG)
```
sdd_log_event(project_path, feature_id, event_type="{type}", phase="{phase}", agent_id="orchestrator",
  data={ ... })
```

### sdd_emit_metrics (METRICS)
```
sdd_emit_metrics(project_path, metrics={
  run_id, feature_id, phase, agent, model, started_at, completed_at, duration_ms,
  tokens_total, tool_calls_count, gate_result, gate_attempts, findings_count,
  findings_severity, fix_loop_count, delta_direction, feature_type, complexity
})
```

### sdd_memory_write (MEM_WRITE)
```
sdd_memory_write(project_path, scope="project", content="...", section="...")
```

## Log event types

### 1. Phase start
At the very beginning of each phase, before reading the contract:
```
LOG(event_type="phase_start", data={ agent: "{subagent-name}", model: "{model}" })
```

### 2. Subagent launch
Immediately before invoking each subagent (Agent tool call):
```
LOG(event_type="subagent_launch", data={ agent_name: "{subagent}", model: "{model}", mode: "primary" | "pair_review" | "gate_validation" })
```

### 3. State transition
Immediately after every successful `sdd_transition` call:
```
LOG(event_type="state_transition", data={ from_state: "{from}", to_state: "{to}", triggered_by: "{agent_id}" })
```

### 4. Phase complete
After gate passes and transition is done:
```
LOG(event_type="phase_complete", data={ gate_result: "passed" | "failed", duration_note: "N subagent calls" })
```

### 5. Pair review
After opus-coach returns, log the verdict before deciding whether to re-run:
```
LOG(event_type="pair_review", data={ coach_verdict: "approve" | "revise", critical_count: N, major_count: N, minor_count: N, iteration: 1 | 2 })
```

### 6. Fix loop iteration
At the start of each fix loop attempt, after delta_check:
```
LOG(event_type="fix_loop_iteration", data={ attempt_number: N, max_attempts: N, failure_category: "implementation_bug" | "spec_gap" | "infra_issue", delta_check_result: "continue" | "abort" })
```

### 7. Escalation or pause
Before any escalation transition or awaiting_input pause:
```
LOG(event_type="escalation", data={ reason: "{human-readable reason}", failure_mode: "{SPEC_GAP|TASK_BLOCKED|...}", action: "escalated" | "awaiting_input" })
```

### 8. Metrics emission (after each phase)

Call METRICS immediately after each phase completes (gate passed or failed definitively).

**Instrumentation pattern:**

When the Agent tool returns, its completion summary includes token count and tool uses (e.g. `Done (17 tool uses · 23.2k tokens · 2m 7s)`). Parse these values from the Agent result to populate `tokens_total` and `tool_calls_count`.

```
started_at  = new Date().toISOString()  // capture before Agent call
t0          = Date.now()                // capture before Agent call
// ... invoke subagent via Agent tool ...
// Parse from Agent result: "{N} tool uses · {N}k tokens · {duration}"
completed_at = new Date().toISOString() // capture after Agent returns
duration_ms  = Date.now() - t0

METRICS(metrics={
  run_id, feature_id, phase, agent, model,
  started_at, completed_at, duration_ms,
  tokens_total: N,         // parsed from Agent result (e.g. 23200 from "23.2k tokens")
  tool_calls_count: N,     // parsed from Agent result (e.g. 17 from "17 tool uses")
  gate_result: "pass"|"fail"|"skip",
  gate_attempts: N,        // 1 if first attempt, 2+ if fix loop
  findings_count: N,       // from verify/review structured output; 0 for other phases
  findings_severity: [],   // ["critical", "major", "minor"] from verify/review; [] for other phases
  fix_loop_count: N,       // 0 if passed on first try
  delta_direction: null|"improving"|"regressing"|"stable",
  feature_type: "{type}"|null,
  complexity: "{level}"|null,
})
```

## Verbose phase summary

After each phase completes, output a human-readable summary to the terminal:
```
Phase {N}/{total} [{phase_name}] completed ({duration})
  -> {primary artifact produced}
  -> {key metrics}
  -> Gate: {gate_type} {pass|fail} (confidence: {conf})
```

Adapt the content line based on the phase:
- **triage**: `-> Mode: {express|light|standard|full}, Type: {feature_type}, Complexity: {complexity}`
- **specify**: `-> {N} FRs, {N} NFRs, {N} edge cases, {N} open questions`
- **plan**: `-> Plan: specs/{feature}/plan.md, ADR: docs/adr/NNN-*.md`
- **tasks**: `-> {N} tasks decomposed, {N} waves`
- **implement**: `-> {N}/{N} tasks completed, Files: {list of modified files}`
- **verify**: `-> Tests: {pass|fail}, Coverage: {summary}`
- **review**: `-> Verdict: {APPROVE|REQUEST_CHANGES}, Findings: {N} ({severity breakdown})`
- **pr**: `-> PR: {url}`

This summary is for the USER, not for logging. It goes to stdout, not to sdd_log_event.

## Phase confidence

Call `sdd_phase_confidence` after each gate pass. Assign confidence based on how the phase resolved:

- Gate passed clean (first attempt, no fix loops): `confidence: 0.85`
- Gate passed after 1 fix loop: `confidence: 0.65`
- Gate passed after 2+ fix loops: `confidence: 0.45`
- If pair review (opus-coach) required a revision: subtract `0.1` from the above value
- If the output is marked partial or incomplete: cap at `confidence: 0.5` max

```
sdd_phase_confidence(project_path, feature_id, phase="{phase_name}",
  confidence={computed_value},
  reasoning="{why this confidence}",
  factors={ gate_attempts: N, fix_loops: N, pair_review_revised: true|false, partial_output: true|false })
```

This persists to `.sdd/runs/{feature_id}/phase_confidence.json`. The data feeds into `sdd_get_run_summary` (which computes `avg_confidence`) and `sdd_check_thresholds`.
