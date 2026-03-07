[Back to README](../README.md)

# Observability & Metacognition

Each pipeline run feeds a learning loop that adapts future runs.

## Data Flow

```
                      PIPELINE RUN
                           |
                           |  sdd_emit_metrics (once per phase)
                           v
+------------------------------------------------------------+
|  OBSERVABILITY  (.sdd/runs/{feature}/)                      |
|                                                             |
|  metrics.jsonl --> sdd_get_run_summary --> summary.json     |
|                              |                              |
|                    sdd_get_analytics --> analytics/          |
|                              |            history.jsonl      |
+------------------------------+-----------------------------+
                               |  RunSummary + AnalyticsResult
                               v
+------------------------------------------------------------+
|  METACOGNITION  (.sdd/metacognition/)                       |
|                                                             |
|  sdd_compute_score ----------------------> CompositeScore   |
|    quality_weight=0.70 . efficiency_weight=0.30             |
|    sub-scores: review_result . findings . fix_loops .       |
|                phases_skipped . duration_trend               |
|                                                             |
|  +----------------------+  +----------------------------+   |
|  |   EXPLOITATION       |  |   EXPLORATION              |   |
|  |   (80% of runs)      |  |   (every 5th run)          |   |
|  |                      |  |                            |   |
|  |  sdd_get_patterns    |  |  sdd_propose_experiment    |   |
|  |    -> apply active   |  |    (one-active constraint) |   |
|  |       patterns       |  |  sdd_evaluate_experiment   |   |
|  |                      |  |    verdict: promote /      |   |
|  |  sdd_propose_pattern |  |             discard / retry|   |
|  |  sdd_promote_pattern |  |                            |   |
|  |    (gate: >=5 runs,  |  |                            |   |
|  |     confidence>=0.70)|  |                            |   |
|  |  sdd_tick_patterns   |  |                            |   |
|  |    (TTL decay)       |  |                            |   |
|  +----------------------+  +----------------------------+   |
|                                                             |
|  sdd_propose_evolution -----------------> evolutions.json   |
|    structural (phase_add/remove/agent_redesign)              |
|      -> requires_human=true always                          |
|    weight_adjust / contract_change                          |
|      -> auto-applicable by orchestrator                     |
+------------------------------+-----------------------------+
                               |  every N runs
                               v
                    opus-meta-reviewer (subagent)
                    analyzes cross-run trends ->
                    proposes <=2 evolutions per review ->
                    logs meta_review_complete event
```

## Composite Score

The score formula is stable across runs. Only `score_weights.json` is adjustable — and only by +/-0.05 per review cycle, with full audit trail.

Sub-scores:
- **review_result** — did the adversarial reviewer approve?
- **findings** — number and severity of findings
- **fix_loops** — how many fix iterations were needed
- **phases_skipped** — phases that were skipped (e.g., triage)
- **duration_trend** — is the pipeline getting faster or slower?

## Golden Benchmarks

Golden run benchmarks (`sdd_set_golden`) let `sdd_compute_score` compare the current run against a known-good baseline.

## Breadcrumbs

Subagent breadcrumbs (`sdd_breadcrumb`) record decision points across the pipeline for post-run audit.

## Anomaly Detection

Z-score anomaly detection (`sdd_detect_anomaly`) and threshold checks (`sdd_check_thresholds`) catch regressions automatically by comparing current metrics against historical distribution.

## Exploitation vs Exploration

- **Exploitation (80% of runs):** Apply active patterns learned from previous runs. Patterns are proposed, promoted (gate: >=5 supporting runs, confidence>=0.70), and decayed over time via TTL.
- **Exploration (every 5th run):** Run controlled experiments with one-active constraint. Experiments are evaluated with verdict: promote / discard / retry (max 2 retries).
