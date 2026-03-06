// SDD Autopilot — Observability Layer handlers
// Implements sdd_emit_metrics, sdd_get_run_summary, sdd_get_analytics
// All deterministic — no LLM calls.

import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PhaseMetrics, RunSummary, AnalyticsResult, AnalyticsTrend } from "./types.js";
import { fileExists, parseJsonl } from "./utils.js";

// ─── sdd_emit_metrics ────────────────────────────────────────────

export async function handleEmitMetrics(params: {
  project_path: string;
  metrics: PhaseMetrics;
}): Promise<unknown> {
  const runDir = resolve(params.project_path, ".sdd", "runs", params.metrics.feature_id);
  await mkdir(runDir, { recursive: true });

  const metricsPath = join(runDir, "metrics.jsonl");
  await appendFile(metricsPath, JSON.stringify(params.metrics) + "\n", "utf-8");

  return { emitted: true, run_id: params.metrics.run_id, phase: params.metrics.phase };
}

// ─── sdd_get_run_summary ─────────────────────────────────────────

export async function handleGetRunSummary(params: {
  project_path: string;
  feature_id: string;
  run_id?: string;
  last_n_runs?: number;
}): Promise<unknown> {
  // last_n_runs: return N most recent historical summaries (no fresh computation)
  if (params.last_n_runs !== undefined) {
    const historyPath = resolve(params.project_path, ".sdd", "analytics", "history.jsonl");
    if (!await fileExists(historyPath)) {
      return { summaries: [], runs_analyzed: 0 };
    }
    const raw = await readFile(historyPath, "utf-8");
    const all = parseJsonl<RunSummary>(raw).filter(s => s.feature_id === params.feature_id);
    const last = all.slice(-params.last_n_runs);
    return { summaries: last, runs_analyzed: last.length };
  }

  // Compute fresh summary from metrics.jsonl
  const metricsPath = resolve(params.project_path, ".sdd", "runs", params.feature_id, "metrics.jsonl");
  if (!await fileExists(metricsPath)) {
    return { error: `No metrics found for feature "${params.feature_id}"` };
  }

  const raw = await readFile(metricsPath, "utf-8");
  const all = parseJsonl<PhaseMetrics>(raw);
  const metrics = params.run_id ? all.filter(m => m.run_id === params.run_id) : all;

  if (metrics.length === 0) {
    return { error: `No metrics found for run_id "${params.run_id}"` };
  }

  const phases_executed  = metrics.filter(m => m.gate_result !== "skip").map(m => m.phase);
  const phases_skipped   = metrics.filter(m => m.gate_result === "skip").map(m => m.phase);
  const total_duration_ms = metrics.reduce((s, m) => s + m.duration_ms, 0);

  const tokensList = metrics.map(m =>
    m.tokens_in !== null && m.tokens_out !== null ? m.tokens_in + m.tokens_out : null
  );
  const total_tokens = tokensList.every(t => t !== null)
    ? tokensList.reduce((s, t) => s! + t!, 0)
    : null;

  const total_fix_loops  = metrics.reduce((s, m) => s + m.fix_loop_count, 0);
  const verify_attempts  = metrics.filter(m => m.phase === "verify").length;
  const review_attempts  = metrics.filter(m => m.phase === "review").length;

  const passed = metrics.filter(m => m.gate_result === "pass");
  const first_pass_rate = passed.length > 0
    ? Math.round(passed.filter(m => m.gate_attempts === 1).length / passed.length * 100)
    : 0;

  let outcome: RunSummary["outcome"] = "aborted";
  if (phases_executed.includes("pr")) outcome = "pr_created";
  else if (phases_executed.some(p => p === "escalated")) outcome = "escalated";

  const first = metrics[0];
  const summary: RunSummary = {
    run_id:          params.run_id ?? first.run_id,
    feature_id:      params.feature_id,
    feature_type:    first.feature_type ?? "unknown",
    complexity:      first.complexity   ?? "unknown",
    outcome,
    total_duration_ms,
    total_tokens,
    phases_executed,
    phases_skipped,
    total_fix_loops,
    verify_attempts,
    review_attempts,
    review_decision: null,   // set by orchestrator from review agent structured output
    first_pass_rate,
    pipeline_score:  null,   // computed by sdd_compute_score (Phase 2)
    phase_metrics:   metrics,
  };

  // Persist summary.json
  const summaryPath = resolve(params.project_path, ".sdd", "runs", params.feature_id, "summary.json");
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf-8");

  // Append to cross-run analytics history
  const analyticsDir = resolve(params.project_path, ".sdd", "analytics");
  await mkdir(analyticsDir, { recursive: true });
  const historyPath = join(analyticsDir, "history.jsonl");
  await appendFile(historyPath, JSON.stringify(summary) + "\n", "utf-8");

  return summary;
}

// ─── sdd_get_analytics ───────────────────────────────────────────

export async function handleGetAnalytics(params: {
  project_path: string;
  feature_type?: string;
  complexity?:   string;
  date_from?:    string;
  date_to?:      string;
}): Promise<unknown> {
  const empty: AnalyticsResult = {
    filter: {
      feature_type: params.feature_type,
      complexity:   params.complexity,
      date_from:    params.date_from,
      date_to:      params.date_to,
    },
    runs_analyzed:                  0,
    avg_duration_by_phase:          {},
    avg_fix_loops_by_feature_type:  {},
    first_pass_rate_history:        0,
    high_variance_phases:           [],
    trends:                         [],
  };

  const historyPath = resolve(params.project_path, ".sdd", "analytics", "history.jsonl");
  if (!await fileExists(historyPath)) return empty;

  const raw = await readFile(historyPath, "utf-8");
  let summaries = parseJsonl<RunSummary>(raw);

  if (params.feature_type) summaries = summaries.filter(s => s.feature_type === params.feature_type);
  if (params.complexity)   summaries = summaries.filter(s => s.complexity   === params.complexity);
  if (params.date_from)    summaries = summaries.filter(s => (s.phase_metrics[0]?.started_at ?? "") >= params.date_from!);
  if (params.date_to)      summaries = summaries.filter(s => (s.phase_metrics[0]?.started_at ?? "") <= params.date_to!);

  if (summaries.length === 0) return { ...empty, runs_analyzed: 0 };

  // avg_duration_by_phase
  const durByPhase: Record<string, number[]> = {};
  for (const s of summaries) {
    for (const m of s.phase_metrics) {
      (durByPhase[m.phase] ??= []).push(m.duration_ms);
    }
  }
  const avg_duration_by_phase: Record<string, number> = {};
  for (const [p, ds] of Object.entries(durByPhase)) {
    avg_duration_by_phase[p] = Math.round(ds.reduce((a, b) => a + b, 0) / ds.length);
  }

  // avg_fix_loops_by_feature_type
  const flByType: Record<string, number[]> = {};
  for (const s of summaries) {
    (flByType[s.feature_type] ??= []).push(s.total_fix_loops);
  }
  const avg_fix_loops_by_feature_type: Record<string, number> = {};
  for (const [t, counts] of Object.entries(flByType)) {
    avg_fix_loops_by_feature_type[t] =
      Math.round(counts.reduce((a, b) => a + b, 0) / counts.length * 10) / 10;
  }

  // first_pass_rate_history (overall average across filtered runs)
  const first_pass_rate_history = Math.round(
    summaries.reduce((s, r) => s + r.first_pass_rate, 0) / summaries.length
  );

  // high_variance_phases: stddev > 50% of mean (at least 2 data points)
  const high_variance_phases: string[] = [];
  for (const [phase, ds] of Object.entries(durByPhase)) {
    if (ds.length < 2) continue;
    const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
    const stddev = Math.sqrt(ds.reduce((sum, d) => sum + (d - mean) ** 2, 0) / ds.length);
    if (stddev > mean * 0.5) high_variance_phases.push(phase);
  }

  // trends: compare first half vs second half (requires >= 4 runs for statistical meaning)
  const trends: AnalyticsTrend[] = [];
  if (summaries.length >= 4) {
    const mid = Math.floor(summaries.length / 2);
    const a = summaries.slice(0, mid);
    const b = summaries.slice(mid);
    const mean = <T>(arr: T[], fn: (x: T) => number): number =>
      arr.reduce((s, x) => s + fn(x), 0) / arr.length;

    const fpr_a = mean(a, s => s.first_pass_rate);
    const fpr_b = mean(b, s => s.first_pass_rate);
    trends.push({
      metric: "first_pass_rate",
      direction: fpr_b > fpr_a + 5 ? "improving" : fpr_b < fpr_a - 5 ? "regressing" : "stable",
      data_points: summaries.length,
    });

    const fl_a = mean(a, s => s.total_fix_loops);
    const fl_b = mean(b, s => s.total_fix_loops);
    trends.push({
      metric: "fix_loops",
      direction: fl_b < fl_a * 0.9 ? "improving" : fl_b > fl_a * 1.1 ? "regressing" : "stable",
      data_points: summaries.length,
    });

    const dur_a = mean(a, s => s.total_duration_ms);
    const dur_b = mean(b, s => s.total_duration_ms);
    trends.push({
      metric: "duration",
      direction: dur_b < dur_a * 0.9 ? "improving" : dur_b > dur_a * 1.1 ? "regressing" : "stable",
      data_points: summaries.length,
    });
  }

  const result: AnalyticsResult = {
    filter: {
      feature_type: params.feature_type,
      complexity:   params.complexity,
      date_from:    params.date_from,
      date_to:      params.date_to,
    },
    runs_analyzed: summaries.length,
    avg_duration_by_phase,
    avg_fix_loops_by_feature_type,
    first_pass_rate_history,
    high_variance_phases,
    trends,
  };
  return result;
}
