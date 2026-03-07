[Back to README](../README.md)

# MCP Tools Reference

SDD Autopilot exposes 39 MCP tools organized into four categories. All tools are deterministic Node.js handlers — no LLM calls.

## Core Pipeline (13 tools)

| Tool | Purpose |
|------|---------|
| `sdd_get_state` | Read current feature state and signals |
| `sdd_transition` | Move a feature between states (enforces AGENT_PERMISSIONS) |
| `sdd_get_contract` | Read phase definition from contracts.json |
| `sdd_evaluate_gate` | Mechanical gate checks (file exists, section non-empty, etc.) |
| `sdd_classify_failure` | Classify error as implementation_bug / spec_gap / infra_issue |
| `sdd_delta_check` | Detect regression in fix loop (abort if failures increase) |
| `sdd_log_event` | Append structured event to `.sdd/runs/{feature}/run.log` |
| `sdd_memory_read` | Read project or user memory by section |
| `sdd_memory_write` | Write to project or user memory |
| `sdd_tick_decay` | Decrement TTLs on learned patterns and exploration entries |
| `sdd_append_signal` | Emit a signal (dual-write: state.json + signals.jsonl) |
| `sdd_update_task` | Mark a task as pending / in-progress / completed |
| `sdd_update_feature` | Persist feature metadata: branch, worktree_path, plan_path, tasks_path, etc. |

## Observability (9 tools)

| Tool | Purpose |
|------|---------|
| `sdd_emit_metrics` | Record PhaseMetrics for a completed phase (duration, fix_loops, outcome) |
| `sdd_get_run_summary` | Aggregate metrics.jsonl -> RunSummary (first_pass_rate, phases_skipped, total_fix_loops) |
| `sdd_get_analytics` | Cross-run analytics: score trends, high-variance phases, avg duration by phase |
| `sdd_check_thresholds` | Detect when metrics cross thresholds (fix loops, duration ratio, first pass rate) |
| `sdd_estimate_cost` | Estimate cost in USD from token consumption |
| `sdd_get_live_status` | Query which phase is currently executing |
| `sdd_compare_runs` | Compare two pipeline runs side by side |
| `sdd_detect_anomaly` | Z-score anomaly detection vs historical distribution |
| `sdd_validate_metrics` | Validate PhaseMetrics before persisting |

## Metacognition (14 tools)

| Tool | Purpose |
|------|---------|
| `sdd_compute_score` | Compute composite pipeline score (quality_weight=0.70 . efficiency_weight=0.30) |
| `sdd_get_patterns` | Read active ExploitationPatterns matching current run context |
| `sdd_propose_pattern` | Propose a new ExploitationPattern (status=candidate) |
| `sdd_promote_pattern` | Promote candidate -> active (gate: >=5 supporting runs, confidence>=0.70) |
| `sdd_tick_patterns` | Decrement TTL on all active patterns (status->decayed at 0) |
| `sdd_propose_experiment` | Propose a controlled experiment (one-active constraint enforced) |
| `sdd_evaluate_experiment` | Set verdict on the active experiment (promote / discard / retry, max 2 retries) |
| `sdd_propose_evolution` | Propose a PipelineEvolution; structural types always require human approval |
| `sdd_approve_evolution` | Approve or reject a PipelineEvolution |
| `sdd_abandon_experiment` | Cancel an experiment without evaluating |
| `sdd_update_pattern` | Increment supporting_runs / update confidence on a pattern |
| `sdd_get_strategy` | Read active patterns + experiments + weights for run strategy |
| `sdd_run_retro` | Generate structured retro report for a completed run |
| `sdd_phase_confidence` | Assign confidence score to phase output |

## Infrastructure (3 tools)

| Tool | Purpose |
|------|---------|
| `sdd_set_golden` | Set golden run benchmark; `sdd_compute_score` compares against it |
| `sdd_get_manifest` | Get SHA-256 hash of tool definitions for version drift detection |
| `sdd_breadcrumb` | Record subagent decision breadcrumbs for audit trail |
