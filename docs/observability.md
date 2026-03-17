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
|  metrics.jsonl --> sdd_get_run_summary* --> summary.json    |
|                              |                              |
|                    sdd_get_analytics* --> analytics/         |
|                              |            history.jsonl      |
+------------------------------+-----------------------------+
                               |  RunSummary + AnalyticsResult
                               v
+------------------------------------------------------------+
|  METACOGNITION  (.sdd/metacognition/)                       |
|                                                             |
|  sdd_compute_score* ---------------------> CompositeScore   |
|    quality_weight=0.70 . efficiency_weight=0.30             |
|    sub-scores: review_result . findings . fix_loops .       |
|                phases_skipped . duration_trend               |
|                                                             |
|  +----------------------+  +----------------------------+   |
|  |   EXPLOITATION       |  |   EXPLORATION              |   |
|  |   (80% of runs)      |  |   (every 5th run)          |   |
|  |                      |  |                            |   |
|  |  sdd_get_patterns*   |  |  sdd_propose_experiment    |   |
|  |    -> apply active   |  |    (one-active constraint) |   |
|  |       patterns       |  |  sdd_evaluate_experiment   |   |
|  |                      |  |    verdict: promote /      |   |
|  |  sdd_propose_pattern |  |             discard / retry|   |
|  |  sdd_promote_pattern |  |                            |   |
|  |    (gate: >=5 runs,  |  |                            |   |
|  |     confidence>=0.70)|  |                            |   |
|  |  sdd_tick_maintenance|  |                            |   |
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
- **review_result** — did the code review approve?
- **findings** — number and severity of findings
- **fix_loops** — how many fix iterations were needed
- **phases_skipped** — phases that were skipped (e.g., triage)
- **duration_trend** — is the pipeline getting faster or slower?

## Golden Benchmarks

The golden baseline is computed dynamically by `sdd_compute_score` as a complexity-weighted moving average of the last N completed runs from `history.jsonl` (N configurable, default 5, minimum 3 runs to activate). Each run's score is weighted by its triage complexity: `trivial=0.6, low=0.8, medium=1.0, high=1.2, critical=1.4`. No manual golden snapshot tool is needed.

## Breadcrumbs

Subagent breadcrumbs are recorded via `sdd_log_event` with `event_type='decision'` for post-run audit.

## Anomaly Detection

Z-score anomaly detection (`sdd_detect_anomaly`, infra category) catches regressions automatically by comparing current metrics against historical distribution. Threshold alerts are included inline in `sdd_get_run_summary`.

## Response Verbosity

Tools marked with `*` in the diagram above support an optional `verbosity` parameter (`"minimal"` | `"standard"` | `"full"`, default: `"full"`). Subagents should pass `verbosity: "minimal"` to reduce context consumption in multi-agent pipelines. See [MCP Tools Reference](tools.md) for the full list.

## Cache Invalidation

The MCP server caches `state.json` in memory for performance. Internal writes (via `sdd_transition`, `sdd_update_task`, etc.) update the cache eagerly. If an external process modifies `state.json` directly, call `sdd_refresh_state` to force a reload. Contracts and specs are not cached — contracts are loaded once at import time, specs are read from disk on demand.

## Exploitation vs Exploration

- **Exploitation (80% of runs):** Apply active patterns learned from previous runs. Patterns are proposed, promoted (gate: >=5 supporting runs, confidence>=0.70), and decayed over time via TTL.
- **Exploration (every 5th run):** Run controlled experiments with one-active constraint. Experiments are evaluated with verdict: promote / discard / retry (max 2 retries).
