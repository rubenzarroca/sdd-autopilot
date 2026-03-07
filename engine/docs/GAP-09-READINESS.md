# GAP-09: Token & Cost Readiness

## Status: Infrastructure Ready -- Awaiting Claude Code Metadata

### 1. Cost Estimation Tool

`sdd_estimate_cost` already computes per-phase and total costs from `tokens_in` / `tokens_out` fields in `PhaseMetrics`. It applies configurable per-model pricing (opus/sonnet/haiku) and produces a breakdown by phase and model tier.

### 2. PhaseMetrics Schema

The `PhaseMetrics` interface already includes nullable token fields:

```typescript
tokens_in:  number | null;
tokens_out: number | null;
```

These fields are part of the schema, validated by `sdd_validate_metrics`, persisted in `metrics.jsonl`, and aggregated by `sdd_get_run_summary`.

### 3. Current Limitation

Claude Code does not expose usage metadata (token counts) in Agent tool responses. As a result, `tokens_in` and `tokens_out` are `null` in most real runs. The `sdd_estimate_cost` tool handles this gracefully -- phases with null tokens report `cost_usd: 0`.

### 4. What Changes When Claude Code Exposes Token Data

When Claude Code starts returning usage metadata:

1. Subagents emit `sdd_emit_metrics` with real `tokens_in` / `tokens_out` values instead of `null`.
2. `sdd_estimate_cost` processes them without any code changes.
3. `sdd_get_run_summary` aggregates `total_tokens` across phases (already implemented).
4. `sdd_compute_score` can optionally incorporate token efficiency into the pipeline score (weight infrastructure exists via `tokens_available` flag in `ScoreWeights`).

### 5. Conclusion

No code changes are needed for GAP-09. The token and cost infrastructure is fully implemented and tested. The only missing piece is the upstream data source (Claude Code usage metadata), which is outside the scope of this project.
