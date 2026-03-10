# Adaptive Orchestrator Reference

Runs once after triage, before specify. Modifies pipeline based on learned patterns and experiments.

## ADAPTIVE RUN START

Call `sdd_get_strategy(project_path, feature_type, complexity)`. Store `applicable_patterns`, `active_experiments`, `exploration_decision` for the run.

**If `has_adaptations` is false -> skip straight to specify.** Nothing to adapt.

Otherwise, apply these steps in order:

### 1. Apply resolved mutations

From `strategy.mutations`:
- `phases_to_skip`: remove each listed phase from the sequence, LOG `phase_skipped`, emit metrics with `gate_result: "skip"`
- `model_overrides`: `{ "plan": "haiku" }` -> use that model for that phase
- `gate_overrides`: `{ "verify": "80%" }` -> pass threshold to subagent context
- `prompt_injections`: inject each entry's `text` into the target phase under `## Pattern-Driven Instructions`

### 2. Abandon stale experiments

For each experiment in `active_experiments`, abandon via `sdd_abandon_experiment` if: context mismatch (experiment `feature_type` != triage `feature_type`) OR stale (`status="running"` + 3+ runs without evaluation).

### 3. Apply experiment

Only if `exploration_decision.decision == "explore"` AND a proposed experiment exists:
- `risk_level` low/medium: apply `experiment.mutation`, mark `"running"`, store `experiment_applied`
- `risk_level` high: ask user for approval first; abandon if rejected

### 4. Proposal awareness

Check `.sdd/proposals/` for validated proposals. Note in run context. Skip silently if none.

### 5. Log

LOG with `event_type="adaptive_routing"`, `phase="pre_pipeline"`, including mode, scores, patterns applied, phases skipped, model overrides, experiment applied, pending proposals.

Continue to the specify phase (or the first non-skipped phase).

## ADAPTIVE RUN CLOSE

Execute after the post-pipeline steps complete (steps 1-9). This section covers only the metacognition-specific steps.

### Step 1 — Update pattern outcomes

For each pattern in the `applicable_patterns` list stored at run start:

1. Read `golden_comparison` from the `sdd_compute_score` response.
2. Determine `baseline`:
   - If `status` is `"meets_golden"` or `"below_threshold"`: use `golden_score` as baseline.
   - If `status` is `"insufficient_data"`: skip pattern updates entirely.
3. Compare `weighted_score` (not raw `pipeline_score`):
   - `weighted_score >= baseline`: call `sdd_update_pattern` with `outcome="success"`
   - `weighted_score < baseline * 0.9`: call with `outcome="failure"`
   - Between: skip (ambiguous zone)

### Step 2 — Evaluate experiment

If this was an exploration run AND `experiment_applied` is not null:

1. Read current and previous `pipeline_score` from `history.jsonl`.
2. Call `sdd_evaluate_experiment(project_path, experiment_id, result_score, baseline_score)`.
3. Handle the verdict:
   - **`promote`**: call `sdd_propose_pattern` with `confidence: 0.5, supporting_runs: 1, min_runs: 5, ttl: 20`.
   - **`discard`**: LOG and clean up.
   - **`retry`**: handler resets to `status="proposed"`. Max 2 retries before auto-discard.

### Step 3 — Promote mature candidates

Read candidate patterns: `sdd_get_patterns(status="candidate")`.
For each candidate where `supporting_runs >= 5` AND `confidence >= 0.7`:
- Call `sdd_promote_pattern`. LOG each promotion.

### Step 4 — Meta-review cycle (every N runs)

Count lines in `.sdd/analytics/history.jsonl` = `run_count`. Read `review_every_n` from `.sdd/metacognition/config.json` (default: 10).

If `run_count % review_every_n == 0` AND `run_count > 0`:

a. Call `sdd_get_analytics`, `sdd_get_run_summary(last_n_runs=10)`, `sdd_get_patterns(status="active")`.
b. Launch `opus-meta-reviewer` with analytics, summaries, patterns, and completed experiments.
c. Process proposed evolutions:
   - `weight_adjust` or `threshold_adjust`: auto-approve (low-risk parameter tuning).
   - Structural (`phase_add`, `phase_remove`, `agent_redesign`, `contract_change`) OR `impact="high"`: emit ATTENTION_REQUIRED signal, leave pending. **NEVER auto-approve structural evolutions.**

### Step 5 — Tick maintenance

Call `sdd_tick_maintenance(project_path, target="all")`. This decrements pattern TTLs using adaptive exponential decay AND decrements memory TTLs, pruning stale entries.

### Step 6 — Human Debrief

See post-pipeline.md for debrief format.

## Tracking run_count

Count lines in `.sdd/analytics/history.jsonl`. Drives:
- Exploration trigger: `run_count % 5 == 0`
- Meta-review trigger: `run_count % review_every_n == 0`

Default `review_every_n` = 10.
