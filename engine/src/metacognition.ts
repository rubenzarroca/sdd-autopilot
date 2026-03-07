// SDD Autopilot — Metacognition Layer handlers
// Phase 2: sdd_compute_score
// Phases 3-5: sdd_get/propose/promote_pattern, sdd_propose/evaluate_experiment, sdd_propose_evolution
// All deterministic — no LLM calls.

import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { RunSummary, ScoreWeights, CompositeScore, ExploitationPattern, Experiment, PipelineEvolution, PhaseMetrics } from "./types.js";
import { fileExists, parseJsonl } from "./utils.js";

// ─── Generic metacognition JSON helpers ──────────────────────────

async function readMetacognitionJson<T>(projectPath: string, filename: string): Promise<T[]> {
  const p = resolve(projectPath, ".sdd", "metacognition", filename);
  if (!await fileExists(p)) return [];
  try { return JSON.parse(await readFile(p, "utf-8")); } catch { return []; }
}

async function writeMetacognitionJson<T>(projectPath: string, filename: string, data: T[]): Promise<void> {
  const dir = resolve(projectPath, ".sdd", "metacognition");
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, filename), JSON.stringify(data, null, 2), "utf-8");
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

// ─── sdd_compute_score ───────────────────────────────────────────

export async function handleComputeScore(params: {
  project_path: string;
  feature_id:   string;
  run_id?:      string;
}): Promise<unknown> {
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

  // Persist pipeline_score back into summary.json
  summary.pipeline_score = pipeline_score;
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf-8");

  // Ensure metacognition dir exists (score_weights.json lives here when Phase 5 writes it)
  const metacognitionDir = resolve(params.project_path, ".sdd", "metacognition");
  await mkdir(metacognitionDir, { recursive: true });

  return result;
}

// ─── Exploitation Patterns helpers ───────────────────────────────

const readPatterns  = (p: string) => readMetacognitionJson<ExploitationPattern>(p, "patterns.json");
const writePatterns = (p: string, data: ExploitationPattern[]) => writeMetacognitionJson(p, "patterns.json", data);

// ─── sdd_get_patterns ────────────────────────────────────────────

export async function handleGetPatterns(params: {
  project_path:  string;
  status?:       "candidate" | "active" | "decayed" | "all";
  feature_type?: string;
  complexity?:   string;
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

  return { patterns: results, count: results.length };
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
    confidence:      params.confidence,
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

  // Promotion gate: supporting_runs >= min_runs AND confidence >= 0.7
  if (pattern.supporting_runs < pattern.min_runs) {
    return {
      promoted: false,
      reason: `Insufficient supporting_runs: ${pattern.supporting_runs} < min_runs (${pattern.min_runs})`,
    };
  }
  if (pattern.confidence < 0.7) {
    return {
      promoted: false,
      reason: `Insufficient confidence: ${pattern.confidence} < 0.7`,
    };
  }

  pattern.status = "active";
  pattern.promoted_at = new Date().toISOString();
  all[idx] = pattern;
  await writePatterns(params.project_path, all);

  return { promoted: true, pattern_id: pattern.pattern_id, status: "active" };
}

// ─── sdd_tick_decay extension: decay patterns ────────────────────
// Called by the existing sdd_tick_decay handler; exported for use in handlers.ts if needed.
// For now, pattern TTL decay is handled separately via sdd_tick_patterns (added to handler map).

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

// ─── sdd_tick_patterns (Phase 3) ────────────────────────────────
export async function handleTickPatterns(params: {
  project_path: string;
}): Promise<unknown> {
  const all = await readPatterns(params.project_path);
  let decayed = 0;

  const updated = all.map(p => {
    if (p.status !== "active" && p.status !== "candidate") return p;
    const newTtl = p.ttl - 1;
    if (newTtl <= 0) {
      decayed++;
      return { ...p, ttl: 0, status: "decayed" as const, decayed_at: new Date().toISOString() };
    }
    return { ...p, ttl: newTtl };
  });

  await writePatterns(params.project_path, updated);
  return { ticked: true, decayed };
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
    await writeFile(weightsPath, JSON.stringify(newWeights, null, 2), "utf-8");

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

  if (params.confidence !== undefined) {
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
    status: pattern.status,
  };
}

// ─── sdd_get_strategy ───────────────────────────────────────────

export async function handleGetStrategy(params: {
  project_path: string;
  feature_type: string;
  complexity:   string;
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

  // Build recommendations from applicable patterns
  const recommendations: string[] = [];
  for (const p of applicable) {
    recommendations.push(
      `Pattern "${p.pattern_id}" (confidence: ${p.confidence}, runs: ${p.supporting_runs}): ${p.action}`,
    );
  }
  if (activeExperiments.length > 0) {
    for (const e of activeExperiments) {
      recommendations.push(
        `Experiment "${e.experiment_id}" (${e.status}): ${e.hypothesis}. Mutation: ${JSON.stringify(e.mutation)}`,
      );
    }
  }
  if (applicable.length === 0 && activeExperiments.length === 0) {
    recommendations.push("No active patterns or experiments apply. Run standard pipeline.");
  }

  return {
    feature_type: params.feature_type,
    complexity: params.complexity,
    applicable_patterns: applicable,
    active_experiments: activeExperiments,
    current_weights: currentWeights,
    recommendations,
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
  await writeFile(retroPath, JSON.stringify(retro, null, 2), "utf-8");

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

  await writeFile(confPath, JSON.stringify(entries, null, 2), "utf-8");

  return { persisted: true, ...entry };
}
