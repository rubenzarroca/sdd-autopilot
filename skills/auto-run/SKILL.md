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

During the pipeline, agents may emit signals via `sdd_append_signal`. Route them as follows:

| Signal type | Routing |
|------------|---------|
| ATTENTION_REQUIRED | Inject into next agent's context |
| PATTERN_DETECTED | Store in memory; inject into same-type agents |
| DEPENDENCY_WARNING | Inject into plan-architect if re-planning; inject into implementation-engine |
| CONTEXT_NOTE | Inject into immediately downstream agent only |
| META_LEARNING_HINT | Buffer; process after pr_created (run haiku-analyst in retro mode) |

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
3. Run `haiku-analyst` in retro mode (compare first-pass diff with final diff)
4. Process buffered META_LEARNING_HINT signals
5. Write learnings to memory via `sdd_memory_write`
6. Call `mcp__sdd-autopilot__sdd_tick_decay` to decrement TTLs on learned patterns and prune stale entries
7. Call `mcp__sdd-autopilot__sdd_tick_patterns` to decrement TTLs on ExploitationPatterns and decay expired ones
5. **Worktree cleanup** (if worktree was created and PR is merged):
   - Invoke `worktree-pr cleanup` in automated mode: `repo_path` = project_path, `feature_name` = feature_id
   - This removes the sibling directory, deletes local and remote `feat/{feature-id}` branches, and pulls latest default branch.
   - If PR is not yet merged (e.g. `--skip-pr` was used): skip cleanup and report the worktree path to the user.

## Flags

- `--skip-worktree`: Work directly in the project directory instead of creating a git worktree. Skips `worktree-pr start`, `finish`, and `cleanup`. pr-creator handles all git operations as before.
- `--skip-pr`: Skip the PR creation step (useful for testing). Commits to worktree branch but does not push or open PR. Worktree cleanup is also skipped.

## Adaptive Orchestrator (Decision Tree)

The full adaptive decision tree is designed here and activated progressively as tools become available. The orchestrator reads this section at every run start and run close.

### Run start (adaptive routing)

```
start of run
    │
    ├── [PHASE 3 - ACTIVE] Call `sdd_get_patterns` with feature_type + complexity from triage
    │   └── filter returns active patterns whose condition matches this run
    │       └── If active patterns found:
    │           ├── pattern.type="skip_phase"   → remove that phase from execution sequence
    │           ├── pattern.type="model_swap"   → override model for that phase
    │           ├── pattern.type="gate_adjust"  → pass gate threshold override to subagent context
    │           └── pattern.type="prompt_tuning"→ inject pattern.action into subagent context
    │
    └── [PHASE 4 - ACTIVE] Call `sdd_get_patterns` status=all to check experiments.json indirectly; read `.sdd/metacognition/experiments.json` directly
        └── filter experiments where status="proposed"
            └── Is this the exploration turn? (run_count % 5 == 0, tracked in analytics/history.jsonl line count)
                ├── NO  → exploitation mode (apply active patterns, skip experiment)
                └── YES → check experiment.risk_level
                    ├── "low" | "medium" → apply experiment.mutation; mark status="running"
                    └── "high"           → surface to user for approval before applying
                                           ├── approved → apply + mark status="running"
                                           └── rejected → mark status="abandoned"; proceed with patterns only
```

**Phase 1 behaviour (current):** No patterns or experiments exist yet. Run start proceeds without modifications.

### Run close (metacognition update)

```
after PR creation
    │
    ├── [PHASE 1 - ACTIVE] sdd_get_run_summary → persist summary.json + history.jsonl
    │
    ├── [PHASE 2 - ACTIVE] sdd_compute_score → compute pipeline_score, update summary.json
    │
    ├── haiku-analyst retro (existing, post-pipeline step 2)
    │   ├── [PHASE 3 - ACTIVE] emit ExploitationPattern candidates via sdd_propose_pattern
    │   └── [PHASE 4 - ACTIVE] propose Experiment via sdd_propose_experiment (if exploration turn — 1 in every 5 runs)
    │
    ├── [PHASE 3 - ACTIVE] sdd_promote_pattern → promote candidates with supporting_runs >= 5 AND confidence >= 0.7
    │
    ├── [PHASE 4 - ACTIVE] sdd_evaluate_experiment
    │   └── if experiment status="running": compare result_score vs baseline_score → write verdict
    │       ├── result_score >= baseline_score       → verdict="promote" → convert to ExploitationPattern
    │       ├── result_score < baseline_score × 0.9  → verdict="discard" → accelerated decay
    │       └── ambiguous                            → verdict="retry" (max 2 retries)
    │
    └── [PHASE 5 - ACTIVE] if (run_count % config.review_every_n == 0): spawn opus-meta-reviewer
        └── Opus receives: last N RunSummaries + active patterns + completed experiments + trends
            └── Outputs PipelineEvolution via sdd_propose_evolution
```

**Tracking `run_count`:** Count lines in `.sdd/analytics/history.jsonl`. Opus meta-reviewer trigger fires when `run_count % review_every_n == 0`. Default `review_every_n` = 10 (read from `.sdd/metacognition/config.json` if present, otherwise default). When triggered: spawn `opus-meta-reviewer` with the last N RunSummaries, active patterns, completed experiments, and analytics trends. The reviewer calls `sdd_propose_evolution` to persist its findings.

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
