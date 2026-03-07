---
name: sdd-auto:run
description: >
  Run the full SDD Autopilot pipeline: triage -> specify -> plan -> tasks -> implement -> verify -> review -> PR.
  Zero stops, fully autonomous. Orchestrates subagents via Claude Code native agent system and MCP tools.
  Use when the user says "auto run", "autopilot", "sdd auto", "build this feature autonomously",
  or runs /sdd-auto:run.
argument-hint: '"<feature description>" [--skip-worktree] [--skip-pr]'
user-invokable: true
---

# /sdd-auto:run — SDD Autopilot Orchestrator

You are the orchestrator for the SDD Autopilot pipeline. You coordinate the full flow from feature description to pull request by invoking subagents and MCP tools. You do not implement, review, or specify — you only coordinate.

## What to do

1. Parse the feature description from `$ARGUMENTS`. If empty, ask the user what feature they want to build.
2. Determine the project path. Use the current working directory unless the user specified a different path. **Generate a `run_id`** using the format `{feature_id}-{unix-timestamp-ms}` (e.g., `health-check-endpoint-1741189200000`). The feature_id comes from step 1. Store `run_id` in memory for this pipeline run — it must be passed to every `sdd_emit_metrics` call.
3. **Auto-initialize if needed**: Call `mcp__sdd-autopilot__sdd_get_state` with the project path.
   - If it returns an error indicating the project is not initialized (e.g., state.json missing or "not initialized"), **do not ask the user** — silently create `.sdd/state.json` with this content and continue:
     ```json
     {
       "version": "2.0.0",
       "project": "{directory-name}",
       "initialized_at": "{ISO timestamp}",
       "active_feature": null,
       "features": {}
     }
     ```
   - After creating the file, call `sdd_get_state` again to confirm it loaded correctly before proceeding.
   - Report to the user: "Project not initialized — auto-initialized at {path}. Starting pipeline..."
4. **Create the feature entry**: Before calling any MCP tool that operates on a feature, add the feature to `state.json` by writing it directly (there is no `sdd_create_feature` tool). The feature entry MUST use this exact schema — missing fields will cause `sdd_transition` to crash:
   ```json
   "{feature-id}": {
     "state": "draft",
     "spec_path": "specs/{feature-id}/spec.md",
     "transitions": [],
     "tasks": {},
     "signals": [],
     "verification_attempts": 0,
     "review_attempts": 0,
     "fix_loop_attempts": 0,
     "fix_review_attempts": 0
   }
   ```
   Also set `"active_feature": "{feature-id}"` at the top level. The feature ID is derived from the feature description: lowercase, hyphen-separated, max 40 chars (e.g., "health-check-endpoint").
   After writing, call `sdd_get_state` with `feature_id` to confirm the entry is readable.
5. Execute the pipeline phases in order (see below).
4. Communicate progress to the user at each phase transition.

## Pipeline phases

Execute these phases sequentially. Each phase follows the same protocol:

### Phase protocol

For each phase:

1. Call `mcp__sdd-autopilot__sdd_get_state` to read the current feature state
2. Call `mcp__sdd-autopilot__sdd_get_contract` for the current phase to get: required inputs, optional inputs, gate checks, pair_review config, fix_loop config
3. Call `mcp__sdd-autopilot__sdd_memory_read` with the memory sections indicated by the contract's optional inputs
4. Read the artifact files indicated as required inputs by the contract
5. If the contract has `pair_review.enabled = true`:
   a. Launch the phase's subagent with the prepared context
   b. Launch `opus-coach` with the produced artifact and the stage name
   c. If opus-coach feedback contains any "critical" severity finding: re-launch the phase subagent with the v1 artifact + feedback for correction
6. If no pair_review: launch the subagent directly
7. Call `mcp__sdd-autopilot__sdd_evaluate_gate` with the produced artifacts
8. If gate passed:
   - For phases with `gate.type = "mechanical"` or `"haiku-validator"`: call `mcp__sdd-autopilot__sdd_transition` to move to the next state
   - For phases with `gate.type = "self"` (verify, review): the transition depends on the subagent's structured output:
     - verify: VERIFICATION_RESULT.status=PASS → call `sdd_transition(verifying→reviewing)`. FAIL/SPEC_GAP → go to step 9.
     - review: REVIEW_RESULT.decision=APPROVE → call `sdd_transition(reviewing→pr_created)`. REQUEST_CHANGES → call `sdd_transition(reviewing→fix_review)` then enter fix loop.
   - Call `mcp__sdd-autopilot__sdd_emit_metrics` with the PhaseMetrics for this phase (see Observability section below for the schema)
   - Call `sdd_log_event` with event_type `"phase_complete"`, data `{ gate_result: "passed", phase }` (see Observability section)
   - Call `mcp__sdd-autopilot__sdd_phase_confidence` to record the orchestrator's confidence in this phase's output. Assign confidence based on how the phase resolved:
     - Gate passed clean (first attempt, no fix loops) → `confidence: 0.85`
     - Gate passed after 1 fix loop → `confidence: 0.65`
     - Gate passed after 2+ fix loops → `confidence: 0.45`
     - If pair review (opus-coach) required a revision → subtract `0.1` from the above value
     - If the output is marked partial or incomplete → cap at `confidence: 0.5` max
     ```
     mcp__sdd-autopilot__sdd_phase_confidence(
       project_path,
       feature_id,
       phase="{phase_name}",
       confidence={computed_value},        // 0.0–1.0 per criteria above
       reasoning="{why this confidence}",  // e.g. "Gate passed first attempt, no pair review revision"
       factors={                           // optional: breakdown of influencing factors
         gate_attempts: N,
         fix_loops: N,
         pair_review_revised: true|false,
         partial_output: true|false
       }
     )
     ```
     This persists to `.sdd/runs/{feature_id}/phase_confidence.json` (upserts per feature+phase). The data feeds into `sdd_get_run_summary` (which computes `avg_confidence`) and `sdd_check_thresholds` (which alerts on low average confidence).
   - For plan phase: call `mcp__sdd-autopilot__sdd_update_feature` to persist `plan_path` on the feature
   - For tasks phase: call `mcp__sdd-autopilot__sdd_update_feature` to persist `tasks_path` on the feature
9. If gate failed: call `mcp__sdd-autopilot__sdd_classify_failure` to determine the category:
   - `implementation_bug`: enter fix loop (see below)
   - `spec_gap`: pause and communicate to the user; wait for input
   - `infra_issue`: escalate to the user with diagnosis
10. Proceed to the next phase

### Fix loop protocol

When a gate fails with `implementation_bug`:

1. Check the contract's `fix_loop.max_attempts` — do not exceed it
2. Before each retry, call `mcp__sdd-autopilot__sdd_delta_check` to verify convergence. If it returns ABORT, stop the loop and escalate.
3. Re-invoke the `implementation-engine` subagent with the findings as additional context
4. Re-run the gate evaluation
5. If gate passes: continue to next phase
6. If gate fails again and attempts remain: repeat from step 2
7. If max attempts exhausted: escalate to the user

### Phase sequence

| # | Phase | Subagent | Model | State transition |
|---|-------|----------|-------|-----------------|
| 1 | Triage | `haiku-analyst` (triage mode) | haiku | — (pre-check, no state transition) |
| 2 | Specify | `spec-generator` | sonnet | `draft` -> `specified` |
| 3 | Plan | `plan-architect` | sonnet | `specified` -> `planned` |
| 4 | Tasks | `task-decomposer` | sonnet | `planned` -> `decomposed` |
| 5 | Implement | `implementation-engine` (per task) | sonnet | `decomposed` -> `implementing` |
| 6 | Verify | `verification-engine` | sonnet | `implementing` -> `verifying` -> `reviewing` |
| 7 | Review | `adversarial-reviewer` | opus | `reviewing` -> `pr_created` or `fix_review` |
| 8 | PR | `worktree-pr finish` + `pr-creator` | sonnet | `pr_created` (PR opened) |

### Pair review phases

These phases have `pair_review` enabled:
- **Specify**: opus-coach reviews the spec for ambiguities and untestable requirements
- **Implement**: opus-coach reviews each task's code for scope violations and side effects
- **Verify**: opus-coach reviews test coverage for missing edge cases

### Gate types

- **mechanical**: file existence and structural checks (orchestrator evaluates directly)
- **haiku-validator**: semantic validation delegated to `haiku-validator` subagent (used for plan and tasks gates)
- **self**: the producing agent's own structured output determines pass/fail (used for verify and review)

## Implementation phase details

The implement phase runs per-task, not as a single invocation:

### Worktree setup (before first task)

Unless `--skip-worktree` is set, create an isolated worktree immediately after the tasks gate passes and before launching any implementation-engine:

1. Invoke `worktree-pr start` in **automated mode** (all inputs provided, no confirmation prompts):
   - `repo_path`: the project path
   - `feature_name`: the feature ID (e.g. `health-check-endpoint`)
   - This creates a sibling directory `../{repo-name}-feat-{feature-id}` on branch `feat/{feature-id}`
2. Store the returned `worktree_path` and `branch_name` via `sdd_update_feature`:
   ```
   sdd_update_feature(project_path, feature_id, updates={ worktree_path: "...", branch: "feat/..." })
   ```
3. All subsequent subagents (implementation-engine, verification-engine, adversarial-reviewer) receive `worktree_path` as their working directory.

If `--skip-worktree`: skip steps 1–3 and work directly in `project_path`.

### Per-task execution

1. Read `specs/{feature_id}/tasks.md` to get the task list
2. Compute execution waves from the task dependency graph (tasks with no dependencies run in wave 1, etc.)
3. For each wave, for each task in the wave:
   a. Extract the task block from tasks.md
   b. Launch `implementation-engine` with that task block + spec + plan + memory, pointing it at `worktree_path` (or `project_path` if `--skip-worktree`)
   c. If pair_review is enabled for this stage: run opus-coach on the result
   d. The implementation-engine marks the task completed via `sdd_update_task` and logs via `sdd_transition(implementing→implementing)`. Verify task status is "completed" in state before moving to next task.
4. After all tasks complete: call `sdd_transition(implementing→verifying)`

## Observability

Call `mcp__sdd-autopilot__sdd_log_event` at these exact moments. No wrapper, no abstraction — just call it inline.

### 1. Phase start
At the very beginning of each phase, before reading the contract:
```
sdd_log_event(project_path, feature_id, event_type="phase_start", phase="{phase}", agent_id="orchestrator",
  data={ agent: "{subagent-name}", model: "{model}" })
```

### 2. Subagent launch
Immediately before invoking each subagent (Agent tool call):
```
sdd_log_event(project_path, feature_id, event_type="subagent_launch", phase="{phase}", agent_id="orchestrator",
  data={ agent_name: "{subagent}", model: "{model}", mode: "primary" | "pair_review" | "gate_validation" })
```

### 3. State transition
Immediately after every successful `sdd_transition` call:
```
sdd_log_event(project_path, feature_id, event_type="state_transition", phase="{phase}", agent_id="orchestrator",
  data={ from_state: "{from}", to_state: "{to}", triggered_by: "{agent_id}" })
```

### 4. Phase complete
After gate passes and transition is done (already referenced in Phase protocol step 8):
```
sdd_log_event(project_path, feature_id, event_type="phase_complete", phase="{phase}", agent_id="orchestrator",
  data={ gate_result: "passed" | "failed", duration_note: "N subagent calls" })
```

### 5. Pair review
After opus-coach returns, log the verdict before deciding whether to re-run:
```
sdd_log_event(project_path, feature_id, event_type="pair_review", phase="{phase}", agent_id="orchestrator",
  data={ coach_verdict: "approve" | "revise", critical_count: N, major_count: N, minor_count: N, iteration: 1 | 2 })
```

### 6. Fix loop iteration
At the start of each fix loop attempt, after delta_check:
```
sdd_log_event(project_path, feature_id, event_type="fix_loop_iteration", phase="{phase}", agent_id="orchestrator",
  data={ attempt_number: N, max_attempts: N, failure_category: "implementation_bug" | "spec_gap" | "infra_issue", delta_check_result: "continue" | "abort" })
```

### 7. Escalation or pause
Before any escalation transition or awaiting_input pause:
```
sdd_log_event(project_path, feature_id, event_type="escalation", phase="{phase}", agent_id="orchestrator",
  data={ reason: "{human-readable reason}", failure_mode: "{SPEC_GAP|TASK_BLOCKED|...}", action: "escalated" | "awaiting_input" })
```

### 8. sdd_emit_metrics (after each phase)

Call `mcp__sdd-autopilot__sdd_emit_metrics` immediately after each phase completes (gate passed or failed definitively). Capture timestamps manually since the Agent tool does not expose them natively.

**Instrumentation pattern:**
```
started_at  = new Date().toISOString()  // capture before Agent call
t0          = Date.now()                // capture before Agent call
// ... invoke subagent via Agent tool ...
completed_at = new Date().toISOString() // capture after Agent returns
duration_ms  = Date.now() - t0

sdd_emit_metrics(project_path, metrics={
  run_id:            "{run_id}",          // from step 2 (format: feature_id-timestamp_ms)
  feature_id:        "{feature_id}",
  phase:             "{phase_name}",
  agent:             "{subagent_name}",
  model:             "{haiku|sonnet|opus}",
  started_at,
  completed_at,
  duration_ms,
  tokens_in:         null,               // not available from Agent tool
  tokens_out:        null,               // not available from Agent tool
  tool_calls_count:  0,                  // not available from Agent tool
  gate_result:       "pass"|"fail"|"skip",
  gate_attempts:     N,                  // 1 if first attempt, 2+ if fix loop
  findings_count:    N,                  // from verify/review structured output; 0 for other phases
  findings_severity: [],                 // ["critical", "major", "minor"] from verify/review; [] for other phases
  fix_loop_count:    N,                  // 0 if passed on first try
  delta_direction:   null|"improving"|"regressing"|"stable",  // from sdd_delta_check if fix loop ran
  feature_type:      "{type}"|null,      // from triage (propagate to all phases)
  complexity:        "{level}"|null,     // from triage (propagate to all phases)
})
```

## Signal routing

During the pipeline, agents may emit signals via `sdd_append_signal`. The orchestrator routes each signal based on its type. Signals are read at each phase boundary -- before launching the next subagent, call `mcp__sdd-autopilot__sdd_get_state` with `feature_id` and read `feature.signals`.

### Signal processing protocol

At the start of each phase (after step 1 of the phase protocol -- reading current feature state):

1. Read `feature.signals` from the `sdd_get_state` response.
2. Filter signals that have not yet been processed. Track processed signal indices in a local `processed_signals` set (initialized empty at pipeline start).
3. For each unprocessed signal, route based on `signal.type`:

### ATTENTION_REQUIRED

**Mechanism:** Inject into the next subagent context.

1. Read the signal `content` field.
2. Prepend to the next Agent tool prompt under a `## Attention Signals` header:
   ```
   ## Attention Signals
   The following issues were flagged by a previous agent and require your attention:
   - [{signal.source}]: {signal.content}
   ```
3. Mark signal as processed.

### PATTERN_DETECTED

**Mechanism:** Store in project memory and inject into agents of the same type.

1. Call `mcp__sdd-autopilot__sdd_memory_write` to persist the pattern:
   ```
   mcp__sdd-autopilot__sdd_memory_write(
     project_path: "{project_path}",
     scope:        "project",
     content:      "Pattern detected by {signal.source}: {signal.content}",
     section:      "patterns"
   )
   ```
2. For subsequent phases, check if the next subagent is of the same type as `signal.source` (e.g., both are `implementation-engine`). If so, inject into the Agent tool prompt:
   ```
   ## Detected Patterns
   - [{signal.source}]: {signal.content}
   ```
3. Mark signal as processed after memory write.

### DEPENDENCY_WARNING

**Mechanism:** Inject into plan-architect (if re-planning) and implementation-engine.

1. Accumulate all DEPENDENCY_WARNING signals into a `dependency_warnings` list.
2. When launching `plan-architect` (phase 3, or during a re-plan triggered by SPEC_GAP): include in prompt:
   ```
   ## Dependency Warnings
   {for each warning: "- [{signal.source}]: {signal.content}"}
   ```
3. When launching `implementation-engine` (phase 5, any task): include in prompt:
   ```
   ## Dependency Warnings
   {for each warning: "- [{signal.source}]: {signal.content}"}
   ```
4. Mark signals as processed after the last implementation-engine task completes.

### CONTEXT_NOTE

**Mechanism:** Inject into the immediately downstream agent only.

1. Read the signal `content` field.
2. Inject into the NEXT subagent prompt (the one immediately following the agent that emitted the signal) under:
   ```
   ## Context Notes
   - [{signal.source}]: {signal.content}
   ```
3. Mark signal as processed after that single injection. Do NOT propagate to further downstream agents.

### META_LEARNING_HINT

**Mechanism:** Buffer until post-pipeline; process in batch.

1. Do NOT inject into any subagent context during the pipeline.
2. Accumulate all META_LEARNING_HINT signals into a `meta_learning_buffer` list (initialized empty at pipeline start).
3. After PR creation (post-pipeline step 8 -- "Process buffered META_LEARNING_HINT signals"):
   a. For each buffered hint, call `mcp__sdd-autopilot__sdd_memory_write`:
      ```
      mcp__sdd-autopilot__sdd_memory_write(
        project_path: "{project_path}",
        scope:        "project",
        content:      "Meta-learning hint from {signal.source}: {signal.content}",
        section:      "learnings"
      )
      ```
   b. Feed the full buffer as context to `haiku-analyst` in retro mode (post-pipeline step 7), so the retro can incorporate meta-learning observations.
4. Mark all META_LEARNING_HINT signals as processed after the retro completes.

## Error handling

| Error code | Action |
|-----------|--------|
| SPEC_GAP | Route to spec-generator with re-specify inputs; loop from phase 2 (max 2 re-specs) |
| TASK_BLOCKED | Read blocked_reason; if resolvable (install package), resolve and retry; else escalate |
| DEPENDENCY_MISSING | Attempt auto-resolution (npm install); if fails, escalate |
| ESCALATE | Transition to `escalated`; write escalation report; surface to user |

## Escalation protocol

When escalating:
1. Write escalation report to `.sdd/escalation/{feature}/{timestamp}.md`
2. Include: current state, last agent, error code, diagnosis, suggested human action
3. Transition feature to `escalated`
4. Halt all agents
5. Report to the user with the escalation report path

## Communication to user

Report to the user at these points:
- **Start**: "Starting SDD pipeline for: {feature_description}"
- **Each phase start**: "Phase {N}/{8}: {phase_name}..."
- **Gate result**: "Gate {phase}: {PASS/FAIL}" (if FAIL, include reason)
- **Fix loop**: "Fix loop attempt {N}/{max}: {category}"
- **Escalation**: Full escalation report
- **Completion**: "Pipeline complete. PR: {url} | Score: {pipeline_score}/100" with summary of what was built

## PR phase details

Phase 8 uses `worktree-pr finish` for git operations and `pr-creator` only for state tracking:

1. If `--skip-worktree` or worktree was not created: delegate entirely to `pr-creator` subagent (current behavior).
2. If worktree was created:
   a. Invoke `worktree-pr finish` in **automated mode**:
      - `worktree_path`: from `sdd_get_state` feature metadata (`worktree_path` field)
      - `title`: `"feat({feature-id}): {one-line summary from spec overview}"`
      - `description`: contents of `specs/{feature-id}/spec.md` (truncated to 60k chars if needed)
   b. `worktree-pr finish` commits all changes, pushes `feat/{feature-id}`, and opens the PR.
   c. Record the result via `sdd_transition(pr_created→merged)` with metadata `{ pr_url, diff_stats }`.

If `--skip-pr` is set: skip step 2b (push + PR creation) but still commit in the worktree.

## Post-pipeline

After PR creation succeeds:
1. Call `mcp__sdd-autopilot__sdd_get_run_summary` with `project_path`, `feature_id`, and the `run_id` from step 2. This aggregates all PhaseMetrics into a RunSummary, persists `summary.json`, and appends to `analytics/history.jsonl`. After the call, patch `review_decision` in `summary.json` using the review agent's structured output (`APPROVE` → `"approve"`, `REQUEST_CHANGES` → `"request_changes"`).
2. Call `mcp__sdd-autopilot__sdd_compute_score` with `project_path` and `feature_id`. This reads the patched `summary.json` and `analytics/history.jsonl`, computes quality + efficiency scores, and persists `pipeline_score` back into `summary.json`. Log the returned `pipeline_score` in the user-facing completion message.
3. Call `mcp__sdd-autopilot__sdd_check_thresholds` to detect when metrics cross warning/critical thresholds:
   ```
   mcp__sdd-autopilot__sdd_check_thresholds(
     project_path,
     feature_id
   )
   ```
   The tool checks per-phase fix loop counts (relative to contracts.json caps), duration ratios vs historical averages, run-level first_pass_rate, total_duration, and average phase confidence. It returns an `alerts` array where each alert has a `level` ("warning" or "critical") and a descriptive `message`.

   **Handle the response:**
   - If any alert has `level: "critical"`:
     - Emit a WARNING signal via `mcp__sdd-autopilot__sdd_append_signal`:
       ```
       sdd_append_signal(project_path, feature_id, signal={
         type: "ATTENTION_REQUIRED",
         source: "orchestrator",
         message: "Critical threshold alert: {alert.message}",
         data: { alerts: critical_alerts }
       })
       ```
     - Log via `mcp__sdd-autopilot__sdd_log_event`:
       ```
       sdd_log_event(project_path, feature_id, event_type="threshold_alert", phase="post_pipeline", agent_id="orchestrator",
         data={ alert_count: N, critical_count: N, warning_count: N, alerts: alerts })
       ```
     - Store the critical alerts in a `threshold_alerts` variable — pass them to `sdd_run_retro` context (step 6) and to haiku-analyst (step 7).
   - If alerts exist but all are `level: "warning"`: store them for retro context only. Do not emit a signal.
   - If `alerts` is empty: proceed normally.

4. Call `mcp__sdd-autopilot__sdd_detect_anomaly` to check if this run is statistically anomalous:
   ```
   mcp__sdd-autopilot__sdd_detect_anomaly(
     project_path,
     feature_id
   )
   ```
   The tool computes z-scores for `total_duration_ms`, `first_pass_rate`, `pipeline_score`, and `avg_confidence` against the historical distribution (requires >= 5 prior runs). Default sensitivity is 2.0 standard deviations.

   **Handle the response:**
   - If `is_anomaly: true`:
     - Flag this run as anomalous. Store the anomaly details (`anomalies` array with `metric`, `value`, `mean`, `stddev`, `z_score` for each flagged metric) in an `anomaly_context` variable.
     - **Do NOT promote any patterns from this run** — skip `sdd_promote_pattern` calls during the haiku-analyst retro step.
     - Include `anomaly_context` in the retro and haiku-analyst context.
   - If `is_anomaly: false` or `status: "insufficient_data"`: proceed normally. Pattern promotion is allowed.

5. Conditionally call `mcp__sdd-autopilot__sdd_set_golden` if the pipeline score beats the current golden baseline:
   ```
   mcp__sdd-autopilot__sdd_set_golden(
     project_path,
     feature_id
   )
   ```
   **When to call:**
   - Read `golden_comparison` from the `sdd_compute_score` response (step 2):
     - If `golden_comparison.status: "no_golden_set"` → always call `sdd_set_golden` (first golden baseline).
     - If `golden_comparison.status: "meets_golden"` and `golden_comparison.current_score > golden_comparison.golden_score` → call `sdd_set_golden` (new high score).
     - If `golden_comparison.status: "below_threshold"` or `current_score <= golden_score` → do NOT call. Log: "Score {pipeline_score} did not beat current golden {golden_score}".

   **Handle the response:**
   - If `success: true`: log to the user: "New golden baseline set: {pipeline_score} (feature: {feature_id})"
   - If the tool returns an error: log the error but do not fail the pipeline.

6. Call `mcp__sdd-autopilot__sdd_run_retro` to generate the structured retrospective before launching haiku-analyst:
   ```
   mcp__sdd-autopilot__sdd_run_retro(
     project_path,
     feature_id,
     expected_outcome="clean_pass"   // or "minor_fixes" if fix loops ran, adjust based on actual run
   )
   ```
   The tool reads `summary.json`, computes phase breakdown, identifies bottleneck phases, checks which active patterns were confirmed or contradicted, and produces actionable suggestions. It persists `retro.json` at `.sdd/runs/{feature_id}/retro.json`.

   **Handle the response:**
   - The returned retro object contains: `phase_breakdown`, `bottlenecks`, `patterns_confirmed`, `patterns_contradicted`, `suggestions`, `pipeline_score`, `outcome`.
   - Store the retro output path (`.sdd/runs/{feature_id}/retro.json`) — pass it to haiku-analyst in step 7 as additional context.
   - If threshold alerts (from step 3) or anomaly context (from step 4) exist, include them when launching haiku-analyst so it can incorporate those signals into its analysis.

7. Run `haiku-analyst` in retro mode (compare first-pass diff with final diff). Provide these additional context inputs:
   - `retro_path`: `.sdd/runs/{feature_id}/retro.json` (from step 6)
   - `threshold_alerts`: critical/warning alerts (from step 3, if any)
   - `anomaly_context`: anomaly details (from step 4, if `is_anomaly: true`)
   - `is_anomalous_run`: boolean flag — if `true`, haiku-analyst must NOT emit `sdd_propose_pattern`, `sdd_promote_pattern`, or `sdd_propose_experiment` calls
   The haiku-analyst may call `sdd_propose_pattern` to emit ExploitationPattern candidates and `sdd_propose_experiment` to propose an experiment (if this is an exploration turn -- `run_count % 5 == 0`). On anomalous runs, both are suppressed.
8. Process buffered META_LEARNING_HINT signals
9. Write learnings to memory via `sdd_memory_write`

After step 9 (sdd_memory_write), proceed to the Adaptive Run Close sequence.

10. **Worktree cleanup** (after Adaptive Run Close completes, if worktree was created and PR is merged):
   - Invoke `worktree-pr cleanup` in automated mode: `repo_path` = project_path, `feature_name` = feature_id
   - This removes the sibling directory, deletes local and remote `feat/{feature-id}` branches, and pulls latest default branch.
   - If PR is not yet merged (e.g. `--skip-pr` was used): skip cleanup and report the worktree path to the user.

## Flags

- `--skip-worktree`: Work directly in the project directory instead of creating a git worktree. Skips `worktree-pr start`, `finish`, and `cleanup`. pr-creator handles all git operations as before.
- `--skip-pr`: Skip the PR creation step (useful for testing). Commits to worktree branch but does not push or open PR. Worktree cleanup is also skipped.

## Adaptive Orchestrator

The adaptive orchestrator modifies pipeline behavior based on learned patterns and experiments. It runs two scripted sequences: one at run start (before specify) and one at run close (after post-pipeline). The orchestrator reads this section at every run and executes it deterministically.

### ADAPTIVE RUN START

Execute this sequence after triage completes and before the specify phase begins. All values from triage (`feature_type`, `complexity`) must be available.

**Step 1 -- Get applicable patterns:**
```
result = mcp__sdd-autopilot__sdd_get_patterns(
  project_path:  "{project_path}",
  status:        "active",
  feature_type:  "{feature_type from triage}",
  complexity:    "{complexity from triage}"
)
applicable_patterns = result.patterns
```
Store `applicable_patterns` in memory for this pipeline run -- it is needed at run close for `sdd_update_pattern`.

**Step 2 -- Apply pattern mutations:**
For each pattern in `applicable_patterns`, apply based on `pattern.type`:

- `type="skip_phase"`: Parse `pattern.action` to identify the phase to skip (e.g., "skip verify for low-complexity api features"). Remove that phase from the execution sequence. Log:
  ```
  sdd_log_event(project_path, feature_id, event_type="phase_skipped", phase="{skipped_phase}", agent_id="orchestrator",
    data={ pattern_id: "{pattern.pattern_id}", reason: "exploitation_pattern" })
  ```
  When emitting metrics for the skipped phase, use `gate_result: "skip"`.

- `type="model_swap"`: Parse `pattern.action` to identify the phase and target model (e.g., "use haiku for plan phase on low-complexity"). Override the model in the phase sequence table for that phase.

- `type="gate_adjust"`: Parse `pattern.action` to get the threshold override (e.g., "relax verify gate to 80% for api features"). Pass the override as context to the subagent when launching that phase.

- `type="prompt_tuning"`: Inject `pattern.action` text into the subagent context for the targeted phase under:
  ```
  ## Pattern-Driven Instructions
  - [{pattern.pattern_id}]: {pattern.action}
  ```

**Step 3 -- Read experiments:**
Read `.sdd/metacognition/experiments.json` directly (file read, not a tool call). Filter experiments where `status="proposed"` or `status="running"`.

**Step 4 -- Abandon stale/mismatched experiments:**
For each experiment from step 3, apply the abandonment checks:
- Context mismatch: experiment `mutation.feature_type` differs from current `feature_type` from triage.
- Staleness: `status="running"` AND more than 3 runs elapsed since `created_at` without evaluation.

For each experiment that matches either condition:
```
mcp__sdd-autopilot__sdd_abandon_experiment(
  project_path:  "{project_path}",
  experiment_id: "{experiment.experiment_id}",
  reason:        "{context_mismatch or stale_experiment description}"
)
```
Log each abandonment:
```
sdd_log_event(project_path, feature_id, event_type="experiment_abandoned", phase="adaptive_start", agent_id="orchestrator",
  data={ experiment_id: "{experiment_id}", reason: "{reason}" })
```
After cleanup, re-read experiments to get the updated list. Only experiments still in `status="proposed"` or `status="running"` proceed to the explore/exploit decision.

**Step 5 -- Determine explore/exploit mode:**
Count lines in `.sdd/analytics/history.jsonl` to get `run_count`. If the file does not exist, `run_count = 0`.
```
if run_count % 5 == 0 AND run_count > 0:
    mode = "exploration"
else:
    mode = "exploitation"
```
In exploitation mode, apply patterns only (already done in step 2). Skip to step 7.

**Step 6 -- Apply experiment (exploration mode only):**
This step only executes if `mode = "exploration"` AND a proposed experiment exists (from step 3, after cleanup).

1. Read the experiment `risk_level`:

   a. **If `risk_level="low"` or `risk_level="medium"`:**
   - Apply `experiment.mutation` to the pipeline (e.g., if mutation says { "skip_phase": "plan" }, remove plan from the sequence; if mutation says { "model_override": { "implement": "opus" } }, swap the model).
   - Update experiment status to `"running"` by writing back to `experiments.json`.
   - Store `experiment_applied = experiment.experiment_id` for use at run close.

   b. **If `risk_level="high"`:**
   - Surface to the user: "High-risk experiment proposed: {experiment.hypothesis}. Approve? (y/n)"
   - If approved: apply mutation as in (a), mark `"running"`.
   - If rejected:
     ```
     mcp__sdd-autopilot__sdd_abandon_experiment(
       project_path:  "{project_path}",
       experiment_id: "{experiment.experiment_id}",
       reason:        "user_rejected"
     )
     ```
   - Store `experiment_applied` accordingly (the experiment_id if approved, `null` if rejected).

**Step 7 -- Log adaptive decisions:**
```
mcp__sdd-autopilot__sdd_log_event(
  project_path: "{project_path}",
  feature_id:   "{feature_id}",
  event_type:   "adaptive_routing",
  phase:        "pre_pipeline",
  agent_id:     "orchestrator",
  data: {
    mode:               "{exploitation|exploration}",
    run_count:          {run_count},
    patterns_applied:   ["{pattern_id_1}", "{pattern_id_2}", ...],
    phases_skipped:     ["{phase_1}", ...],
    model_overrides:    { "{phase}": "{model}", ... },
    experiment_applied: "{experiment_id}" | null
  }
)
```

Continue to the specify phase (or the first non-skipped phase).

### ADAPTIVE RUN CLOSE

Execute this sequence after the post-pipeline steps complete (steps 1-9: `sdd_get_run_summary`, `sdd_compute_score`, `sdd_check_thresholds`, `sdd_detect_anomaly`, `sdd_set_golden`, `sdd_run_retro`, haiku-analyst retro, META_LEARNING_HINT processing, `sdd_memory_write`). This section covers only the metacognition-specific steps.

**Step 1 -- Update pattern outcomes (sdd_update_pattern):**

For each pattern in the `applicable_patterns` list stored at run start:

1. Read `pipeline_score` from `.sdd/runs/{feature_id}/summary.json`.
2. Read `golden_score` from `.sdd/analytics/golden.json`. If no golden exists, compute `historical_mean` from `.sdd/analytics/history.jsonl` (average of all non-null `pipeline_score` values). Use whichever is available as `baseline`.
3. Determine outcome:
   - `pipeline_score >= baseline`: call with `outcome="success"`
   - `pipeline_score < baseline * 0.9`: call with `outcome="failure"`
   - Between `baseline * 0.9` and `baseline`: skip (ambiguous zone, no update)
4. For each pattern with a determined outcome:
   ```
   mcp__sdd-autopilot__sdd_update_pattern(
     project_path: "{project_path}",
     pattern_id:   "{pattern.pattern_id}",
     outcome:      "success" | "failure"
   )
   ```

**Step 2 -- Evaluate experiment (exploration runs only):**

If this was an exploration run AND `experiment_applied` is not null:

1. Read `pipeline_score` (result score) and the previous run `pipeline_score` from `history.jsonl` (baseline score, second-to-last entry).
2. Call:
   ```
   mcp__sdd-autopilot__sdd_evaluate_experiment(
     project_path:   "{project_path}",
     experiment_id:  "{experiment_applied}",
     result_score:   {pipeline_score},
     baseline_score: {previous_pipeline_score}
   )
   ```
3. Handle the verdict:
   - **`verdict="promote"`**: The experiment improved the pipeline. Create a new pattern from it:
     ```
     mcp__sdd-autopilot__sdd_propose_pattern(
       project_path:    "{project_path}",
       pattern_id:      "exp-{experiment_id}",
       type:            "{infer from experiment.mutation -- e.g., skip_phase, model_swap}",
       condition:       "feature_type={feature_type} complexity={complexity}",
       action:          "{describe the mutation that was applied}",
       confidence:      0.5,
       supporting_runs: 1,
       min_runs:        5,
       ttl:             20
     )
     ```
   - **`verdict="discard"`**: Log and clean up. No further action needed -- the handler already marked the experiment as `completed`.
     ```
     sdd_log_event(project_path, feature_id, event_type="experiment_discarded", phase="post_pipeline", agent_id="orchestrator",
       data={ experiment_id: "{experiment_id}", result_score: {result}, baseline_score: {baseline} })
     ```
   - **`verdict="retry"`**: The handler reset the experiment to `status="proposed"` and incremented `retry_count`. It will be picked up in the next exploration run. Maximum 2 retries before auto-discard.
     ```
     sdd_log_event(project_path, feature_id, event_type="experiment_retry", phase="post_pipeline", agent_id="orchestrator",
       data={ experiment_id: "{experiment_id}", retry_count: {retry_count} })
     ```

**Step 3 -- Promote mature candidates (sdd_promote_pattern):**

Read all candidate patterns:
```
result = mcp__sdd-autopilot__sdd_get_patterns(
  project_path: "{project_path}",
  status:       "candidate"
)
```
For each candidate where `supporting_runs >= 5` AND `confidence >= 0.7`:
```
mcp__sdd-autopilot__sdd_promote_pattern(
  project_path: "{project_path}",
  pattern_id:   "{pattern.pattern_id}"
)
```
The handler validates the promotion gate internally and returns `promoted: true` or `promoted: false` with a reason. Log each promotion:
```
sdd_log_event(project_path, feature_id, event_type="pattern_promoted", phase="post_pipeline", agent_id="orchestrator",
  data={ pattern_id: "{pattern_id}", confidence: {confidence}, supporting_runs: {supporting_runs} })
```

**Step 4 -- Meta-review cycle (every N runs):**

Count lines in `.sdd/analytics/history.jsonl` to get `run_count`. Read `review_every_n` from `.sdd/metacognition/config.json` (default: 10 if file missing).

If `run_count % review_every_n == 0` AND `run_count > 0`:

a. **Get analytics:**
   ```
   analytics = mcp__sdd-autopilot__sdd_get_analytics(
     project_path: "{project_path}"
   )
   ```

b. **Get recent summaries:**
   ```
   recent = mcp__sdd-autopilot__sdd_get_run_summary(
     project_path: "{project_path}",
     feature_id:   "{feature_id}",
     last_n_runs:  10
   )
   ```

c. **Get active patterns:**
   ```
   patterns = mcp__sdd-autopilot__sdd_get_patterns(
     project_path: "{project_path}",
     status:       "active"
   )
   ```

d. **Launch opus-meta-reviewer** with the Agent tool. Include in its brief:
   ```
   ## Analytics Context (from sdd_get_analytics)
   - Pipeline score trend: {analytics.trends.pipeline_score.direction} (derivative: {derivative})
   - First-pass rate trend: {analytics.trends.first_pass_rate.direction}
   - High-variance phases: {analytics.high_variance_phases}
   - Avg fix loops by type: {analytics.avg_fix_loops_by_feature_type}
   - Runs analyzed: {analytics.runs_analyzed}

   ## Recent Run Summaries
   {recent.summaries -- last 10}

   ## Active Patterns
   {patterns.patterns}

   ## Completed Experiments
   {from .sdd/metacognition/experiments.json, filtered to status="completed"}
   ```
   The reviewer calls `mcp__sdd-autopilot__sdd_propose_evolution` (max 2 proposals).

e. **Process proposed evolutions (sdd_approve_evolution):**
   Read `.sdd/metacognition/evolutions.json`, filter for `status="proposed"` entries.
   For each proposed evolution:

   - If `type="weight_adjust"` or `type="threshold_adjust"`:
     ```
     mcp__sdd-autopilot__sdd_approve_evolution(
       project_path: "{project_path}",
       evolution_id: "{evolution.evolution_id}",
       decision:     "approve",
       reason:       "Auto-approved: low-risk parameter tuning ({evolution.type})"
     )
     ```

   - If `type` is structural (`phase_add`, `phase_remove`, `agent_redesign`, `contract_change`) OR `impact="high"` OR `requires_human=true`:
     Emit signal and leave pending. Do NOT call `sdd_approve_evolution`:
     ```
     mcp__sdd-autopilot__sdd_append_signal(
       project_path: "{project_path}",
       feature_id:   "{feature_id}",
       signal: {
         type:    "ATTENTION_REQUIRED",
         content: "Structural evolution proposed: {evolution_id} -- {description}. Requires human approval.",
         source:  "orchestrator"
       }
     )
     ```

   **Hard rule:** The orchestrator NEVER auto-approves structural evolutions.

**Step 5 -- Tick pattern TTLs (sdd_tick_patterns):**
```
mcp__sdd-autopilot__sdd_tick_patterns(
  project_path: "{project_path}"
)
```
This decrements TTLs using adaptive exponential decay. Patterns not recently confirmed decay faster. Patterns with `remaining_ttl < 1.0` are marked as `decayed`.

**Step 6 -- Tick memory decay (sdd_tick_decay):**
```
mcp__sdd-autopilot__sdd_tick_decay(
  project_path: "{project_path}"
)
```
This decrements memory TTLs and prunes stale entries.

### Tracking run_count

Count lines in `.sdd/analytics/history.jsonl`. This value drives:
- Exploration trigger: `run_count % 5 == 0` (Adaptive Run Start, step 5)
- Meta-review trigger: `run_count % review_every_n == 0` (Adaptive Run Close, step 4)

Default `review_every_n` = 10. Read from `.sdd/metacognition/config.json` if present, otherwise use the default.

## Example

User: `/sdd-auto:run "Add a health check endpoint that returns server status and uptime"`

This will:
1. Triage: estimate complexity and risk
2. Generate a spec at `specs/health-check-endpoint/spec.md`
3. Generate a plan at `specs/health-check-endpoint/plan.md` + ADR
4. Decompose into tasks at `specs/health-check-endpoint/tasks.md`
5. Implement all tasks (per-task, with pair review)
6. Run verification (tests, spec coverage, regression, constitution)
7. Run adversarial review (correctness, security, performance, maintainability, side effects)
8. Create a PR with structured metadata
9. Run retrospective and update memory

$ARGUMENTS

<!-- Coverage audit: 31/39 tools scripted. 7 utility tools correctly excluded.
     Last updated: 2026-03-07. See patches/ for design documents. -->
