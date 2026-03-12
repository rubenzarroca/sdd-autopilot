# Post-Pipeline Reference

**ALWAYS run post-pipeline steps regardless of pipeline outcome** (success, failure, escalation, or any terminal state). The retro is especially valuable when things fail.

After PR creation (or after pipeline termination if it did not reach PR):

## Step 1 — Run summary

Call `sdd_get_run_summary` with `project_path`, `feature_id`, and the `run_id`. This aggregates all PhaseMetrics into a RunSummary, persists `summary.json` (merge-aware: preserves prior `review_decision` and `pipeline_score` on re-run), and appends to `analytics/history.jsonl`.

**Write-on-generate — persist Run History to memory immediately:**
```
MEM_WRITE(section="run_history", content="Run {run_id} for '{feature_id}': phases={phase_count}, first_pass_rate={first_pass_rate}, total_duration={total_duration_ms}ms, review={review_decision}")
```
This ensures the run entry is persisted even if later steps are lost to context compaction.

## Step 2 — Compute score + review decision

Call `sdd_compute_score` with `project_path`, `feature_id`, and `review_decision`. Pass the review decision from the code-review result:
- If code-review ran: `review_decision="approve"` / `"request_changes"` / `"reject"`
- If Express mode (no code-review): `review_decision=null`
- If review was skipped for another reason: omit `review_decision` to preserve existing value

This single call reads `summary.json`, computes quality + efficiency scores, patches both `pipeline_score` and `review_decision` atomically into `summary.json`.

**Do NOT manually read/patch summary.json.** All writes go through MCP tools with atomic write protection.

**Write-on-generate:**
```
MEM_WRITE(section="run_history", content="Score for run {run_id} ('{feature_id}'): pipeline_score={pipeline_score}, quality={quality_score}, efficiency={efficiency_score}, golden_status={golden_comparison.status}")
```

## Step 3 — Check thresholds

Extract `threshold_alerts` from the `sdd_get_run_summary` response (step 1).

- If any alert has `level: "critical"`: emit ATTENTION_REQUIRED signal + LOG with `event_type="threshold_alert"`. Store for retro.
- If all alerts are `level: "warning"`: store for retro only.
- If empty: proceed normally.

## Step 4 — Detect anomaly

Call `sdd_detect_anomaly(project_path, feature_id)`. Computes z-scores for `total_duration_ms`, `first_pass_rate`, `pipeline_score`, and `avg_confidence` against the historical distribution (requires >= 5 prior runs).

- If `is_anomaly: true`: flag run as anomalous, skip pattern promotion during retro, include anomaly details in retro context.
- If `is_anomaly: false` or `status: "insufficient_data"`: proceed normally.

## Step 5 — Golden baseline

No tool call needed. The golden is computed dynamically by `sdd_compute_score` (step 2).

Read `golden_comparison` from the `sdd_compute_score` response and log:
- `"insufficient_data"` -> "Golden baseline: {message} (showing absolute score: {current_score})"
- `"meets_golden"` -> "Score {current_score} (weighted: {weighted_score}) vs golden {golden_score} (delta: {delta}, trend: {trend})"
- `"below_threshold"` -> "Warning: Score {current_score} below golden {golden_score} by {delta}"

Golden baseline is computed dynamically by `sdd_compute_score` — no separate tool call needed.

**Complexity weighting**: `trivial=0.6, low=0.8, medium=1.0, high=1.2, critical=1.4`.

## Step 6 — Retro (MANDATORY)

**This step must execute even if the pipeline failed, was escalated, or was interrupted.**

Call `sdd_run_retro(project_path, feature_id, expected_outcome="clean_pass"|"minor_fixes")`.

After the retro completes, if there are noteworthy insights (bottleneck, anomaly, or actionable suggestion), include up to 2 lines in the completion report after the score line: `📝 Retro:` + `→ {insight}`. If the run was clean with no anomalies, omit the retro section entirely (progressive disclosure).

**Write-on-generate:**
```
MEM_WRITE(section="retro_learnings", content="Retro for run {run_id} ('{feature_id}'): outcome={outcome}, bottlenecks={bottlenecks}, suggestions_count={suggestions.length}, patterns_confirmed={patterns_confirmed.length}, patterns_contradicted={patterns_contradicted.length}")
```

## Step 6b — Review tool proposals (conditional)

If any tool proposals were created during this run (check `.sdd/proposals/` for files with `status: "proposed"` and matching `run_id`):
- Call `sdd_review_tool_proposal` for each.
- If validated: call `sdd_generate_tool_prompt`.
- If rejected: log and move on.

This step is optional and non-blocking.

## Step 7 — Retro analysis (inline)

Using the retro output from step 6, threshold alerts (step 3), and anomaly context (step 4):

a. **Pattern management** (skip if `is_anomaly: true`):
   - Call `sdd_get_patterns(status="candidate")`.
   - If any candidate has `supporting_runs >= min_runs` threshold -> call `sdd_promote_pattern`.
   - If this run evidences a new pattern (same behavior across >= 3 runs) -> call `sdd_propose_pattern` with `initial_confidence: 0.5`.
   - Do NOT propose a pattern from a single run. Do NOT duplicate existing candidates.

b. **Exploration** (only if `run_count % 5 == 0` and no experiment is currently `status=proposed` or `running`):
   - Identify highest-potential improvement target.
   - Formulate a falsifiable hypothesis and call `sdd_propose_experiment`.
   - One experiment max per retro. Prefer low/medium risk.

c. LOG with `event_type="retro_analysis"`.

## Step 8 — Process META_LEARNING_HINT signals

Write buffered hints to memory. Feed buffer to retro context.

## Step 9 — Consolidation write

Write remaining learnings to memory via MEM_WRITE. Note: critical data was already persisted by write-on-generate in steps 1, 2, and 6.

After step 9, proceed to Adaptive Run Close.

## Step 10 — Branch deletion + Worktree cleanup

**Branch deletion** (on merge only):
Delete the feature branch from both remote and local to prevent branch accumulation:
```bash
git push origin --delete {branch_name}
git branch -D {branch_name}
```
If the current checkout is on the feature branch, switch to the base branch first (`git checkout main`).
If deletion fails (already deleted, permissions), log a warning but do not block the pipeline.

**Worktree cleanup** — after branch deletion, if worktree was created and `skip_worktree` is not set:
- **If `merged`**: invoke `/worktree-pr cleanup`.
- **If `escalated`**: invoke `/worktree-pr cleanup`.
- **If `pr_created`** (not yet merged): skip cleanup, report worktree path.
- **If `--skip-pr`**: skip cleanup.

## Completion report format

```
===================================================
 SDD PIPELINE REPORT -- {feature_id}
===================================================

 Phase       | Duration | Tokens In | Tokens Out | Total    | Tools | Gate | Fix | Conf
-------------|----------|-----------|------------|----------|-------|------|-----|------
 Triage      | {dur}    | {in}      | {out}      | {total}  | {N}   | pass | 0   | --
 Specify     | {dur}    | {in}      | {out}      | {total}  | {N}   | pass | {N} | {conf}
 Plan        | {dur}    | {in}      | {out}      | {total}  | {N}   | pass | {N} | {conf}
 Tasks       | {dur}    | {in}      | {out}      | {total}  | {N}   | pass | {N} | {conf}
 Implement   | {dur}    | {in}      | {out}      | {total}  | {N}   | pass | {N} | {conf}
 Verify      | {dur}    | {in}      | {out}      | {total}  | {N}   | pass | {N} | {conf}
 Review      | {dur}    | {in}      | {out}      | {total}  | {N}   | pass | {N} | {conf}
 PR          | {dur}    | {in}      | {out}      | {total}  | {N}   | pass | 0   | --
-------------|----------|-----------|------------|----------|-------|------|-----|------
 TOTAL       | {total}  | {sum_in}  | {sum_out}  | {sum}    | {N}   |      | {N} | {avg}

 Score: {pipeline_score}/100 | First-pass: {first_pass_rate}%
 Golden: {golden_score} (weighted avg, {N} runs) | Delta: {delta} | Trend: {trend}
 Bottleneck: {slowest phase} ({reason})
 PR: {url}
===================================================
```

Build from `metrics.jsonl` and `phase_confidence.json` in `.sdd/runs/{feature_id}/`.

### Cost reference (for post-processing)

| Model             | Input ($/1M tokens) | Output ($/1M tokens) |
|-------------------|---------------------|----------------------|
| claude-haiku-4-5  | $0.80               | $4.00                |
| claude-sonnet-4-6 | $3.00               | $15.00               |
| claude-opus-4-6   | $15.00              | $75.00               |

The orchestrator does NOT compute costs inline — only records tokens. Users process cost data from metrics.jsonl + this table.

**Golden line**: populate from `golden_comparison` in `sdd_compute_score`. If `status: "insufficient_data"`, replace with: `Golden: not enough data ({runs}/{window} runs)`

## Human Debrief

Collect items requiring human attention from 7 sources:
1. Tool proposals validated this run
2. Evolutions pending human approval
3. Critical threshold alerts
4. Anomaly flags
5. Golden degradation
6. Memory sanitization warnings
7. Pending proposals from previous runs

Show only sections with items. If no items: `"HUMAN DEBRIEF: No action items. All clear."`

The debrief is the LAST thing shown. It does not block the pipeline.

## Post-pipeline iterations

After the pipeline, user may request changes. Track each iteration:
1. LOG `event_type="post_pipeline_iteration"` with user request summary
2. Launch `implementation-engine` pointing at worktree/project
3. LOG `event_type="post_pipeline_iteration_done"` with files changed
