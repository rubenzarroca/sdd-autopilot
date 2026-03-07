# Post-Pipeline Observability Integration Patch

Patch instructions for integrating 5 MCP tools into `skills/auto-run/SKILL.md`.
Each insertion specifies an AFTER/INSERT/BEFORE block with exact anchors from the current SKILL.md.

---

## Section A: Per-phase addition — sdd_phase_confidence

**Location:** Inside the Phase protocol (step 8), after the `sdd_emit_metrics` call (line 75) and before step 9 (gate failure handling, line 79).

~~~
AFTER:   - Call `sdd_log_event` with event_type `"phase_complete"`, data `{ gate_result: "passed", phase }` (see Observability section)
INSERT:
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
BEFORE:9. If gate failed: call `mcp__sdd-autopilot__sdd_classify_failure` to determine the category:
~~~

---

## Section B: Post-pipeline sequence — 4 tools

**Location:** After `sdd_compute_score` (currently post-pipeline step 2, line 301) and before the haiku-analyst retro (currently post-pipeline step 3, line 302).

The complete post-pipeline sequence after this patch becomes:

```
1. sdd_get_run_summary     (already scripted)
2. sdd_compute_score       (already scripted)
3. sdd_check_thresholds    ← NEW
4. sdd_detect_anomaly      ← NEW
5. sdd_set_golden          ← NEW (conditional)
6. sdd_run_retro           ← NEW (fully scripted)
7. Run haiku-analyst retro  (already scripted)
8. Process META_LEARNING_HINT signals (already scripted)
9. sdd_memory_write        (already scripted)
10. sdd_tick_decay          (already scripted)
11. sdd_tick_patterns       (already scripted)
12. Worktree cleanup        (already scripted)
```

### Insertion 1: sdd_check_thresholds + sdd_detect_anomaly + sdd_set_golden + sdd_run_retro

~~~
AFTER:2. Call `mcp__sdd-autopilot__sdd_compute_score` with `project_path` and `feature_id`. This reads the patched `summary.json` and `analytics/history.jsonl`, computes quality + efficiency scores, and persists `pipeline_score` back into `summary.json`. Log the returned `pipeline_score` in the user-facing completion message.
INSERT:
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

BEFORE:3. Run `haiku-analyst` in retro mode (compare first-pass diff with final diff)
~~~

### Insertion 2: Update haiku-analyst retro step reference

The existing step "3. Run `haiku-analyst` in retro mode" becomes step 7 in the new numbering. No content change is needed — only ensure the haiku-analyst receives these additional context inputs:

- `retro_path`: `.sdd/runs/{feature_id}/retro.json` (from step 6)
- `threshold_alerts`: critical/warning alerts (from step 3, if any)
- `anomaly_context`: anomaly details (from step 4, if `is_anomaly: true`)
- `is_anomalous_run`: boolean flag — if `true`, haiku-analyst must NOT emit `sdd_propose_pattern` or `sdd_promote_pattern` calls

---

## Summary of changes

| Tool | When | Location in SKILL.md |
|------|------|---------------------|
| `sdd_phase_confidence` | After each phase's `sdd_emit_metrics` + `sdd_log_event` | Phase protocol step 8, before step 9 |
| `sdd_check_thresholds` | Post-pipeline, after `sdd_compute_score` | New post-pipeline step 3 |
| `sdd_detect_anomaly` | Post-pipeline, after `sdd_check_thresholds` | New post-pipeline step 4 |
| `sdd_set_golden` | Post-pipeline, conditional on score beating golden | New post-pipeline step 5 |
| `sdd_run_retro` | Post-pipeline, before haiku-analyst retro | New post-pipeline step 6 |
