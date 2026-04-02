# Observability Reference

Call `mcp__sdd-autopilot__sdd_log_event` at these exact moments. No wrapper, no abstraction — just call it inline.

## Common MCP call signatures

These signatures are used throughout the pipeline. Reference by name instead of repeating the full call.

### Verbosity convention

Read tools that support `verbosity` should be called with `verbosity: "minimal"` during pipeline execution to reduce token usage. The orchestrator gets full responses only when it needs detailed data (e.g., post-pipeline scoring). Affected tools: `sdd_get_state`, `sdd_get_contract`, `sdd_evaluate_gate`, `sdd_memory_read`, `sdd_get_run_summary`, `sdd_get_analytics`, `sdd_compute_score`, `sdd_get_patterns`, `sdd_get_strategy`, `sdd_phase_confidence`.

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

### sdd_refresh_state (REFRESH)
```
sdd_refresh_state(project_path, scope="all"|"state")
```
Use after an external process writes to `state.json` directly. Forces the next `sdd_get_state` to reload from disk.

## Log event types

### 1. Phase start
At the very beginning of each phase, before reading the contract:
```
LOG(event_type="phase_start", data={ agent: "{subagent-name}", model: "{model}" })
```

### 2. Subagent launch
Immediately before invoking each subagent (Agent tool call):
```
LOG(event_type="subagent_launch", data={ agent_name: "{subagent}", model: "{model}", mode: "primary" | "opus_review" | "gate_validation" })
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

### 5. Opus review (opt-in via --opus-review)
After opus-coach returns, log the verdict before deciding whether to re-run:
```
LOG(event_type="opus_review", data={ coach_verdict: "approve" | "revise", critical_count: N, major_count: N, minor_count: N, iteration: 1 | 2 })
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

### 8. Metrics emission — Token Instrumentation Protocol

Call METRICS immediately after each phase completes (gate passed or failed definitively).

#### Step 1 — Extract the `<usage>` block

When the Agent tool returns, its completion includes a `<usage>` block:

```
<usage>total_tokens: {N}
tool_uses: {M}
duration_ms: {D}</usage>
```

Extract these three integers: `total_tokens`, `tool_uses`, `duration_ms`.

#### Step 2 — Split tokens_in / tokens_out via ratio table

The Agent tool only exposes `total_tokens`. Apply these ratios per phase to estimate the split:

| Phase     | Agent                 | input_ratio | output_ratio |
|-----------|-----------------------|-------------|--------------|
| triage    | haiku-triage          | 0.90        | 0.10         |
| specify   | spec-generator        | 0.70        | 0.30         |
| plan      | plan-architect        | 0.75        | 0.25         |
| tasks     | task-decomposer       | 0.80        | 0.20         |
| implement | implementation-engine | 0.60        | 0.40         |
| verify    | verification-engine   | 0.85        | 0.15         |
| review    | code-reviewer         | 0.80        | 0.20         |

```
tokens_in  = round(total_tokens × input_ratio)
tokens_out = total_tokens - tokens_in
```

> If Claude Code exposes `input_tokens`/`output_tokens` in the Agent response in the future, use those directly and skip the ratio table.

#### Step 3 — Calculate cost_usd per phase

Apply model pricing:

| Model  | Input / 1M tokens | Output / 1M tokens |
|--------|--------------------|---------------------|
| haiku  | $1                 | $5                  |
| sonnet | $3                 | $15                 |
| opus   | $15                | $75                 |

```
cost_usd = (tokens_in / 1_000_000) × input_price + (tokens_out / 1_000_000) × output_price
```

#### Step 4 — Call sdd_emit_metrics with complete data

NEVER call sdd_emit_metrics with `tokens_in: null` or `tokens_out: null`.

If the `<usage>` block is missing (e.g., phase was a skip or error):
- Call LOG with `type="warning"`, `message="Token instrumentation failed for phase {phase}: usage block not found"`
- ONLY in that case, pass `tokens_in: null`, `tokens_out: null`

```
started_at  = new Date().toISOString()  // capture before Agent call
t0          = Date.now()                // capture before Agent call
// ... invoke subagent via Agent tool ...
// Parse <usage> block from Agent result
// Apply ratio table (Step 2) to get tokens_in/tokens_out
// Apply model pricing (Step 3) to get cost_usd
completed_at = new Date().toISOString() // capture after Agent returns
duration_ms  = Date.now() - t0

METRICS(metrics={
  run_id, feature_id, phase, agent, model,
  started_at, completed_at, duration_ms,
  tokens_in: N,            // from Step 2 (ratio split)
  tokens_out: N,           // from Step 2 (ratio split)
  tool_calls_count: N,     // from <usage> tool_uses
  gate_result: "pass"|"fail"|"skip",
  gate_attempts: N,
  findings_count: N,
  findings_severity: [],
  fix_loop_count: N,
  delta_direction: null|"improving"|"regressing"|"stable",
  feature_type: "{type}"|null,
  complexity: "{level}"|null,
})
```

#### Step 5 — Post-run validation

After the full pipeline completes, BEFORE the retro:

1. Read `metrics.jsonl` for the current run
2. Count phases with `tokens_in: null` → must be 0
3. Count phases with `tool_calls_count: 0` when the agent clearly used tools → must be 0
4. If any validation fails: LOG `type="error"`, `message="Token instrumentation incomplete: {N} phases missing token data"`

## Verbose phase summary

> Note: The DX Output Protocol in auto-run/SKILL.md defines the mandatory output
> format. The summaries below provide guidance on WHAT to include in the one-line
> summary for each phase. The SKILL.md protocol defines HOW and WHEN to show it.

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
- If opus review (--opus-review flag) required a revision: subtract `0.1` from the above value
- If the output is marked partial or incomplete: cap at `confidence: 0.5` max

```
sdd_phase_confidence(project_path, feature_id, phase="{phase_name}",
  confidence={computed_value},
  reasoning="{why this confidence}",
  factors={ gate_attempts: N, fix_loops: N, opus_review_revised: true|false, partial_output: true|false })
```

This persists to `.sdd/runs/{feature_id}/phase_confidence.json`. The data feeds into `sdd_get_run_summary` (which computes `avg_confidence` and inline threshold alerts).
