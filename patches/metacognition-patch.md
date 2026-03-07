# Metacognition Lifecycle Patch

Patch instructions for SKILL.md. Integrates 4 MCP tools (`sdd_update_pattern`, `sdd_get_analytics`, `sdd_approve_evolution`, `sdd_abandon_experiment`) and rewrites 2 ad-hoc zones (signal routing, adaptive orchestrator).

---

## Section A: Run close -- sdd_update_pattern

**Location:** Adaptive Run Close sequence, step 1 (after post-pipeline steps 1-6, before experiment evaluation).

```
AFTER: Post-pipeline step 7 (sdd_tick_patterns) -- this section lives in the new Adaptive Run Close sequence
INSERT:
```

### Pattern Bayesian Update (sdd_update_pattern)

At run close, after the post-pipeline sequence completes (steps 1-6: get_run_summary through run_retro), update every pattern that was applied during this run:

1. Retrieve the `applicable_patterns` list stored at run start (from `sdd_get_patterns` result).
2. Read `pipeline_score` from `.sdd/runs/{feature_id}/summary.json` (persisted by `sdd_compute_score`).
3. Read `golden_score` from `.sdd/analytics/golden.json`. If no golden exists, compute `historical_mean` from `.sdd/analytics/history.jsonl` (average of all `pipeline_score` values where not null). Use `historical_mean` as the comparison baseline.
4. For each pattern in `applicable_patterns`:

   a. **If `pipeline_score >= baseline` (golden_score or historical_mean):**
   ```
   mcp__sdd-autopilot__sdd_update_pattern(
     project_path: "{project_path}",
     pattern_id:   "{pattern.pattern_id}",
     outcome:      "success"
   )
   ```

   b. **If `pipeline_score < baseline * 0.9`:**
   ```
   mcp__sdd-autopilot__sdd_update_pattern(
     project_path: "{project_path}",
     pattern_id:   "{pattern.pattern_id}",
     outcome:      "failure"
   )
   ```

   c. **If `pipeline_score` is between `baseline * 0.9` and `baseline` (ambiguous zone):** do NOT call `sdd_update_pattern`. The pattern is neither confirmed nor contradicted. Leave its Bayesian state unchanged.

5. Log the update batch:
   ```
   sdd_log_event(project_path, feature_id, event_type="pattern_update_batch", phase="post_pipeline", agent_id="orchestrator",
     data={ patterns_updated: N, successes: N, failures: N, skipped: N })
   ```

**Why this works:** `sdd_update_pattern` with `outcome="success"` increments `alpha` (Beta distribution), while `outcome="failure"` increments `beta_param`. This feeds the Bayesian confidence calculation: `confidence = alpha / (alpha + beta_param)`. Over time, patterns that correlate with good runs gain confidence; patterns that correlate with bad runs lose it.
---

## Section B: Run close -- sdd_get_analytics + opus-meta-reviewer

**Location:** Adaptive Run Close sequence, step 4a (before launching opus-meta-reviewer).

```
AFTER: The condition check "if run_count % review_every_n == 0"
INSERT:
```

### Analytics Context for opus-meta-reviewer (sdd_get_analytics)

Before launching `opus-meta-reviewer`, gather trend data:

1. Call `sdd_get_analytics` to get cross-run trends:
   ```
   mcp__sdd-autopilot__sdd_get_analytics(
     project_path: "{project_path}"
   )
   ```
   No filters -- the reviewer needs the full picture across all feature types.

2. From the response, extract:
   - `trends.pipeline_score.direction` -- is the pipeline improving, degrading, or stable?
   - `trends.pipeline_score.derivative` -- rate of change
   - `trends.first_pass_rate.direction` -- are gates getting easier or harder to pass?
   - `high_variance_phases` -- phases with inconsistent durations (optimization candidates)
   - `avg_fix_loops_by_feature_type` -- which feature types cause the most fix loops?
   - `runs_analyzed` -- sample size for the trends

3. Include the analytics result in the opus-meta-reviewer Agent tool prompt. Structure the brief as:
   ```
   ## Analytics Context (from sdd_get_analytics)
   - Pipeline score trend: {direction} (derivative: {derivative})
   - First-pass rate trend: {direction}
   - High-variance phases: {list or "none"}
   - Avg fix loops by type: {object}
   - Runs analyzed: {N}

   ## Run Summaries
   {last N RunSummaries from sdd_get_run_summary(last_n_runs=10)}

   ## Active Patterns
   {from sdd_get_patterns(status="active")}

   ## Completed Experiments
   {from .sdd/metacognition/experiments.json, filtered to status="completed"}
   ```

4. The reviewer calls `sdd_propose_evolution` (max 2 proposals) based on this data.

---

## Section C: Run close -- sdd_approve_evolution

**Location:** Adaptive Run Close sequence, step 4d (immediately after opus-meta-reviewer produces evolutions via `sdd_propose_evolution`).

```
AFTER: opus-meta-reviewer calls sdd_propose_evolution (max 2 proposals)
INSERT:
```

### Evolution Auto-Approval (sdd_approve_evolution)

After `opus-meta-reviewer` calls `sdd_propose_evolution`, the orchestrator processes each proposed evolution:

1. Read `.sdd/metacognition/evolutions.json` and filter for `status="proposed"` entries created in this run close cycle.
2. For each proposed evolution, check its `type` and `impact` fields:

   a. **If `type="weight_adjust"` or `type="threshold_adjust"` (low-risk parameter tuning):**
   ```
   mcp__sdd-autopilot__sdd_approve_evolution(
     project_path: "{project_path}",
     evolution_id: "{evolution.evolution_id}",
     decision:     "approve",
     reason:       "Auto-approved: low-risk parameter tuning ({evolution.type})"
   )
   ```
   The handler auto-applies weight changes to `score_weights.json`. Log the approval:
   ```
   sdd_log_event(project_path, feature_id, event_type="evolution_approved", phase="post_pipeline", agent_id="orchestrator",
     data={ evolution_id: "{evolution_id}", type: "{type}", auto_approved: true })
   ```

   b. **If `type` is structural (`phase_add`, `phase_remove`, `agent_redesign`, `contract_change`) OR `impact="high"` OR `requires_human=true`:**
   Do NOT call `sdd_approve_evolution`. Instead:
   ```
   mcp__sdd-autopilot__sdd_append_signal(
     project_path: "{project_path}",
     feature_id:   "{feature_id}",
     signal: {
       type:    "ATTENTION_REQUIRED",
       content: "Structural evolution proposed: {evolution.evolution_id} -- {evolution.description}. Requires human review. Run: sdd_approve_evolution(evolution_id, decision=approve|reject)",
       source:  "orchestrator"
     }
   )
   ```
   Log:
   ```
   sdd_log_event(project_path, feature_id, event_type="evolution_pending", phase="post_pipeline", agent_id="orchestrator",
     data={ evolution_id: "{evolution_id}", type: "{type}", requires_human: true })
   ```

**Hard rule:** The orchestrator NEVER auto-approves structural evolutions. Only `weight_adjust` and `threshold_adjust` are auto-approved. This is a safety constraint that must not be overridden.
---

## Section D: Adaptive run start -- sdd_abandon_experiment

**Location:** Adaptive Run Start sequence, step 4 (after reading experiments, before explore/exploit decision).

```
AFTER: Read .sdd/metacognition/experiments.json and filter experiments with status="proposed" or "running"
INSERT:
```

### Stale Experiment Cleanup (sdd_abandon_experiment)

Before the explore/exploit decision, check for experiments that should be abandoned:

1. For each experiment with `status="proposed"` or `status="running"`:

   a. **Context mismatch check:** Compare the experiment context (stored in `mutation` object, e.g., `mutation.feature_type`) with the current run `feature_type` and `complexity` from triage.
   - If the experiment was proposed for a different `feature_type` than the current run (e.g., experiment targets `api` but current run is `ui`): abandon it.
   ```
   mcp__sdd-autopilot__sdd_abandon_experiment(
     project_path:  "{project_path}",
     experiment_id: "{experiment.experiment_id}",
     reason:        "context_mismatch: experiment targets feature_type={experiment_feature_type} but current run is feature_type={current_feature_type}"
   )
   ```

   b. **Staleness check:** Count how many runs have occurred since the experiment was created. Read `.sdd/analytics/history.jsonl` and count entries with timestamps after `experiment.created_at`.
   - If the experiment has `status="running"` AND more than 3 runs have elapsed since `created_at` without an evaluation:
   ```
   mcp__sdd-autopilot__sdd_abandon_experiment(
     project_path:  "{project_path}",
     experiment_id: "{experiment.experiment_id}",
     reason:        "stale_experiment: running for {N} runs without evaluation (threshold: 3)"
   )
   ```

2. Log each abandonment:
   ```
   sdd_log_event(project_path, feature_id, event_type="experiment_abandoned", phase="adaptive_start", agent_id="orchestrator",
     data={ experiment_id: "{experiment_id}", reason: "{reason}" })
   ```

3. After cleanup, re-read experiments to get the updated list (some may now be abandoned). Only experiments still in `status="proposed"` or `status="running"` proceed to the explore/exploit decision.
---

## Section E: Signal Routing -- REWRITE of current section

```
REPLACE SECTION: ## Signal routing
FROM LINE: "## Signal routing" (line approximately 242)
TO LINE: End of the signal routing table, before "## Error handling" (line approximately 253)
WITH:
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
3. After PR creation (post-pipeline step 4 -- "Process buffered META_LEARNING_HINT signals"):
   a. For each buffered hint, call `mcp__sdd-autopilot__sdd_memory_write`:
      ```
      mcp__sdd-autopilot__sdd_memory_write(
        project_path: "{project_path}",
        scope:        "project",
        content:      "Meta-learning hint from {signal.source}: {signal.content}",
        section:      "learnings"
      )
      ```
   b. Feed the full buffer as context to `haiku-analyst` in retro mode (post-pipeline step 3), so the retro can incorporate meta-learning observations.
4. Mark all META_LEARNING_HINT signals as processed after the retro completes.
---

## Section F: Adaptive Orchestrator -- REWRITE of current section

```
REPLACE SECTION: ## Adaptive Orchestrator (Decision Tree)
FROM LINE: "## Adaptive Orchestrator (Decision Tree)" (line approximately 317)
TO LINE: End of "Tracking run_count" paragraph, before "## Example" (line approximately 373)
WITH:
```

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
For each experiment from step 3, apply the abandonment checks from Section D:
- Context mismatch: experiment `mutation.feature_type` differs from current `feature_type` from triage.
- Staleness: `status="running"` AND more than 3 runs elapsed since `created_at` without evaluation.

Call `mcp__sdd-autopilot__sdd_abandon_experiment` for each experiment that matches either condition. Re-read experiments after cleanup.

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

Execute this sequence after the post-pipeline steps complete (steps 1-6: `sdd_get_run_summary`, `sdd_compute_score`, haiku-analyst retro, META_LEARNING_HINT processing, `sdd_memory_write`, `sdd_tick_decay`). This section covers only the metacognition-specific steps.

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