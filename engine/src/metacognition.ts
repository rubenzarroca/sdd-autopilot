// SDD Autopilot — Metacognition Layer handlers
// Phase 2: sdd_compute_score
// Phases 3-5: sdd_get/propose/promote_pattern, sdd_propose/evaluate_experiment, sdd_propose_evolution
// All deterministic — no LLM calls.

import { readFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { RunSummary, ScoreWeights, CompositeScore, ExploitationPattern, Experiment, PipelineEvolution, PhaseMetrics } from "./types.js";
import { fileExists, parseJsonl, atomicWriteJSON } from "./utils.js";

// ─── Verbosity types ────────────────────────────────────────────
type Verbosity = "minimal" | "standard" | "full";
function resolveVerbosity(v?: string): Verbosity {
  if (v === "minimal" || v === "standard" || v === "full") return v;
  return "full";
}

// ─── Generic metacognition JSON helpers ──────────────────────────

async function readMetacognitionJson<T>(projectPath: string, filename: string): Promise<T[]> {
  const p = resolve(projectPath, ".sdd", "metacognition", filename);
  if (!await fileExists(p)) return [];
  try { return JSON.parse(await readFile(p, "utf-8")); } catch { return []; }
}

async function writeMetacognitionJson<T>(projectPath: string, filename: string, data: T[]): Promise<void> {
  const dir = resolve(projectPath, ".sdd", "metacognition");
  await mkdir(dir, { recursive: true });
  await atomicWriteJSON(resolve(dir, filename), data);
}

// ─── Default weights (tokens_available=false — see docs/observability-native-capabilities.md)

const DEFAULT_WEIGHTS: ScoreWeights = {
  quality_weight:            0.7,
  efficiency_weight:         0.3,
  review_result_weight:      0.40,
  first_pass_rate_weight:    0.25,
  findings_severity_weight:  0.20,
  verify_clean_weight:       0.15,
  fix_loops_weight:          0.50,
  phases_skipped_weight:     0.20,
  duration_trend_weight:     0.30,
  max_fix_loops_possible:    5,
  tokens_available:          false,
};

// ─── Score sub-components ─────────────────────────────────────────

function reviewResultScore(summary: RunSummary): number {
  if (summary.outcome === "escalated") return 0;
  if (summary.review_decision === "approve") return 100;
  if (summary.review_decision === "request_changes") {
    // Succeeded despite needing changes = partial quality signal
    return summary.outcome === "pr_created" ? 70 : 30;
  }
  return 50; // null or unknown — neutral
}

function findingsScore(summary: RunSummary): number {
  let criticals = 0, majors = 0, minors = 0;
  for (const m of summary.phase_metrics) {
    for (const sev of m.findings_severity) {
      if (sev === "critical") criticals++;
      else if (sev === "major") majors++;
      else if (sev === "minor") minors++;
    }
  }
  return Math.max(0, 100 - criticals * 30 - majors * 15 - minors * 5);
}

function verifyCleanScore(summary: RunSummary): number {
  const v = summary.phase_metrics.find(m => m.phase === "verify");
  if (!v) return 20;                                          // no verify at all
  if (v.gate_result === "skip") return 80;                   // skipped (pattern-driven)
  if (v.gate_result === "pass" && v.fix_loop_count === 0) return 100;  // clean first pass
  if (v.gate_result === "pass" && v.fix_loop_count > 0) return 60;    // pass after fix
  return 20;                                                 // fail
}

function fixLoopsScore(totalFixLoops: number, maxLoops: number): number {
  return Math.round(100 * (1 - Math.min(totalFixLoops, maxLoops) / maxLoops));
}

function phasesSkippedScore(summary: RunSummary): number {
  const skips = summary.phases_skipped.length;
  if (skips > 0 && summary.outcome !== "pr_created") {
    return 0;  // skipped phases + failure = bad signal
  }
  // 0 skips → 70 baseline (full pipeline, all good)
  // +15 per skip that still led to success (accurate optimization)
  return Math.min(100, 70 + skips * 15);
}

function durationTrendScore(summary: RunSummary, history: RunSummary[]): number {
  const prev = history.filter(
    s => s.feature_type === summary.feature_type && s.run_id !== summary.run_id
  );
  if (prev.length === 0) return 70;  // no history = neutral
  const mean = prev.reduce((s, r) => s + r.total_duration_ms, 0) / prev.length;
  const ratio = summary.total_duration_ms / mean;
  if (ratio < 0.9)  return 100;   // >10% faster than mean
  if (ratio <= 1.1) return 70;    // within ±10% of mean
  if (ratio <= 1.3) return 50;    // 10–30% slower
  return 20;                       // >30% slower
}

// ─── Golden baseline: complexity-weighted moving average ─────────

const COMPLEXITY_MULTIPLIERS: Record<string, number> = {
  trivial:  0.6,
  low:      0.8,
  medium:   1.0,
  high:     1.2,
  critical: 1.4,
};

const DEFAULT_GOLDEN_WINDOW = 5;
const MIN_RUNS_FOR_BASELINE = 3;

export interface GoldenComparison {
  status:           "insufficient_data" | "meets_golden" | "below_threshold";
  message?:         string;
  golden_score?:    number;   // complexity-weighted moving average
  current_score?:   number;   // raw pipeline_score of this run
  weighted_score?:  number;   // current score × complexity multiplier (for fair comparison)
  delta?:           number;   // weighted_score - golden_score
  trend?:           "improving" | "degrading" | "stable";
  window_size?:     number;   // configured N
  runs_in_window?:  number;   // actual runs used (<= window_size)
}

/**
 * Compute the golden baseline from history.jsonl as a complexity-weighted
 * moving average of the last N completed runs.
 *
 * Each run's score is multiplied by its complexity weight before averaging:
 *   weighted_avg = Σ(score_i × weight_i) / Σ(weight_i)
 *
 * Trend is determined by comparing the first half vs second half of the window.
 */
export function computeGoldenBaseline(
  history: RunSummary[],
  currentScore: number,
  currentComplexity: string,
  windowSize: number = DEFAULT_GOLDEN_WINDOW,
): GoldenComparison {
  // Only consider runs with a pipeline_score
  const scored = history.filter(s => typeof s.pipeline_score === "number");

  if (scored.length < MIN_RUNS_FOR_BASELINE) {
    return {
      status: "insufficient_data",
      message: `Not enough data for baseline (${scored.length}/${MIN_RUNS_FOR_BASELINE} runs). Showing absolute score only.`,
      current_score: currentScore,
      runs_in_window: scored.length,
      window_size: windowSize,
    };
  }

  // Take the last N runs for the window
  const window = scored.slice(-windowSize);

  // Compute complexity-weighted moving average
  let sumWeightedScores = 0;
  let sumWeights = 0;
  for (const run of window) {
    const mult = COMPLEXITY_MULTIPLIERS[run.complexity] ?? 1.0;
    sumWeightedScores += (run.pipeline_score as number) * mult;
    sumWeights += mult;
  }
  const goldenScore = Math.round((sumWeightedScores / sumWeights) * 10) / 10;

  // Compute the current run's weighted score for fair comparison
  const currentMult = COMPLEXITY_MULTIPLIERS[currentComplexity] ?? 1.0;
  const weightedCurrentScore = Math.round(currentScore * currentMult * 10) / 10;

  const delta = Math.round((weightedCurrentScore - goldenScore) * 10) / 10;

  // Trend: compare first half vs second half of the window
  const trend = computeTrend(window);

  const belowThreshold = weightedCurrentScore < goldenScore * 0.9;

  return {
    status: belowThreshold ? "below_threshold" : "meets_golden",
    golden_score: goldenScore,
    current_score: currentScore,
    weighted_score: weightedCurrentScore,
    delta,
    trend,
    window_size: windowSize,
    runs_in_window: window.length,
  };
}

function computeTrend(window: RunSummary[]): "improving" | "degrading" | "stable" {
  if (window.length < 2) return "stable";

  const mid = Math.floor(window.length / 2);
  const firstHalf = window.slice(0, mid);
  const secondHalf = window.slice(mid);

  const avg = (runs: RunSummary[]) => {
    let sum = 0, w = 0;
    for (const r of runs) {
      const mult = COMPLEXITY_MULTIPLIERS[r.complexity] ?? 1.0;
      sum += (r.pipeline_score as number) * mult;
      w += mult;
    }
    return w > 0 ? sum / w : 0;
  };

  const firstAvg = avg(firstHalf);
  const secondAvg = avg(secondHalf);
  const pctChange = firstAvg > 0 ? ((secondAvg - firstAvg) / firstAvg) * 100 : 0;

  if (pctChange > 5) return "improving";
  if (pctChange < -5) return "degrading";
  return "stable";
}

// ─── sdd_compute_score ───────────────────────────────────────────

const VALID_REVIEW_DECISIONS = ["approve", "request_changes", "reject"] as const;

export async function handleComputeScore(params: {
  project_path: string;
  feature_id:   string;
  run_id?:      string;
  review_decision?: "approve" | "request_changes" | "reject" | null;
  verbosity?: string;
}): Promise<unknown> {
  // Validate review_decision if explicitly provided
  if (params.review_decision !== undefined && params.review_decision !== null) {
    if (!(VALID_REVIEW_DECISIONS as readonly string[]).includes(params.review_decision)) {
      return { error: `Invalid review_decision "${params.review_decision}". Must be one of: ${VALID_REVIEW_DECISIONS.join(", ")}, or null.` };
    }
  }
  const summaryPath = resolve(
    params.project_path, ".sdd", "runs", params.feature_id, "summary.json"
  );
  if (!await fileExists(summaryPath)) {
    return { error: `No summary.json found for feature "${params.feature_id}". Call sdd_get_run_summary first.` };
  }

  const summary: RunSummary = JSON.parse(await readFile(summaryPath, "utf-8"));

  if (params.run_id && summary.run_id !== params.run_id) {
    return {
      error: `summary.json run_id "${summary.run_id}" does not match requested run_id "${params.run_id}"`,
    };
  }

  // Load weights + history in parallel (both independent of each other)
  const weightsPath = resolve(params.project_path, ".sdd", "metacognition", "score_weights.json");
  const historyPath = resolve(params.project_path, ".sdd", "analytics", "history.jsonl");

  const [weightsRaw, historyRaw] = await Promise.all([
    fileExists(weightsPath).then(ok => ok ? readFile(weightsPath, "utf-8") : null),
    fileExists(historyPath).then(ok => ok ? readFile(historyPath, "utf-8") : null),
  ]);

  let weights: ScoreWeights = { ...DEFAULT_WEIGHTS };
  if (weightsRaw !== null) {
    try { weights = { ...DEFAULT_WEIGHTS, ...JSON.parse(weightsRaw) }; } catch { /* malformed — use defaults */ }
  }

  const history: RunSummary[] = historyRaw !== null ? parseJsonl<RunSummary>(historyRaw) : [];

  // Sub-scores
  const review_result_score    = reviewResultScore(summary);
  const first_pass_rate_score  = summary.first_pass_rate;
  const findings_score_val     = findingsScore(summary);
  const verify_clean_score_val = verifyCleanScore(summary);
  const fix_loops_score_val    = fixLoopsScore(summary.total_fix_loops, weights.max_fix_loops_possible);
  const phases_skipped_score_val = phasesSkippedScore(summary);
  const duration_trend_score_val = durationTrendScore(summary, history);

  // Aggregate — round individual dimensions to integers, then compute composite
  const quality_score = Math.min(100, Math.round(
    weights.review_result_weight     * review_result_score    +
    weights.first_pass_rate_weight   * first_pass_rate_score  +
    weights.findings_severity_weight * findings_score_val     +
    weights.verify_clean_weight      * verify_clean_score_val
  ));

  const efficiency_score = Math.min(100, Math.round(
    weights.fix_loops_weight       * fix_loops_score_val      +
    weights.phases_skipped_weight  * phases_skipped_score_val +
    weights.duration_trend_weight  * duration_trend_score_val
  ));

  // pipeline_score: 1 decimal, 0–100
  const pipeline_score = Math.round(
    (weights.quality_weight * quality_score + weights.efficiency_weight * efficiency_score) * 10
  ) / 10;

  const result: CompositeScore = {
    run_id:           summary.run_id,
    feature_id:       params.feature_id,
    pipeline_score,
    quality_score,
    efficiency_score,
    breakdown: {
      review_result_score,
      first_pass_rate_score,
      findings_score:         findings_score_val,
      verify_clean_score:     verify_clean_score_val,
      fix_loops_score:        fix_loops_score_val,
      phases_skipped_score:   phases_skipped_score_val,
      duration_trend_score:   duration_trend_score_val,
    },
    weights_used: weights,
  };

  // Golden comparison — dynamic complexity-weighted moving average from history
  const goldenWindowSize = (weights as unknown as Record<string, unknown>).golden_window_size as number | undefined ?? DEFAULT_GOLDEN_WINDOW;
  const golden_comparison: GoldenComparison = computeGoldenBaseline(
    history,
    pipeline_score,
    summary.complexity ?? "medium",
    goldenWindowSize,
  );

  // Persist pipeline_score (and optionally review_decision) back into summary.json
  summary.pipeline_score = pipeline_score;
  if (params.review_decision !== undefined) {
    summary.review_decision = params.review_decision;
  }
  await atomicWriteJSON(summaryPath, summary);

  // Ensure metacognition dir exists (score_weights.json lives here when Phase 5 writes it)
  const metacognitionDir = resolve(params.project_path, ".sdd", "metacognition");
  await mkdir(metacognitionDir, { recursive: true });

  const vScore = resolveVerbosity(params.verbosity);

  if (vScore === "minimal") {
    return {
      pipeline_score,
      quality_score,
      efficiency_score,
      golden_status: golden_comparison.status,
    };
  }
  if (vScore === "standard") {
    return {
      run_id: result.run_id,
      feature_id: result.feature_id,
      pipeline_score,
      quality_score,
      efficiency_score,
      breakdown: result.breakdown,
      weights_used: result.weights_used,
      golden_comparison: {
        status: golden_comparison.status,
        golden_score: golden_comparison.golden_score,
        delta: golden_comparison.delta,
        trend: golden_comparison.trend,
      },
    };
  }

  return { ...result, golden_comparison };
}

// ─── Exploitation Patterns helpers ───────────────────────────────

const readPatternsRaw  = (p: string) => readMetacognitionJson<ExploitationPattern>(p, "patterns.json");
const writePatterns = (p: string, data: ExploitationPattern[]) => writeMetacognitionJson(p, "patterns.json", data);

// ─── Thompson Sampling (Normal approximation to Beta distribution) ──

function thompsonSample(alpha: number, betaParam: number): number {
  const mean = alpha / (alpha + betaParam);
  const variance = (alpha * betaParam) /
    ((alpha + betaParam) ** 2 * (alpha + betaParam + 1));
  // Box-Muller transform: generate Z ~ N(0,1)
  const u1 = Math.max(1e-10, Math.random()); // avoid log(0)
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const sample = mean + Math.sqrt(variance) * z;
  return Math.max(0, Math.min(1, sample)); // clamp to [0, 1]
}

/** Migrate legacy patterns that lack alpha/beta_param or adaptive decay fields */
function migratePatterns(patterns: ExploitationPattern[]): ExploitationPattern[] {
  return patterns.map(p => {
    let migrated = p;
    if (migrated.alpha === undefined || migrated.beta_param === undefined) {
      const alpha = (migrated.supporting_runs ?? 0) + 1;
      const beta_param = 1;
      migrated = { ...migrated, alpha, beta_param, confidence: alpha / (alpha + beta_param) };
    }
    if (migrated.last_confirmed_tick === undefined) {
      migrated = { ...migrated, last_confirmed_tick: 0 };
    }
    if (migrated.total_ticks_alive === undefined) {
      const estimated = (migrated.ttl !== undefined && migrated.min_runs)
        ? Math.max(0, 20 - migrated.ttl) : 0;
      migrated = { ...migrated, total_ticks_alive: estimated };
    }
    if (migrated.decay_rate === undefined) {
      migrated = { ...migrated, decay_rate: 0 };
    }
    return migrated;
  });
}

async function readPatterns(p: string): Promise<ExploitationPattern[]> {
  return migratePatterns(await readPatternsRaw(p));
}

// ─── sdd_get_patterns ────────────────────────────────────────────

export async function handleGetPatterns(params: {
  project_path:  string;
  status?:       "candidate" | "active" | "decayed" | "all";
  feature_type?: string;
  complexity?:   string;
  verbosity?:    string;
}): Promise<unknown> {
  const all = await readPatterns(params.project_path);
  const statusFilter = params.status ?? "active";

  let results = statusFilter === "all" ? all : all.filter(p => p.status === statusFilter);

  // Condition matching: filter patterns whose condition matches the provided context
  if (params.feature_type || params.complexity) {
    results = results.filter(p => {
      const cond = p.condition.toLowerCase();
      if (params.feature_type && cond.includes(`feature_type=${params.feature_type.toLowerCase()}`)) {
        if (params.complexity) {
          return cond.includes(`complexity=${params.complexity.toLowerCase()}`);
        }
        return true;
      }
      if (params.complexity && cond.includes(`complexity=${params.complexity.toLowerCase()}`)) {
        return true;
      }
      // If condition has no feature_type/complexity constraints, it matches everything
      if (!cond.includes("feature_type=") && !cond.includes("complexity=")) return true;
      return false;
    });
  }

  // Add computed posterior_variance to each pattern
  const enriched = results.map(p => {
    const pv = (p.alpha * p.beta_param) /
      ((p.alpha + p.beta_param) ** 2 * (p.alpha + p.beta_param + 1));
    return { ...p, posterior_variance: pv };
  });

  const vPatterns = resolveVerbosity(params.verbosity);

  if (vPatterns === "minimal") {
    return {
      count: enriched.length,
      patterns: enriched.map(p => ({
        pattern_id: p.pattern_id,
        type: p.type,
        confidence: p.confidence,
        status: p.status,
      })),
    };
  }
  if (vPatterns === "standard") {
    return {
      count: enriched.length,
      patterns: enriched.map(p => ({
        pattern_id: p.pattern_id,
        type: p.type,
        condition: p.condition,
        action: p.action,
        confidence: p.confidence,
        status: p.status,
        supporting_runs: p.supporting_runs,
        posterior_variance: p.posterior_variance,
      })),
    };
  }

  return { patterns: enriched, count: enriched.length };
}

// ─── sdd_propose_pattern ─────────────────────────────────────────

export async function handleProposePattern(params: {
  project_path:     string;
  pattern_id:       string;
  type:             ExploitationPattern["type"];
  condition:        string;
  action:           string;
  confidence:       number;
  supporting_runs:  number;
  min_runs?:        number;
  ttl?:             number;
}): Promise<unknown> {
  const all = await readPatterns(params.project_path);

  // Reject if pattern_id already exists
  if (all.some(p => p.pattern_id === params.pattern_id)) {
    return { error: `Pattern "${params.pattern_id}" already exists. Use a unique pattern_id.` };
  }

  const pattern: ExploitationPattern = {
    pattern_id:      params.pattern_id,
    type:            params.type,
    condition:       params.condition,
    action:          params.action,
    confidence:      0.5,           // Beta(1,1) posterior mean — ignore caller value
    alpha:           1,             // uniform prior
    beta_param:      1,             // uniform prior
    last_confirmed_tick: 0,
    total_ticks_alive:   0,
    decay_rate:          0,
    supporting_runs: params.supporting_runs,
    min_runs:        params.min_runs ?? 5,
    ttl:             params.ttl ?? 20,
    status:          "candidate",   // always starts as candidate
    created_at:      new Date().toISOString(),
  };

  all.push(pattern);
  await writePatterns(params.project_path, all);

  return { proposed: true, pattern_id: pattern.pattern_id, status: "candidate" };
}

// ─── sdd_promote_pattern ─────────────────────────────────────────

export async function handlePromotePattern(params: {
  project_path: string;
  pattern_id:   string;
}): Promise<unknown> {
  const all = await readPatterns(params.project_path);
  const idx = all.findIndex(p => p.pattern_id === params.pattern_id);

  if (idx === -1) {
    return { error: `Pattern "${params.pattern_id}" not found` };
  }

  const pattern = all[idx];

  if (pattern.status === "active") {
    return { promoted: false, reason: "Pattern is already active" };
  }
  if (pattern.status === "decayed") {
    return { promoted: false, reason: "Cannot promote a decayed pattern. Propose a new one." };
  }

  // Bayesian stats (computed for every response)
  const { alpha, beta_param } = pattern;
  const posterior_mean = alpha / (alpha + beta_param);
  const posterior_variance = (alpha * beta_param) /
    ((alpha + beta_param) ** 2 * (alpha + beta_param + 1));
  const bayesian_stats = { alpha, beta_param, posterior_mean, posterior_variance };

  // Promotion gate: supporting_runs >= min_runs AND confidence >= 0.7
  if (pattern.supporting_runs < pattern.min_runs) {
    return {
      promoted: false,
      reason: `Insufficient supporting_runs: ${pattern.supporting_runs} < min_runs (${pattern.min_runs})`,
      bayesian_stats,
    };
  }
  if (pattern.confidence < 0.7) {
    return {
      promoted: false,
      reason: `Insufficient confidence: ${pattern.confidence} < 0.7`,
      bayesian_stats,
    };
  }

  pattern.status = "active";
  pattern.promoted_at = new Date().toISOString();
  all[idx] = pattern;
  await writePatterns(params.project_path, all);

  return { promoted: true, pattern_id: pattern.pattern_id, status: "active", bayesian_stats };
}

// ─── Experiments helpers ──────────────────────────────────────────

const readExperiments  = (p: string) => readMetacognitionJson<Experiment>(p, "experiments.json");
const writeExperiments = (p: string, data: Experiment[]) => writeMetacognitionJson(p, "experiments.json", data);

// ─── sdd_propose_experiment ──────────────────────────────────────

export async function handleProposeExperiment(params: {
  project_path:    string;
  experiment_id:   string;
  hypothesis:      string;
  type:            Experiment["type"];
  mutation:        Record<string, unknown>;
  expected_impact: string;
  risk_level:      Experiment["risk_level"];
}): Promise<unknown> {
  const all = await readExperiments(params.project_path);

  // Only one experiment can be proposed or running at a time
  const active = all.find(e => e.status === "proposed" || e.status === "running");
  if (active) {
    return {
      error: `Experiment "${active.experiment_id}" is already ${active.status}. Complete or abandon it before proposing a new one.`,
    };
  }

  if (all.some(e => e.experiment_id === params.experiment_id)) {
    return { error: `Experiment "${params.experiment_id}" already exists.` };
  }

  const experiment: Experiment = {
    experiment_id:   params.experiment_id,
    hypothesis:      params.hypothesis,
    type:            params.type,
    mutation:        params.mutation,
    expected_impact: params.expected_impact,
    risk_level:      params.risk_level,
    status:          "proposed",
    result_score:    null,
    baseline_score:  null,
    verdict:         null,
    retry_count:     0,
    created_at:      new Date().toISOString(),
  };

  all.push(experiment);
  await writeExperiments(params.project_path, all);

  return { proposed: true, experiment_id: experiment.experiment_id, status: "proposed" };
}

// ─── sdd_evaluate_experiment ─────────────────────────────────────

export async function handleEvaluateExperiment(params: {
  project_path:   string;
  experiment_id:  string;
  result_score:   number;
  baseline_score: number;
}): Promise<unknown> {
  const all = await readExperiments(params.project_path);
  const idx = all.findIndex(e => e.experiment_id === params.experiment_id);

  if (idx === -1) {
    return { error: `Experiment "${params.experiment_id}" not found` };
  }

  const exp = all[idx];

  if (exp.status === "completed" || exp.status === "abandoned") {
    return { error: `Experiment "${params.experiment_id}" is already ${exp.status} and cannot be re-evaluated.` };
  }

  exp.result_score   = params.result_score;
  exp.baseline_score = params.baseline_score;
  exp.completed_at   = new Date().toISOString();

  // Verdict logic:
  // - result >= baseline → promote (experiment improved the pipeline)
  // - result < baseline × 0.9 → discard (clear regression)
  // - ambiguous (between 0.9× and baseline) → retry if retry_count < 2, else discard
  if (params.result_score >= params.baseline_score) {
    exp.verdict = "promote";
    exp.status  = "completed";
  } else if (params.result_score < params.baseline_score * 0.9) {
    exp.verdict = "discard";
    exp.status  = "completed";
  } else {
    // Ambiguous range
    if (exp.retry_count < 2) {
      exp.verdict     = "retry";
      exp.retry_count += 1;
      exp.status      = "proposed";  // reset to proposed for next run
      exp.completed_at = undefined;
    } else {
      exp.verdict = "discard";       // max retries exhausted
      exp.status  = "completed";
    }
  }

  all[idx] = exp;
  await writeExperiments(params.project_path, all);

  return {
    evaluated:      true,
    experiment_id:  exp.experiment_id,
    verdict:        exp.verdict,
    status:         exp.status,
    result_score:   exp.result_score,
    baseline_score: exp.baseline_score,
    retry_count:    exp.retry_count,
  };
}

// ─── Pipeline Evolution helpers ───────────────────────────────────

const readEvolutions  = (p: string) => readMetacognitionJson<PipelineEvolution>(p, "evolutions.json");
const writeEvolutions = (p: string, data: PipelineEvolution[]) => writeMetacognitionJson(p, "evolutions.json", data);

// ─── sdd_propose_evolution ───────────────────────────────────────

export async function handleProposeEvolution(params: {
  project_path:    string;
  evolution_id:    string;
  type:            PipelineEvolution["type"];
  description:     string;
  rationale:       string;
  supporting_data: Record<string, unknown>;
  impact:          PipelineEvolution["impact"];
}): Promise<unknown> {
  const all = await readEvolutions(params.project_path);

  if (all.some(e => e.evolution_id === params.evolution_id)) {
    return { error: `Evolution "${params.evolution_id}" already exists.` };
  }

  // Governance: structural changes always require human approval
  const structuralTypes: PipelineEvolution["type"][] = ["phase_add", "phase_remove", "agent_redesign"];
  const requires_human = structuralTypes.includes(params.type) || params.impact === "high";

  const evolution: PipelineEvolution = {
    evolution_id:    params.evolution_id,
    type:            params.type,
    description:     params.description,
    rationale:       params.rationale,
    supporting_data: params.supporting_data,
    impact:          params.impact,
    requires_human,
    status:          "proposed",
    proposed_at:     new Date().toISOString(),
  };

  all.push(evolution);
  await writeEvolutions(params.project_path, all);

  return {
    proposed:       true,
    evolution_id:   evolution.evolution_id,
    requires_human: evolution.requires_human,
    status:         "proposed",
  };
}

// ─── Pattern TTL decay (internal, used by sdd_tick_maintenance) ──
export async function handleTickPatterns(params: {
  project_path: string;
}): Promise<unknown> {
  const all = await readPatterns(params.project_path);
  let decayed = 0;
  const INITIAL_TTL = 20; // default from propose_pattern
  const details: Array<{
    pattern_id: string;
    decay_rate: number;
    remaining_ttl: number;
    ticks_since_confirmation: number;
    status: string;
  }> = [];

  const updated = all.map(p => {
    if (p.status !== "active" && p.status !== "candidate") return p;

    const totalTicksAlive = p.total_ticks_alive + 1;
    const ticksSinceConfirmation = totalTicksAlive - p.last_confirmed_tick;
    const decayRate = ticksSinceConfirmation / Math.max(totalTicksAlive, 1);
    const remainingTtl = INITIAL_TTL * Math.exp(-decayRate * ticksSinceConfirmation);

    if (remainingTtl < 1.0) {
      decayed++;
      details.push({
        pattern_id: p.pattern_id,
        decay_rate: Math.round(decayRate * 1000) / 1000,
        remaining_ttl: Math.round(remainingTtl * 1000) / 1000,
        ticks_since_confirmation: ticksSinceConfirmation,
        status: "decayed",
      });
      return {
        ...p,
        ttl: 0,
        total_ticks_alive: totalTicksAlive,
        decay_rate: decayRate,
        status: "decayed" as const,
        decayed_at: new Date().toISOString(),
      };
    }

    const newTtl = Math.round(remainingTtl);
    details.push({
      pattern_id: p.pattern_id,
      decay_rate: Math.round(decayRate * 1000) / 1000,
      remaining_ttl: Math.round(remainingTtl * 1000) / 1000,
      ticks_since_confirmation: ticksSinceConfirmation,
      status: p.status,
    });
    return {
      ...p,
      ttl: newTtl,
      total_ticks_alive: totalTicksAlive,
      decay_rate: decayRate,
    };
  });

  await writePatterns(params.project_path, updated);
  return { ticked: true, decayed, details };
}

// ─── sdd_approve_evolution (Phase 5) ────────────────────────────

export async function handleApproveEvolution(params: {
  project_path: string;
  evolution_id: string;
  decision:     "approve" | "reject";
  reason?:      string;
}): Promise<unknown> {
  const all = await readEvolutions(params.project_path);
  const idx = all.findIndex(e => e.evolution_id === params.evolution_id);

  if (idx === -1) {
    return { error: `Evolution "${params.evolution_id}" not found` };
  }

  const evo = all[idx];

  if (evo.status !== "proposed") {
    return { error: `Evolution "${params.evolution_id}" is in status "${evo.status}", expected "proposed"` };
  }

  const now = new Date().toISOString();

  if (params.decision === "reject") {
    evo.status = "rejected";
    (evo as any).rejected_at = now;
    if (params.reason) (evo as any).reject_reason = params.reason;
    all[idx] = evo;
    await writeEvolutions(params.project_path, all);
    return { evolution_id: evo.evolution_id, status: "rejected", reason: params.reason };
  }

  // Approve path
  // Structural changes always need manual application
  const manualTypes: PipelineEvolution["type"][] = ["phase_add", "phase_remove", "agent_redesign", "contract_change"];
  if (evo.requires_human || manualTypes.includes(evo.type)) {
    evo.status = "approved_pending";
    evo.approved_at = now;
    all[idx] = evo;
    await writeEvolutions(params.project_path, all);
    return {
      evolution_id: evo.evolution_id,
      status: "approved_pending",
      message: "Approved but requires manual application (structural change or requires_human=true)",
    };
  }

  // Auto-apply: weight_adjust
  if (evo.type === "weight_adjust" && evo.supporting_data) {
    const weightsPath = resolve(params.project_path, ".sdd", "metacognition", "score_weights.json");
    let currentWeights: Record<string, unknown> = {};
    if (await fileExists(weightsPath)) {
      try { currentWeights = JSON.parse(await readFile(weightsPath, "utf-8")); } catch { /* use empty */ }
    }

    // Merge supporting_data weight fields into current weights
    const newWeights = { ...currentWeights, ...evo.supporting_data, updated_at: now, updated_by: evo.evolution_id };
    const metacogDir = resolve(params.project_path, ".sdd", "metacognition");
    await mkdir(metacogDir, { recursive: true });
    await atomicWriteJSON(weightsPath, newWeights);

    evo.status = "approved";
    evo.approved_at = now;
    (evo as any).applied_at = now;
    all[idx] = evo;
    await writeEvolutions(params.project_path, all);
    return {
      evolution_id: evo.evolution_id,
      status: "approved",
      auto_applied: true,
      weights_updated: Object.keys(evo.supporting_data),
    };
  }

  // Fallback: approve but pending manual application
  evo.status = "approved_pending";
  evo.approved_at = now;
  all[idx] = evo;
  await writeEvolutions(params.project_path, all);
  return { evolution_id: evo.evolution_id, status: "approved_pending" };
}

// ─── sdd_abandon_experiment ─────────────────────────────────────

export async function handleAbandonExperiment(params: {
  project_path:  string;
  experiment_id: string;
  reason:        string;
}): Promise<unknown> {
  const all = await readExperiments(params.project_path);
  const idx = all.findIndex(e => e.experiment_id === params.experiment_id);

  if (idx === -1) {
    return { error: `Experiment "${params.experiment_id}" not found` };
  }

  const exp = all[idx];

  if (exp.status !== "proposed" && exp.status !== "running") {
    return { error: `Experiment "${params.experiment_id}" is in status "${exp.status}". Can only abandon "proposed" or "running" experiments.` };
  }

  exp.status = "abandoned";
  (exp as any).abandoned_at = new Date().toISOString();
  (exp as any).abandon_reason = params.reason;
  all[idx] = exp;
  await writeExperiments(params.project_path, all);

  return { abandoned: true, experiment_id: exp.experiment_id, reason: params.reason };
}

// ─── sdd_update_pattern ─────────────────────────────────────────

export async function handleUpdatePattern(params: {
  project_path: string;
  pattern_id:   string;
  increment?:   number;
  confidence?:  number;
  outcome?:     "success" | "failure";
}): Promise<unknown> {
  const all = await readPatterns(params.project_path);
  const idx = all.findIndex(p => p.pattern_id === params.pattern_id);

  if (idx === -1) {
    return { error: `Pattern "${params.pattern_id}" not found` };
  }

  const pattern = all[idx];

  if (pattern.status === "decayed") {
    return { error: `Pattern "${params.pattern_id}" is decayed and cannot be updated. Propose a new one.` };
  }

  const inc = params.increment ?? 1;
  pattern.supporting_runs += inc;

  if (params.outcome !== undefined) {
    // Bayesian update: outcome takes precedence over explicit confidence
    if (params.outcome === "success") {
      pattern.alpha += 1;
      pattern.last_confirmed_tick = pattern.total_ticks_alive;
    } else {
      pattern.beta_param += 1;
    }
    pattern.confidence = pattern.alpha / (pattern.alpha + pattern.beta_param);
  } else if (params.confidence !== undefined) {
    // Escape hatch: explicit confidence override (backward compat)
    if (params.confidence < 0 || params.confidence > 1) {
      return { error: `Confidence must be between 0 and 1, got ${params.confidence}` };
    }
    pattern.confidence = params.confidence;
  }

  all[idx] = pattern;
  await writePatterns(params.project_path, all);

  return {
    updated: true,
    pattern_id: pattern.pattern_id,
    supporting_runs: pattern.supporting_runs,
    confidence: pattern.confidence,
    alpha: pattern.alpha,
    beta_param: pattern.beta_param,
    status: pattern.status,
  };
}

// ─── sdd_get_strategy ───────────────────────────────────────────

export async function handleGetStrategy(params: {
  project_path: string;
  feature_type: string;
  complexity:   string;
  verbosity?:   string;
}): Promise<unknown> {
  // Read active patterns matching this feature context
  const allPatterns = await readPatterns(params.project_path);
  const applicable = allPatterns.filter(p => {
    if (p.status !== "active") return false;
    const cond = p.condition.toLowerCase();
    // Pattern matches if its condition is compatible with the feature context
    const ftMatch = !cond.includes("feature_type=") ||
      cond.includes(`feature_type=${params.feature_type.toLowerCase()}`);
    const cxMatch = !cond.includes("complexity=") ||
      cond.includes(`complexity=${params.complexity.toLowerCase()}`);
    return ftMatch && cxMatch;
  });

  // Read active/proposed experiments
  const allExperiments = await readExperiments(params.project_path);
  const activeExperiments = allExperiments.filter(
    e => e.status === "proposed" || e.status === "running",
  );

  // Read current score weights
  const weightsPath = resolve(params.project_path, ".sdd", "metacognition", "score_weights.json");
  let currentWeights: ScoreWeights | null = null;
  if (await fileExists(weightsPath)) {
    try { currentWeights = JSON.parse(await readFile(weightsPath, "utf-8")); } catch { /* missing */ }
  }

  // Thompson Sampling: exploit vs explore decision
  let exploit_score = 0;
  let explore_score = 0;
  const pattern_samples: Array<{ pattern_id: string; sample: number }> = [];

  if (applicable.length > 0) {
    for (const p of applicable) {
      const sample = thompsonSample(p.alpha, p.beta_param);
      pattern_samples.push({ pattern_id: p.pattern_id, sample: Math.round(sample * 1000) / 1000 });
    }
    exploit_score = pattern_samples.reduce((s, ps) => s + ps.sample, 0) / pattern_samples.length;
  }

  const proposedExperiment = activeExperiments.find(e => e.status === "proposed");
  if (proposedExperiment) {
    explore_score = thompsonSample(1, 1); // Uniform prior for unknown experiment
  }

  let decision: "exploit" | "explore";
  if (applicable.length === 0 && proposedExperiment) decision = "explore";
  else if (!proposedExperiment) decision = "exploit";
  else decision = explore_score > exploit_score ? "explore" : "exploit";

  // Resolve pattern mutations so the orchestrator can apply them directly
  const phases_to_skip: string[] = [];
  const model_overrides: Record<string, string> = {};
  const gate_overrides: Record<string, string> = {};
  const prompt_injections: Array<{ pattern_id: string; phase: string; text: string }> = [];

  if (decision === "exploit") {
    for (const p of applicable) {
      const action = p.action.toLowerCase();
      switch (p.type) {
        case "skip_phase": {
          const m = action.match(/skip\s+(?:phase[= ]*)?(\w+)/);
          if (m) phases_to_skip.push(m[1]);
          break;
        }
        case "model_swap": {
          const m = action.match(/use\s+(\w+)\s+for\s+(\w+)/);
          if (m) model_overrides[m[2]] = m[1];
          break;
        }
        case "gate_adjust": {
          const m = action.match(/(\w+)\s+gate\s+to\s+(\d+%?)/);
          if (m) gate_overrides[m[1]] = m[2];
          break;
        }
        case "prompt_tuning": {
          const m = p.action.match(/(?:for|in)\s+(\w+)/i);
          prompt_injections.push({
            pattern_id: p.pattern_id,
            phase: m ? m[1] : "all",
            text: p.action,
          });
          break;
        }
      }
    }
  }

  const vStrategy = resolveVerbosity(params.verbosity);

  if (vStrategy === "minimal") {
    return {
      has_adaptations: applicable.length > 0 || activeExperiments.length > 0,
      decision,
      mutations: { phases_to_skip, model_overrides, gate_overrides },
    };
  }
  if (vStrategy === "standard") {
    return {
      feature_type: params.feature_type,
      complexity: params.complexity,
      has_adaptations: applicable.length > 0 || activeExperiments.length > 0,
      decision,
      mutations: { phases_to_skip, model_overrides, gate_overrides, prompt_injections },
      applicable_patterns: applicable.map(p => ({ pattern_id: p.pattern_id, type: p.type, confidence: p.confidence })),
      active_experiments_count: activeExperiments.length,
    };
  }

  return {
    feature_type: params.feature_type,
    complexity: params.complexity,
    has_adaptations: applicable.length > 0 || activeExperiments.length > 0,
    mutations: { phases_to_skip, model_overrides, gate_overrides, prompt_injections },
    applicable_patterns: applicable.map(p => ({ pattern_id: p.pattern_id, type: p.type, confidence: p.confidence })),
    active_experiments: activeExperiments,
    current_weights: currentWeights,
    exploration_decision: {
      exploit_score: Math.round(exploit_score * 1000) / 1000,
      explore_score: Math.round(explore_score * 1000) / 1000,
      decision,
      method: "thompson_sampling",
      pattern_samples,
    },
  };
}

// ─── sdd_run_retro ──────────────────────────────────────────────

export async function handleRunRetro(params: {
  project_path:     string;
  feature_id:       string;
  expected_outcome?: string;
}): Promise<unknown> {
  const summaryPath = resolve(params.project_path, ".sdd", "runs", params.feature_id, "summary.json");
  if (!await fileExists(summaryPath)) {
    return { error: `No summary.json found for feature "${params.feature_id}". Call sdd_get_run_summary first.` };
  }

  const summary: RunSummary = JSON.parse(await readFile(summaryPath, "utf-8"));

  // Phase breakdown
  const phaseBreakdown: Array<{
    phase: string;
    duration_ms: number;
    fix_loops: number;
    skipped: boolean;
    gate_result: string;
  }> = [];

  for (const m of summary.phase_metrics) {
    phaseBreakdown.push({
      phase: m.phase,
      duration_ms: m.duration_ms,
      fix_loops: m.fix_loop_count,
      skipped: m.gate_result === "skip",
      gate_result: m.gate_result,
    });
  }
  // Add skipped phases not in metrics
  for (const skipped of summary.phases_skipped) {
    if (!phaseBreakdown.some(p => p.phase === skipped)) {
      phaseBreakdown.push({ phase: skipped, duration_ms: 0, fix_loops: 0, skipped: true, gate_result: "skip" });
    }
  }

  // Bottlenecks: phases with most fix loops or highest relative duration
  const totalDuration = summary.total_duration_ms || 1;
  const bottlenecks = phaseBreakdown
    .filter(p => !p.skipped)
    .filter(p => p.fix_loops > 0 || p.duration_ms > totalDuration * 0.3)
    .map(p => ({
      phase: p.phase,
      reason: p.fix_loops > 0
        ? `${p.fix_loops} fix loop(s)`
        : `${Math.round(p.duration_ms / totalDuration * 100)}% of total duration`,
      duration_ms: p.duration_ms,
      fix_loops: p.fix_loops,
    }));

  // Expected vs actual
  let expectedVsActual: { expected: string | null; actual: string; match: boolean } | undefined;
  if (params.expected_outcome) {
    const actual = summary.outcome;
    const match = params.expected_outcome.toLowerCase() === actual.toLowerCase() ||
      (params.expected_outcome === "clean_pass" && actual === "pr_created" && summary.total_fix_loops === 0);
    expectedVsActual = { expected: params.expected_outcome, actual, match };
  }

  // Check patterns confirmed/contradicted
  const patternsPath = resolve(params.project_path, ".sdd", "metacognition", "patterns.json");
  let patternsConfirmed: string[] = [];
  let patternsContradicted: string[] = [];
  if (await fileExists(patternsPath)) {
    try {
      const patterns: ExploitationPattern[] = JSON.parse(await readFile(patternsPath, "utf-8"));
      const activePatterns = patterns.filter(p => p.status === "active");
      for (const p of activePatterns) {
        // A pattern is "confirmed" if the run succeeded (pr_created) despite applying it
        // A pattern is "contradicted" if the run failed/escalated while the pattern was active
        if (summary.outcome === "pr_created") {
          patternsConfirmed.push(`${p.pattern_id}: ${p.action}`);
        } else {
          patternsContradicted.push(`${p.pattern_id}: ${p.action}`);
        }
      }
    } catch { /* ignore parse errors */ }
  }

  // Suggestions
  const suggestions: string[] = [];
  if (summary.total_fix_loops > 2) {
    suggestions.push(`High fix loop count (${summary.total_fix_loops}). Consider improving spec clarity or adding pre-checks.`);
  }
  if (summary.outcome === "escalated") {
    suggestions.push("Run was escalated. Review escalation reason and consider spec_gap patterns.");
  }
  if (bottlenecks.length > 0) {
    suggestions.push(`Bottleneck phases: ${bottlenecks.map(b => b.phase).join(", ")}. Investigate for optimization.`);
  }
  if (summary.first_pass_rate < 50) {
    suggestions.push(`Low first-pass rate (${summary.first_pass_rate}%). Gates may need relaxing or specs need tightening.`);
  }
  if (summary.phases_skipped.length > 0 && summary.outcome === "pr_created") {
    suggestions.push(`Successfully skipped phases: ${summary.phases_skipped.join(", ")}. Consider proposing exploitation patterns.`);
  }

  const retro = {
    feature_id: params.feature_id,
    run_id: summary.run_id,
    outcome: summary.outcome,
    expected_vs_actual: expectedVsActual ?? null,
    pipeline_score: summary.pipeline_score,
    total_duration_ms: summary.total_duration_ms,
    total_fix_loops: summary.total_fix_loops,
    first_pass_rate: summary.first_pass_rate,
    phase_breakdown: phaseBreakdown,
    bottlenecks,
    patterns_confirmed: patternsConfirmed,
    patterns_contradicted: patternsContradicted,
    suggestions,
    generated_at: new Date().toISOString(),
  };

  // Persist retro.json
  const retroPath = resolve(params.project_path, ".sdd", "runs", params.feature_id, "retro.json");
  await atomicWriteJSON(retroPath, retro);

  return retro;
}

// ─── sdd_phase_confidence ───────────────────────────────────────

interface PhaseConfidenceEntry {
  feature_id: string;
  phase:      string;
  confidence: number;
  reasoning:  string;
  factors:    Record<string, number> | null;
  updated_at: string;
}

export async function handlePhaseConfidence(params: {
  project_path: string;
  feature_id:   string;
  phase:        string;
  confidence:   number;
  reasoning:    string;
  factors?:     Record<string, number>;
}): Promise<unknown> {
  if (params.confidence < 0 || params.confidence > 1) {
    return { error: `Confidence must be between 0.0 and 1.0, got ${params.confidence}` };
  }

  const confDir = resolve(params.project_path, ".sdd", "runs", params.feature_id);
  await mkdir(confDir, { recursive: true });
  const confPath = join(confDir, "phase_confidence.json");

  // Read existing entries
  let entries: PhaseConfidenceEntry[] = [];
  if (await fileExists(confPath)) {
    try { entries = JSON.parse(await readFile(confPath, "utf-8")); } catch { entries = []; }
  }

  const now = new Date().toISOString();
  const entry: PhaseConfidenceEntry = {
    feature_id: params.feature_id,
    phase:      params.phase,
    confidence: params.confidence,
    reasoning:  params.reasoning,
    factors:    params.factors ?? null,
    updated_at: now,
  };

  // Upsert: replace existing entry for this feature+phase, or append
  const existingIdx = entries.findIndex(
    e => e.feature_id === params.feature_id && e.phase === params.phase,
  );
  if (existingIdx >= 0) {
    entries[existingIdx] = entry;
  } else {
    entries.push(entry);
  }

  await atomicWriteJSON(confPath, entries);

  return { persisted: true, ...entry };
}
