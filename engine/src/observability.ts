// SDD Autopilot — Observability Layer handlers
// Implements sdd_emit_metrics, sdd_get_run_summary, sdd_get_analytics
// All deterministic — no LLM calls.

import { readFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import type { PhaseMetrics, RunSummary } from "./types.js";
import { fileExists, parseJsonl, atomicWriteJSON, atomicAppendJSONL } from "./utils.js";
import { StateManager } from "./state.js";

// Fix loop caps from contracts.json — used by threshold checks
const FIX_LOOP_CAPS: Record<string, number> = (() => {
  try {
    const contractsPath = resolve(__dirname, "contracts.json");
    const contracts = JSON.parse(readFileSync(contractsPath, "utf-8"));
    const caps: Record<string, number> = {};
    for (const [phase, config] of Object.entries(contracts.contracts)) {
      const fl = (config as Record<string, unknown>).fix_loop as { max_attempts: number } | undefined;
      if (fl?.max_attempts) caps[phase] = fl.max_attempts;
    }
    return caps;
  } catch {
    return { verify: 3, review: 2 }; // fallback
  }
})();

// ─── sdd_emit_metrics ────────────────────────────────────────────

export async function handleEmitMetrics(params: {
  project_path: string;
  metrics: PhaseMetrics;
}): Promise<unknown> {
  // Fusion 3: validate metrics before writing
  const validation = await handleValidateMetrics({
    project_path: params.project_path,
    metrics: params.metrics as unknown as Record<string, unknown>,
  });
  if (!(validation as any).valid) {
    return { emitted: false, validation_errors: (validation as any).errors };
  }

  const runDir = resolve(params.project_path, ".sdd", "runs", params.metrics.feature_id);
  await mkdir(runDir, { recursive: true });

  const metricsPath = join(runDir, "metrics.jsonl");
  await atomicAppendJSONL(metricsPath, params.metrics);

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

  // Read phase confidence data
  const confPath = resolve(params.project_path, ".sdd", "runs", params.feature_id, "phase_confidence.json");
  let avg_confidence: number | null = null;
  if (await fileExists(confPath)) {
    try {
      const confEntries: Array<{ feature_id: string; confidence: number }> =
        JSON.parse(await readFile(confPath, "utf-8"));
      const featureConfs = confEntries
        .filter(e => e.feature_id === params.feature_id)
        .map(e => e.confidence);
      if (featureConfs.length > 0) {
        avg_confidence = Math.round(
          featureConfs.reduce((s, c) => s + c, 0) / featureConfs.length * 1000
        ) / 1000;
      }
    } catch { /* malformed file — leave null */ }
  }

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
    avg_confidence,
    phase_metrics:   metrics,
  };

  // Persist summary.json (merge-aware: preserve patches from prior writes)
  const summaryPath = resolve(params.project_path, ".sdd", "runs", params.feature_id, "summary.json");
  if (await fileExists(summaryPath)) {
    try {
      const prev: RunSummary = JSON.parse(await readFile(summaryPath, "utf-8"));
      if (prev.review_decision != null) summary.review_decision = prev.review_decision;
      if (prev.pipeline_score != null) summary.pipeline_score = prev.pipeline_score;
    } catch { /* corrupted previous file — overwrite cleanly */ }
  }
  await atomicWriteJSON(summaryPath, summary);

  // Append to cross-run analytics history
  const analyticsDir = resolve(params.project_path, ".sdd", "analytics");
  await mkdir(analyticsDir, { recursive: true });
  const historyPath = join(analyticsDir, "history.jsonl");
  await atomicAppendJSONL(historyPath, summary);

  // Fusion 2: include threshold alerts inline
  const thresholdResult = await handleCheckThresholds({
    project_path: params.project_path,
    feature_id: params.feature_id,
  });
  const threshold_alerts = (thresholdResult as any).alerts ?? [];
  (summary as any).threshold_alerts = threshold_alerts;

  return summary;
}

// ─── EMA (Exponential Moving Average) ─────────────────────────────

function computeEMA(values: number[], alpha: number): { ema: number[]; derivative: number[] } {
  const ema: number[] = [values[0]];
  const derivative: number[] = [0];
  for (let i = 1; i < values.length; i++) {
    const current = alpha * values[i] + (1 - alpha) * ema[i - 1];
    ema.push(current);
    derivative.push(current - ema[i - 1]);
  }
  return { ema, derivative };
}

function emaDirection(derivative: number[]): string {
  if (derivative.length < 2) return "stable";
  const last = derivative[derivative.length - 1];
  const prev = derivative[derivative.length - 2];
  if (Math.abs(last) < 0.01) return "stable";
  if (last < 0) return "degrading";
  if (last > prev) return "accelerating";
  return "decelerating";
}

// ─── sdd_get_analytics ───────────────────────────────────────────

export async function handleGetAnalytics(params: {
  project_path: string;
  feature_type?: string;
  complexity?:   string;
  date_from?:    string;
  date_to?:      string;
  ema_alpha?:    number;
}): Promise<unknown> {
  const alpha = params.ema_alpha ?? 0.3;

  const empty = {
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
    trends:                         null as unknown,
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

  // trends: EMA-based trend analysis (requires >= 4 runs)
  let trends: Record<string, unknown> | null = null;
  if (summaries.length >= 4) {
    const buildTrend = (values: number[]) => {
      if (values.length < 4) return null;
      const { ema, derivative } = computeEMA(values, alpha);
      return {
        current_ema: Math.round(ema[ema.length - 1] * 1000) / 1000,
        derivative: Math.round(derivative[derivative.length - 1] * 1000) / 1000,
        direction: emaDirection(derivative),
        raw_ema: ema.map(v => Math.round(v * 1000) / 1000),
      };
    };

    // Non-nullable metrics
    const fprValues = summaries.map(s => s.first_pass_rate);
    const durValues = summaries.map(s => s.total_duration_ms);

    // Nullable metrics — only include runs where value is not null
    const pipelineValues = summaries.filter(s => s.pipeline_score !== null).map(s => s.pipeline_score!);
    const confValues = summaries.filter(s => s.avg_confidence !== null).map(s => s.avg_confidence!);

    trends = {
      pipeline_score:    buildTrend(pipelineValues),
      first_pass_rate:   buildTrend(fprValues),
      total_duration_ms: buildTrend(durValues),
      avg_confidence:    buildTrend(confValues),
    };
  }

  return {
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
}

// ─── sdd_check_thresholds ─────────────────────────────────────────

interface ThresholdAlert {
  level: "warning" | "critical";
  metric: string;
  phase?: string;
  current_value: number;
  threshold: number;
  message: string;
}

const DEFAULT_THRESHOLDS = {
  max_fix_loops_per_phase: 3,
  max_duration_ratio: 2.0,
  min_first_pass_rate: 50,
  max_total_duration_minutes: 60,
  min_avg_confidence_warning: 0.5,
  min_avg_confidence_critical: 0.3,
};

export async function handleCheckThresholds(params: {
  project_path: string;
  feature_id:   string;
  thresholds?:  Partial<typeof DEFAULT_THRESHOLDS>;
}): Promise<unknown> {
  const t = { ...DEFAULT_THRESHOLDS, ...params.thresholds };
  const alerts: ThresholdAlert[] = [];

  const metricsPath = resolve(params.project_path, ".sdd", "runs", params.feature_id, "metrics.jsonl");
  if (!await fileExists(metricsPath)) {
    return { error: `No metrics found for feature "${params.feature_id}"` };
  }

  const raw = await readFile(metricsPath, "utf-8");
  const metrics = parseJsonl<PhaseMetrics>(raw);

  if (metrics.length === 0) {
    return { alerts: [], checked_at: new Date().toISOString() };
  }

  // Load historical averages (only if >= 3 runs exist)
  const historyPath = resolve(params.project_path, ".sdd", "analytics", "history.jsonl");
  let historicalDurByPhase: Record<string, number> | null = null;
  if (await fileExists(historyPath)) {
    const histRaw = await readFile(historyPath, "utf-8");
    const summaries = parseJsonl<RunSummary>(histRaw);
    if (summaries.length >= 3) {
      historicalDurByPhase = {};
      const durByPhase: Record<string, number[]> = {};
      for (const s of summaries) {
        for (const m of s.phase_metrics) {
          (durByPhase[m.phase] ??= []).push(m.duration_ms);
        }
      }
      for (const [phase, ds] of Object.entries(durByPhase)) {
        historicalDurByPhase[phase] = ds.reduce((a, b) => a + b, 0) / ds.length;
      }
    }
  }

  // Per-phase checks
  for (const m of metrics) {
    // Fix loops threshold — relative to phase max_attempts from contracts.json
    const phaseCap = FIX_LOOP_CAPS[m.phase];
    if (phaseCap !== undefined && m.fix_loop_count > 0) {
      const warningThreshold = Math.max(1, Math.ceil(phaseCap * 0.67));
      const criticalThreshold = phaseCap;
      if (m.fix_loop_count >= criticalThreshold) {
        alerts.push({
          level: "critical",
          metric: "fix_loop_count",
          phase: m.phase,
          current_value: m.fix_loop_count,
          threshold: criticalThreshold,
          message: `Phase "${m.phase}" exhausted all fix loop attempts: ${m.fix_loop_count}/${phaseCap}`,
        });
      } else if (m.fix_loop_count >= warningThreshold) {
        alerts.push({
          level: "warning",
          metric: "fix_loop_count",
          phase: m.phase,
          current_value: m.fix_loop_count,
          threshold: warningThreshold,
          message: `Phase "${m.phase}" used ${m.fix_loop_count}/${phaseCap} fix loop attempts`,
        });
      }
    } else if (phaseCap === undefined && m.fix_loop_count > t.max_fix_loops_per_phase) {
      // Fallback for phases not in contracts.json (use flat threshold)
      const level = m.fix_loop_count > t.max_fix_loops_per_phase * 2 ? "critical" : "warning";
      alerts.push({
        level,
        metric: "fix_loop_count",
        phase: m.phase,
        current_value: m.fix_loop_count,
        threshold: t.max_fix_loops_per_phase,
        message: `Phase "${m.phase}" has ${m.fix_loop_count} fix loops (threshold: ${t.max_fix_loops_per_phase})`,
      });
    }

    // Duration ratio vs historical
    if (historicalDurByPhase && historicalDurByPhase[m.phase]) {
      const avgDur = historicalDurByPhase[m.phase];
      const ratio = m.duration_ms / avgDur;
      if (ratio > t.max_duration_ratio) {
        const level = ratio > t.max_duration_ratio * 2 ? "critical" : "warning";
        alerts.push({
          level,
          metric: "duration_ratio",
          phase: m.phase,
          current_value: Math.round(ratio * 100) / 100,
          threshold: t.max_duration_ratio,
          message: `Phase "${m.phase}" duration is ${ratio.toFixed(1)}x the historical average (threshold: ${t.max_duration_ratio}x)`,
        });
      }
    }
  }

  // Run-level checks
  const passed = metrics.filter(m => m.gate_result === "pass");
  const firstPassRate = passed.length > 0
    ? Math.round(passed.filter(m => m.gate_attempts === 1).length / passed.length * 100)
    : 0;
  if (firstPassRate < t.min_first_pass_rate) {
    const level = firstPassRate < t.min_first_pass_rate / 2 ? "critical" : "warning";
    alerts.push({
      level,
      metric: "first_pass_rate",
      current_value: firstPassRate,
      threshold: t.min_first_pass_rate,
      message: `First-pass rate is ${firstPassRate}% (threshold: ${t.min_first_pass_rate}%)`,
    });
  }

  const totalDurationMin = metrics.reduce((s, m) => s + m.duration_ms, 0) / 60_000;
  if (totalDurationMin > t.max_total_duration_minutes) {
    const level = totalDurationMin > t.max_total_duration_minutes * 2 ? "critical" : "warning";
    alerts.push({
      level,
      metric: "total_duration_minutes",
      current_value: Math.round(totalDurationMin * 10) / 10,
      threshold: t.max_total_duration_minutes,
      message: `Total duration is ${totalDurationMin.toFixed(1)} min (threshold: ${t.max_total_duration_minutes} min)`,
    });
  }

  // Avg confidence check (from phase_confidence.json)
  const confPath = resolve(params.project_path, ".sdd", "runs", params.feature_id, "phase_confidence.json");
  if (await fileExists(confPath)) {
    try {
      const confEntries: Array<{ feature_id: string; confidence: number }> =
        JSON.parse(await readFile(confPath, "utf-8"));
      const featureConfs = confEntries
        .filter(e => e.feature_id === params.feature_id)
        .map(e => e.confidence);
      if (featureConfs.length > 0) {
        const avgConf = featureConfs.reduce((s, c) => s + c, 0) / featureConfs.length;
        if (avgConf < t.min_avg_confidence_critical) {
          alerts.push({
            level: "critical",
            metric: "avg_confidence",
            current_value: Math.round(avgConf * 1000) / 1000,
            threshold: t.min_avg_confidence_critical,
            message: `Average confidence is ${avgConf.toFixed(3)} (critical threshold: ${t.min_avg_confidence_critical})`,
          });
        } else if (avgConf < t.min_avg_confidence_warning) {
          alerts.push({
            level: "warning",
            metric: "avg_confidence",
            current_value: Math.round(avgConf * 1000) / 1000,
            threshold: t.min_avg_confidence_warning,
            message: `Average confidence is ${avgConf.toFixed(3)} (warning threshold: ${t.min_avg_confidence_warning})`,
          });
        }
      }
    } catch { /* malformed file — skip confidence check */ }
  }

  return { alerts, checked_at: new Date().toISOString() };
}

// ─── sdd_estimate_cost ────────────────────────────────────────────

const DEFAULT_PRICING: Record<string, { input: number; output: number }> = {
  opus:   { input: 15.0, output: 75.0 },
  sonnet: { input: 3.0, output: 15.0 },
  haiku:  { input: 0.25, output: 1.25 },
};

export async function handleEstimateCost(params: {
  project_path: string;
  feature_id?:  string;
  pricing?:     Record<string, { input: number; output: number }>;
}): Promise<unknown> {
  const pricing = { ...DEFAULT_PRICING, ...params.pricing };

  // Find metrics to analyze
  let metrics: PhaseMetrics[];

  if (params.feature_id) {
    const metricsPath = resolve(params.project_path, ".sdd", "runs", params.feature_id, "metrics.jsonl");
    if (!await fileExists(metricsPath)) {
      return { error: `No metrics found for feature "${params.feature_id}"` };
    }
    metrics = parseJsonl<PhaseMetrics>(await readFile(metricsPath, "utf-8"));
  } else {
    // Find last run from history
    const historyPath = resolve(params.project_path, ".sdd", "analytics", "history.jsonl");
    if (!await fileExists(historyPath)) {
      return { error: "No analytics history found. Run sdd_get_run_summary first." };
    }
    const summaries = parseJsonl<RunSummary>(await readFile(historyPath, "utf-8"));
    if (summaries.length === 0) {
      return { error: "No runs in history" };
    }
    const last = summaries[summaries.length - 1];
    metrics = last.phase_metrics;
  }

  const phases: Array<{ phase: string; model: string; tokens_in: number | null; tokens_out: number | null; cost_usd: number }> = [];
  const modelBreakdown: Record<string, number> = {};
  let totalCost = 0;

  for (const m of metrics) {
    const model = m.model || "sonnet";
    const modelKey = model.includes("opus") ? "opus" : model.includes("haiku") ? "haiku" : "sonnet";
    const rates = pricing[modelKey] ?? pricing.sonnet;

    let cost = 0;
    if (m.tokens_in !== null && m.tokens_out !== null) {
      cost = (m.tokens_in / 1_000_000) * rates.input + (m.tokens_out / 1_000_000) * rates.output;
    }

    phases.push({
      phase: m.phase,
      model: modelKey,
      tokens_in: m.tokens_in,
      tokens_out: m.tokens_out,
      cost_usd: Math.round(cost * 10000) / 10000,
    });

    modelBreakdown[modelKey] = (modelBreakdown[modelKey] ?? 0) + cost;
    totalCost += cost;
  }

  // Round model breakdown
  for (const k of Object.keys(modelBreakdown)) {
    modelBreakdown[k] = Math.round(modelBreakdown[k] * 10000) / 10000;
  }

  return {
    total_cost_usd: Math.round(totalCost * 10000) / 10000,
    phases,
    model_breakdown: modelBreakdown,
  };
}

// ─── sdd_get_live_status ──────────────────────────────────────────

export async function handleGetLiveStatus(params: {
  project_path: string;
  feature_id:   string;
}): Promise<unknown> {
  // Check feature state
  const sm = new StateManager(params.project_path);
  const feature = await sm.getFeature(params.feature_id);
  if (!feature) {
    return { error: `Feature "${params.feature_id}" not found` };
  }

  // Read metrics to find in-progress phase
  const metricsPath = resolve(params.project_path, ".sdd", "runs", params.feature_id, "metrics.jsonl");
  if (!await fileExists(metricsPath)) {
    return { status: "idle", feature_state: feature.state, last_completed_phase: null, last_completed_at: null };
  }

  const metrics = parseJsonl<PhaseMetrics>(await readFile(metricsPath, "utf-8"));
  if (metrics.length === 0) {
    return { status: "idle", feature_state: feature.state, last_completed_phase: null, last_completed_at: null };
  }

  // Phases with completed_at are done. Find one that started but has no matching completion.
  // Since metrics are append-only with one entry per phase completion, we check run.log for in-progress
  const runLogPath = resolve(params.project_path, ".sdd", "runs", params.feature_id, "run.log");
  let currentPhase: string | null = null;
  let startedAt: string | null = null;

  if (await fileExists(runLogPath)) {
    const logRaw = await readFile(runLogPath, "utf-8");
    const events = logRaw.trim().split("\n").filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);

    // Find last phase_start without a matching phase_end
    const starts = new Map<string, string>();
    const ends = new Set<string>();
    for (const evt of events) {
      if (evt.event_type === "phase_start" && evt.phase) {
        starts.set(evt.phase, evt.timestamp);
      }
      if (evt.event_type === "phase_end" && evt.phase) {
        ends.add(evt.phase);
      }
    }
    for (const [phase, ts] of starts) {
      if (!ends.has(phase)) {
        currentPhase = phase;
        startedAt = ts;
      }
    }
  }

  // Last completed phase from metrics (sorted by completed_at)
  const sorted = [...metrics].sort((a, b) => a.completed_at.localeCompare(b.completed_at));
  const last = sorted[sorted.length - 1];

  if (currentPhase) {
    const elapsedMs = startedAt ? Date.now() - new Date(startedAt).getTime() : null;
    return {
      status: "running",
      feature_state: feature.state,
      current_phase: currentPhase,
      started_at: startedAt,
      elapsed_seconds: elapsedMs !== null ? Math.round(elapsedMs / 1000) : null,
      last_completed_phase: last.phase,
      last_completed_at: last.completed_at,
    };
  }

  return {
    status: "idle",
    feature_state: feature.state,
    current_phase: null,
    last_completed_phase: last.phase,
    last_completed_at: last.completed_at,
  };
}

// ─── sdd_compare_runs ─────────────────────────────────────────────

export async function handleCompareRuns(params: {
  project_path: string;
  run_id_a:     string;
  run_id_b:     string;
}): Promise<unknown> {
  const historyPath = resolve(params.project_path, ".sdd", "analytics", "history.jsonl");
  if (!await fileExists(historyPath)) {
    return { error: "No analytics history found" };
  }

  const summaries = parseJsonl<RunSummary>(await readFile(historyPath, "utf-8"));

  const findRun = (id: string) =>
    summaries.find(s => s.run_id === id) ?? summaries.find(s => s.feature_id === id);

  const runA = findRun(params.run_id_a);
  const runB = findRun(params.run_id_b);

  if (!runA) return { error: `Run "${params.run_id_a}" not found in history` };
  if (!runB) return { error: `Run "${params.run_id_b}" not found in history` };

  // Compute diffs for global metrics
  const diffMetric = (name: string, a: number | null, b: number | null) => {
    if (a === null || b === null) return { a, b, diff: null, diff_pct: null };
    const diff = b - a;
    const diffPct = a !== 0 ? Math.round((diff / a) * 1000) / 10 : null;
    return { a, b, diff, diff_pct: diffPct };
  };

  const diffs: Record<string, { a: number | null; b: number | null; diff: number | null; diff_pct: number | null }> = {
    total_duration_ms: diffMetric("total_duration_ms", runA.total_duration_ms, runB.total_duration_ms),
    total_fix_loops:   diffMetric("total_fix_loops",   runA.total_fix_loops,   runB.total_fix_loops),
    first_pass_rate:   diffMetric("first_pass_rate",   runA.first_pass_rate,   runB.first_pass_rate),
    pipeline_score:    diffMetric("pipeline_score",    runA.pipeline_score,    runB.pipeline_score),
    total_tokens:      diffMetric("total_tokens",      runA.total_tokens,      runB.total_tokens),
  };

  // Per-phase diffs
  const phaseDiffs: Array<{ phase: string; metric: string; a: number; b: number; diff: number }> = [];
  const phasesA = new Map(runA.phase_metrics.map(m => [m.phase, m]));
  const phasesB = new Map(runB.phase_metrics.map(m => [m.phase, m]));
  const allPhases = new Set([...phasesA.keys(), ...phasesB.keys()]);

  for (const phase of allPhases) {
    const a = phasesA.get(phase);
    const b = phasesB.get(phase);
    if (a && b) {
      if (a.duration_ms !== b.duration_ms) {
        phaseDiffs.push({ phase, metric: "duration_ms", a: a.duration_ms, b: b.duration_ms, diff: b.duration_ms - a.duration_ms });
      }
      if (a.fix_loop_count !== b.fix_loop_count) {
        phaseDiffs.push({ phase, metric: "fix_loop_count", a: a.fix_loop_count, b: b.fix_loop_count, diff: b.fix_loop_count - a.fix_loop_count });
      }
    }
  }

  // Determine better run
  const scoreA = runA.pipeline_score ?? 0;
  const scoreB = runB.pipeline_score ?? 0;
  const betterRun = scoreA > scoreB ? runA.run_id : scoreB > scoreA ? runB.run_id : "tied";

  return {
    run_a: { id: runA.run_id, feature_id: runA.feature_id, outcome: runA.outcome, pipeline_score: runA.pipeline_score },
    run_b: { id: runB.run_id, feature_id: runB.feature_id, outcome: runB.outcome, pipeline_score: runB.pipeline_score },
    diffs,
    phase_diffs: phaseDiffs,
    better_run: betterRun,
  };
}

// ─── sdd_detect_anomaly ───────────────────────────────────────────

export async function handleDetectAnomaly(params: {
  project_path: string;
  feature_id:   string;
  sensitivity?: number;
}): Promise<unknown> {
  const sensitivity = params.sensitivity ?? 2.0;

  const historyPath = resolve(params.project_path, ".sdd", "analytics", "history.jsonl");
  if (!await fileExists(historyPath)) {
    return { is_anomaly: false, status: "insufficient_data", message: "No analytics history found" };
  }

  const allSummaries = parseJsonl<RunSummary>(await readFile(historyPath, "utf-8"));
  // Exclude the current feature from the historical baseline
  const historical = allSummaries.filter(s => s.feature_id !== params.feature_id);

  if (historical.length < 5) {
    return { is_anomaly: false, status: "insufficient_data", message: `Need >= 5 historical runs, have ${historical.length}` };
  }

  // Load current run summary
  const summaryPath = resolve(params.project_path, ".sdd", "runs", params.feature_id, "summary.json");
  if (!await fileExists(summaryPath)) {
    return { error: `No summary.json found for feature "${params.feature_id}"` };
  }
  const current: RunSummary = JSON.parse(await readFile(summaryPath, "utf-8"));

  // Compute stats for each metric
  const computeStats = (values: number[]) => {
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const stddev = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
    return { mean, stddev };
  };

  const metricsToCheck: Array<{ name: string; currentVal: number; historicalVals: number[] }> = [
    { name: "total_duration_ms", currentVal: current.total_duration_ms, historicalVals: historical.map(s => s.total_duration_ms) },
    { name: "first_pass_rate",   currentVal: current.first_pass_rate,   historicalVals: historical.map(s => s.first_pass_rate) },
  ];
  const excludedMetrics = [
    { metric: "total_fix_loops", reason: "Capped at 5 by pipeline fix loop limits (verify: 3, review: 2). Z-score not meaningful on bounded discrete range." },
  ];
  if (current.pipeline_score !== null) {
    const historicalScores = historical.filter(s => s.pipeline_score !== null).map(s => s.pipeline_score!);
    if (historicalScores.length >= 5) {
      metricsToCheck.push({ name: "pipeline_score", currentVal: current.pipeline_score, historicalVals: historicalScores });
    }
  }
  if (current.avg_confidence !== null) {
    const historicalConf = historical.filter(s => s.avg_confidence != null).map(s => s.avg_confidence!);
    if (historicalConf.length >= 3) {
      metricsToCheck.push({ name: "avg_confidence", currentVal: current.avg_confidence, historicalVals: historicalConf });
    }
  }

  const anomalies: Array<{ metric: string; value: number; mean: number; stddev: number; z_score: number }> = [];

  for (const { name, currentVal, historicalVals } of metricsToCheck) {
    const { mean, stddev } = computeStats(historicalVals);
    if (stddev === 0) continue; // All same value — can't compute z-score
    const zScore = Math.round(Math.abs(currentVal - mean) / stddev * 100) / 100;
    if (zScore > sensitivity) {
      anomalies.push({
        metric: name,
        value: currentVal,
        mean: Math.round(mean * 100) / 100,
        stddev: Math.round(stddev * 100) / 100,
        z_score: zScore,
      });
    }
  }

  // Percentile: what fraction of historical runs had a worse pipeline_score
  let runPercentile: number | null = null;
  if (current.pipeline_score !== null) {
    const scores = historical.filter(s => s.pipeline_score !== null).map(s => s.pipeline_score!);
    if (scores.length > 0) {
      const belowCount = scores.filter(s => s < current.pipeline_score!).length;
      runPercentile = Math.round(belowCount / scores.length * 100);
    }
  }

  return {
    is_anomaly: anomalies.length > 0,
    status: "analyzed",
    sensitivity,
    anomalies,
    excluded_metrics: excludedMetrics,
    run_percentile: runPercentile,
  };
}

// ─── sdd_validate_metrics ─────────────────────────────────────────

const REQUIRED_FIELDS: Record<string, string> = {
  run_id:            "string",
  feature_id:        "string",
  phase:             "string",
  agent:             "string",
  model:             "string",
  started_at:        "string",
  completed_at:      "string",
  duration_ms:       "number",
  gate_result:       "string",
  gate_attempts:     "number",
  findings_count:    "number",
  fix_loop_count:    "number",
};

const OPTIONAL_FIELDS: Record<string, string> = {
  tokens_in:         "number",
  tokens_out:        "number",
  tool_calls_count:  "number",
  delta_direction:   "string",
  feature_type:      "string",
  complexity:        "string",
};

const GATE_RESULT_VALUES = new Set(["pass", "fail", "skip"]);

export async function handleValidateMetrics(params: {
  project_path: string;
  metrics: Record<string, unknown>;
}): Promise<unknown> {
  const m = params.metrics;
  const errors: Array<{ field: string; message: string }> = [];
  const warnings: Array<{ field: string; message: string }> = [];

  // Check required fields
  for (const [field, expectedType] of Object.entries(REQUIRED_FIELDS)) {
    if (!(field in m)) {
      errors.push({ field, message: `Required field "${field}" is missing` });
      continue;
    }
    const val = m[field];
    if (val === null || val === undefined) {
      errors.push({ field, message: `Required field "${field}" is null/undefined` });
    } else if (typeof val !== expectedType) {
      errors.push({ field, message: `Expected ${expectedType}, got ${typeof val}` });
    }
  }

  // Check optional fields types (only if present and not null)
  for (const [field, expectedType] of Object.entries(OPTIONAL_FIELDS)) {
    if (field in m && m[field] !== null && m[field] !== undefined) {
      if (typeof m[field] !== expectedType) {
        errors.push({ field, message: `Expected ${expectedType} or null, got ${typeof m[field]}` });
      }
    }
  }

  // Validate gate_result enum
  if (typeof m.gate_result === "string" && !GATE_RESULT_VALUES.has(m.gate_result)) {
    errors.push({ field: "gate_result", message: `Invalid value "${m.gate_result}". Expected: pass, fail, skip` });
  }

  // Validate ISO timestamps
  for (const tsField of ["started_at", "completed_at"]) {
    if (typeof m[tsField] === "string") {
      const d = new Date(m[tsField] as string);
      if (isNaN(d.getTime())) {
        errors.push({ field: tsField, message: `Invalid ISO8601 timestamp: "${m[tsField]}"` });
      }
    }
  }

  // Validate non-negative numbers
  for (const numField of ["duration_ms", "gate_attempts", "findings_count", "fix_loop_count", "tokens_in", "tokens_out", "tool_calls_count"]) {
    if (numField in m && typeof m[numField] === "number" && (m[numField] as number) < 0) {
      errors.push({ field: numField, message: `Value must be non-negative, got ${m[numField]}` });
    }
  }

  // Check findings_severity is array of strings
  if ("findings_severity" in m) {
    if (!Array.isArray(m.findings_severity)) {
      errors.push({ field: "findings_severity", message: `Expected array, got ${typeof m.findings_severity}` });
    } else {
      for (const s of m.findings_severity as unknown[]) {
        if (typeof s !== "string") {
          errors.push({ field: "findings_severity", message: `Array element must be string, got ${typeof s}` });
          break;
        }
      }
    }
  }

  // Warn about unknown fields
  const knownFields = new Set([...Object.keys(REQUIRED_FIELDS), ...Object.keys(OPTIONAL_FIELDS), "findings_severity"]);
  for (const key of Object.keys(m)) {
    if (!knownFields.has(key)) {
      warnings.push({ field: key, message: `Unknown field "${key}" — will be persisted but not used` });
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ─── sdd_get_manifest ─────────────────────────────────────────────

export async function handleGetManifest(_params: {
  project_path?: string;
}): Promise<unknown> {
  const manifestPath = resolve(__dirname, "tools-manifest.json");
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
    return manifest;
  } catch {
    return { error: "tools-manifest.json not found. Run 'npm run build' first." };
  }
}

// ─── sdd_breadcrumb ───────────────────────────────────────────────

export async function handleBreadcrumb(params: {
  project_path: string;
  feature_id: string;
  phase: string;
  agent: string;
  decision: string;
  reasoning: string;
  alternatives_considered?: string[];
}): Promise<unknown> {
  const analyticsDir = resolve(params.project_path, ".sdd", "analytics");
  await mkdir(analyticsDir, { recursive: true });

  const breadcrumb = {
    feature_id: params.feature_id,
    phase: params.phase,
    agent: params.agent,
    decision: params.decision,
    reasoning: params.reasoning,
    alternatives_considered: params.alternatives_considered ?? [],
    timestamp: new Date().toISOString(),
  };

  const breadcrumbsPath = join(analyticsDir, "breadcrumbs.jsonl");
  await atomicAppendJSONL(breadcrumbsPath, breadcrumb);

  return { recorded: true, breadcrumb };
}
