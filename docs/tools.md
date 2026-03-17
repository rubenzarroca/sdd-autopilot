[Back to README](../README.md)

# MCP Tools Reference

SDD Autopilot exposes 38 MCP tools organized into four categories. All tools are deterministic Node.js handlers — no LLM calls. Metacognition tools (13) are gated behind `run_counter >= 5` — they self-protect and return `status: "inactive"` when called with insufficient history. See `engine/src/tool-stratification.json` for the runtime category map.

### Verbosity parameter

10 read tools accept an optional `verbosity` parameter (`"minimal"` | `"standard"` | `"full"`, default: `"full"`). Use `"minimal"` or `"standard"` to reduce token usage in multi-agent pipelines. Affected tools: `sdd_get_state`, `sdd_get_contract`, `sdd_evaluate_gate`, `sdd_memory_read`, `sdd_get_run_summary`, `sdd_get_analytics`, `sdd_compute_score`, `sdd_get_patterns`, `sdd_get_strategy`, `sdd_phase_confidence`.

## Core Pipeline (15 tools)

| Tool | Purpose |
|------|---------|
| `sdd_get_state` | Read current feature state and signals |
| `sdd_transition` | Move a feature between states (enforces AGENT_PERMISSIONS) |
| `sdd_get_contract` | Read phase definition from contracts.json |
| `sdd_evaluate_gate` | Mechanical gate checks (file exists, section non-empty, etc.) |
| `sdd_classify_failure` | Classify error as implementation_bug / spec_gap / infra_issue |
| `sdd_delta_check` | Detect regression in fix loop (abort if failures increase) |
| `sdd_log_event` | Append structured event to `.sdd/runs/{feature}/run.log` (also handles decision breadcrumbs via `event_type='decision'`) |
| `sdd_memory_read` | Read project or user memory by section |
| `sdd_memory_write` | Write to project or user memory |
| `sdd_append_signal` | Emit a signal (dual-write: state.json + signals.jsonl) |
| `sdd_update_task` | Mark a task as pending / in-progress / completed |
| `sdd_tick_maintenance` | Decrement TTLs on patterns and memory entries (`target='memory'` or `target='patterns'`) |
| `sdd_update_feature` | Persist feature metadata: branch, worktree_path, plan_path, tasks_path, etc. |
| `sdd_refresh_state` | Invalidate in-memory state cache (force next read to reload from disk). Use when external agents modify `state.json` directly. |
| `sdd_record_run` | Record a completed pipeline run. Increments project-level `run_counter` and appends to `run_history` (bounded to 20 entries, FIFO). Call at end of every run. |

## Observability (6 tools)

| Tool | Purpose |
|------|---------|
| `sdd_emit_metrics` | Record PhaseMetrics for a completed phase (duration, fix_loops, outcome). Includes built-in validation. |
| `sdd_get_run_summary` | Aggregate metrics.jsonl -> RunSummary (first_pass_rate, phases_skipped, total_fix_loops). Includes inline threshold alerts. |
| `sdd_get_analytics` | Cross-run analytics: score trends, high-variance phases, avg duration by phase |
| `sdd_estimate_cost` | Estimate cost in USD from token consumption |
| `sdd_compare_runs` | Compare two pipeline runs side by side |
| `sdd_detect_anomaly` | Z-score anomaly detection vs historical distribution |

## Metacognition (13 tools)

| Tool | Purpose |
|------|---------|
| `sdd_compute_score` | Compute composite pipeline score (quality_weight=0.70 . efficiency_weight=0.30). Golden baseline computed dynamically as complexity-weighted moving average. |
| `sdd_get_patterns` | Read active ExploitationPatterns matching current run context |
| `sdd_propose_pattern` | Propose a new ExploitationPattern (status=candidate) |
| `sdd_promote_pattern` | Promote candidate -> active (gate: >=5 supporting runs, confidence>=0.70) |
| `sdd_propose_experiment` | Propose a controlled experiment (one-active constraint enforced) |
| `sdd_evaluate_experiment` | Set verdict on the active experiment (promote / discard / retry, max 2 retries) |
| `sdd_propose_evolution` | Propose a PipelineEvolution; structural types always require human approval |
| `sdd_approve_evolution` | Approve or reject a PipelineEvolution |
| `sdd_abandon_experiment` | Cancel an experiment without evaluating |
| `sdd_update_pattern` | Increment supporting_runs / update confidence on a pattern |
| `sdd_get_strategy` | Read active patterns + experiments + weights for run strategy |
| `sdd_run_retro` | Generate structured retro report for a completed run |
| `sdd_phase_confidence` | Assign confidence score to phase output |

## Infrastructure (4 tools)

| Tool | Purpose |
|------|---------|
| `sdd_get_manifest` | Get SHA-256 hash of tool definitions for version drift detection |
| `sdd_propose_tool` | Propose a new MCP tool (self-evolution: agent detects a missing capability) |
| `sdd_review_tool_proposal` | Review a tool proposal for overlap, coherence, and necessity |
| `sdd_generate_tool_prompt` | Generate implementation prompt for a validated tool proposal |
