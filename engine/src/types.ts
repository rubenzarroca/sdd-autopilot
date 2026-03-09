// SDD Autopilot v2 — Shared types
// State layer: feature as business entity with transition machine, agent boundaries, typed signals

// ─── State Machine ───────────────────────────────────────────────

export type FeatureState =
  | "draft"
  | "specified"
  | "planned"
  | "decomposed"
  | "implementing"
  | "blocked"           // TASK_BLOCKED | DEPENDENCY_MISSING
  | "fix_loop"          // verifying → fix_loop → implementing (implementation_bug)
  | "fix_review"        // reviewing → fix_review → implementing (critical findings)
  | "awaiting_input"    // spec_gap: human must provide clarification
  | "verifying"
  | "reviewing"
  | "pr_created"
  | "merged"
  | "escalated";        // any → escalated (hard stop, human required)

// ─── Agents ──────────────────────────────────────────────────────

export type AgentId =
  | "spec-generator"
  | "plan-architect"
  | "task-decomposer"
  | "implementation-engine"
  | "verification-engine"
  | "adversarial-reviewer"
  | "pr-creator"
  | "haiku-validator"
  | "orchestrator";

// ─── Signals (append-only lateral communication) ─────────────────

export type SignalType =
  | "ATTENTION_REQUIRED"    // downstream agent should focus on something
  | "PATTERN_DETECTED"      // recurring issue across tasks/runs
  | "DEPENDENCY_WARNING"    // dependency is fragile, missing, or changed
  | "CONTEXT_NOTE"          // useful context for next agents in the wave
  | "META_LEARNING_HINT"    // candidate for prompt/heuristic update (for Opus)
  | "QUESTION"              // agent needs information from another agent (routed via orchestrator)
  | "BLOCKER";              // agent cannot proceed; requires orchestrator intervention

export interface Signal {
  id: string;
  type: SignalType;
  from_agent: AgentId;
  at: string;              // ISO timestamp
  payload: Record<string, unknown>;
}

// ─── Transitions ─────────────────────────────────────────────────

export interface FeatureTransition {
  from: FeatureState;
  to: FeatureState;
  at: string;
  command: string;
  agent: AgentId;
}

export interface TaskStatus {
  status: "pending" | "in-progress" | "completed";
  title: string;
  completed_at?: string;
}

// ─── Feature entity ──────────────────────────────────────────────

export interface FeatureEntry {
  state: FeatureState;
  spec_path: string;
  plan_path?: string;
  tasks_path?: string;
  worktree_path?: string;
  branch?: string;
  transitions: FeatureTransition[];
  tasks: Record<string, TaskStatus>;
  signals: Signal[];              // append-only; never mutate existing entries
  verification_attempts: number;
  review_attempts: number;
  fix_loop_attempts: number;
  fix_review_attempts: number;
  blocked_reason?: string;
  escalation_reason?: string;
  awaiting_input_reason?: string;
}

// ─── State root ──────────────────────────────────────────────────
// allowed_transitions removed — governance lives in AGENT_PERMISSIONS (state.ts), not in data

export interface StateJson {
  version: string;
  project: string;
  initialized_at: string;
  active_feature: string | null;
  features: Record<string, FeatureEntry>;
}

// ─── Transition results ──────────────────────────────────────────

export type TransitionErrorCode =
  | "UNAUTHORIZED"           // agent not permitted for this transition
  | "INVALID_TRANSITION"     // transition not valid from current state for any agent
  | "PRECONDITION_FAILED"    // business rule blocked the operation
  | "FEATURE_NOT_FOUND"
  | "ESCALATE"               // system cannot proceed, human required
  | "SPEC_GAP"               // spec missing info needed to continue
  | "TASK_BLOCKED"           // task cannot proceed, external dependency
  | "DEPENDENCY_MISSING"     // required artifact or dependency absent
  | "CIRCUIT_BREAKER";       // delta_check abort or threshold breach — hard stop

export type TransitionResult =
  | { ok: true;  from: FeatureState; to: FeatureState; agent: AgentId }
  | { ok: false; code: TransitionErrorCode; reason: string };

// ─── Phase Results ───────────────────────────────────────────────

export interface TriageResult {
  complexity: "low" | "medium" | "high" | "critical";
  estimated_tasks: number;
  estimated_files: number;
  regression_risk: "low" | "medium" | "high";
  estimated_tokens: number;
  proceed: boolean;
  reason: string;
}

export interface RetroResult {
  clean_merge: boolean;
  delta_summary: string;
  learnings: string[];
  human_changes_count: number;
}

export interface ExplorationProposal {
  change_type: "prompt_variant" | "contract_adjustment" | "heuristic";
  target: string;
  proposal: string;
  hypothesis: string;
  metric: string;
  ttl_runs: number;
}

export interface TrendsResult {
  meta_learnings: string[];
  agent_adjustments: Array<{ agent: string; observation: string }>;
  exploration_proposal?: ExplorationProposal;
}

export interface ExplorationEntry extends ExplorationProposal {
  id: string;             // EXP-001
  added_at_run: number;
  runs_remaining: number;
  status: "active" | "confirmed" | "reverted" | "expired";
  result?: string;
}

// ─── Observability (12) ──────────────────────────────────────────

export interface RunLogEntry {
  run_id: string;
  phase: string;
  agent: string;
  model: "opus" | "sonnet" | "haiku";
  started_at: string;       // full ISO-8601: YYYY-MM-DDTHH:mm:ss.sssZ
  elapsed_ms: number;       // wall-clock duration of the phase
  input_tokens: number;
  output_tokens: number;
  tool_calls: number;
  outcome: "pass" | "fix_loop" | "escalated" | "error";
  fix_loop_category?: string;   // "implementation_bug" | "spec_gap" | "infra_issue"
  signals_emitted?: number;     // count of append_signal calls in this phase
  exploration_active?: string;  // EXP-NNN id if an experiment is active this run
}

export interface AuditEvent {
  run_id: string;
  phase: string;
  agent: string;
  seq: number;
  ts: string;               // full ISO-8601: YYYY-MM-DDTHH:mm:ss.sssZ
  tool: string;
  params_summary: string;   // JSON-serialized params truncated to 200 chars
  result_summary: string;   // JSON-serialized result data truncated to 200 chars
  outcome: "ok" | "error";
}

export interface PhaseResult {
  text: string;
  steps: string[];
  model: "opus" | "sonnet" | "haiku";
  started_at: string;  // full ISO-8601 timestamp when runPhase was called
  elapsed_ms: number;  // wall-clock ms from start to completion
  usage: {
    input_tokens: number;
    output_tokens: number;
    tool_calls: number;
  };
}

// ─── Verification / Review structured outputs ────────────────────

export interface VerificationFinding {
  category: "tests_failing" | "spec_coverage_gap" | "regression_detected" | "constitution_violation" | "build_error";
  description: string;
  evidence: string;
  affected_file?: string;
  affected_line?: number;
}

export interface VerificationResult {
  status: "PASS" | "FAIL" | "SPEC_GAP";
  findings: VerificationFinding[];
  tests_total: number;
  tests_passed: number;
  tests_failed: number;
  spec_coverage_pct: number;
  regression_clean: boolean;
  constitution_clean: boolean;
}

export interface ReviewIssue {
  category: "correctness" | "security" | "performance" | "maintainability" | "side_effects";
  severity: "critical" | "major" | "minor";  // critical=blocks PR, major=non-blocking comment, minor=learning signal
  description: string;
  evidence: string;
  file?: string;
  line?: number;
  suggested_fix?: string;
}

export interface ReviewResult {
  decision: "APPROVE" | "REQUEST_CHANGES";
  issues: ReviewIssue[];
  warnings: ReviewIssue[];
  summary: string;
}

// ─── Pipeline Contracts ───────────────────────────────────────────
// Loaded from contracts.json at runtime — single source of truth for pipeline structure.
// Alternative pipelines (quick, security, docs) require only a different contracts.json.

export interface ContractGate {
  type: "mechanical" | "agent" | "self";
  agent?: string;
  validator?: string;   // opt-in semantic validation (4.3): "haiku-validator" triggers a Haiku gate check
  pass_condition?: string;
  max_iterations?: number;
  checks?: string[];
  severity_handling?: Record<string, string>;
}

export interface ContractFixLoop {
  max_attempts: number;
  classify_failure?: boolean;
  categories?: string[];
  delta_check?: boolean;
}

export interface PairConfig {
  enabled: boolean;
  max_corrections: number;  // always 1 for now; reserved for future tuning
}

// ─── Wave Execution (parallel_waves) ─────────────────────────────
// Waves are computed at runtime from task dependsOn graph (computeWaves in tasks.ts).
// This config declares governance constraints for parallel execution.

export interface WaveConfig {
  message_budget: number;        // max inter-agent messages per wave before ESCALATE
  agents_can_query: string[];    // which agent IDs this stage's agents may query
                                 // enforced at prompt level (honor system + audit trail)
}

// ─── Inter-Agent Messages ─────────────────────────────────────────
// Typed messages flowing through the orchestrator (star topology — no P2P).
// Agent A emits a QUESTION/BLOCKER; orchestrator routes to agent B or human.

export interface InterAgentMessage {
  id: string;
  type: "QUESTION" | "BLOCKER";
  from_agent: AgentId;
  to_agent: AgentId | "orchestrator" | "human";
  at: string;                    // ISO timestamp
  wave_id?: string;              // originating wave, e.g. "wave_1"
  payload: {
    question?: string;           // QUESTION: what the agent needs to know
    reason?: string;             // BLOCKER: why the agent cannot proceed
    context?: string;            // additional context for the recipient
  };
  resolved: boolean;             // orchestrator sets true after routing response back
}

export interface StageContract {
  agent: string;
  model: "sonnet" | "opus" | "haiku";
  input: {
    required: string[];
    optional: string[];
    max_tokens: number;
  };
  output: {
    artifacts: string[];
    schema?: Record<string, unknown>;
  };
  gate: ContractGate;
  execution?: "sequential" | "per_task" | "parallel_waves";
  fix_loop?: ContractFixLoop;
  pair_review?: PairConfig;   // Opus-as-coach: review → optional Sonnet correction pass
  wave_config?: WaveConfig;   // parallel_waves: governance for inter-agent communication
  failure_modes: string[];
  next: string | null;
}

export interface PipelineContracts {
  pipeline: string;
  version: string;
  contracts: Record<string, StageContract>;
}

// ─── Pipeline Config ─────────────────────────────────────────────

export interface PipelineConfig {
  projectPath: string;
  featureDescription: string;
  maxVerifyAttempts: number;
  maxReviewAttempts: number;
  maxPhaseIterations: number;
}

export const DEFAULT_CONFIG: Omit<PipelineConfig, "projectPath" | "featureDescription"> = {
  maxVerifyAttempts: 3,
  maxReviewAttempts: 2,
  maxPhaseIterations: 25,
};

// ─── Models ──────────────────────────────────────────────────────

export const PRICING = {
  opus:   { input: 15,  output: 75 },
  sonnet: { input:  3,  output: 15 },
  haiku:  { input:  0.8, output:  4 },
} as const;

export const MODELS = {
  opus:   "claude-opus-4-6-20250514",
  sonnet: "claude-sonnet-4-6-20250514",
  haiku:  "claude-haiku-4-5-20251001",
} as const;

// ─── Observability Layer (Phase 1) ───────────────────────────────

export type FindingSeverity = "critical" | "major" | "minor";

export interface PhaseMetrics {
  // Identification
  run_id:            string;
  feature_id:        string;
  phase:             string;
  agent:             string;
  model:             string;

  // Temporal (instrumented manually — Claude Code Agent tool does not expose these natively)
  started_at:        string;    // ISO8601
  completed_at:      string;    // ISO8601
  duration_ms:       number;

  // Consumption (parsed from Agent tool completion summary, e.g. "17 tool uses · 23.2k tokens")
  tokens_in:         number | null;
  tokens_out:        number | null;
  tokens_total:      number | null;
  tool_calls_count:  number;

  // Result
  gate_result:       "pass" | "fail" | "skip";
  gate_attempts:     number;

  // Quality (phase-specific; populated from subagent structured output)
  findings_count:    number;
  findings_severity: FindingSeverity[];

  // Fix loops
  fix_loop_count:    number;
  delta_direction:   "improving" | "regressing" | "stable" | null;

  // Context (from triage)
  feature_type:      string | null;
  complexity:        string | null;
}

export interface RunSummary {
  run_id:             string;
  feature_id:         string;
  feature_type:       string;
  complexity:         string;

  // Global result
  outcome:            "pr_created" | "escalated" | "aborted";
  total_duration_ms:  number;
  total_tokens:       number | null;

  // Phase breakdown
  phases_executed:    string[];
  phases_skipped:     string[];

  // Aggregated quality
  total_fix_loops:    number;
  verify_attempts:    number;
  review_attempts:    number;
  review_decision:    "approve" | "request_changes" | "reject" | null;
  first_pass_rate:    number;    // 0–100

  // Composite Score (computed by sdd_compute_score, Phase 2)
  pipeline_score:     number | null;

  // Average phase confidence (computed from phase_confidence.json)
  avg_confidence:     number | null;

  // Phase detail
  phase_metrics:      PhaseMetrics[];
}

export interface AnalyticsTrend {
  metric:       string;
  direction:    "improving" | "regressing" | "stable";
  data_points:  number;
}

export interface AnalyticsResult {
  filter: {
    feature_type?: string;
    complexity?:   string;
    date_from?:    string;
    date_to?:      string;
  };
  runs_analyzed:                  number;
  avg_duration_by_phase:          Record<string, number>;
  avg_fix_loops_by_feature_type:  Record<string, number>;
  first_pass_rate_history:        number;
  high_variance_phases:           string[];
  trends:                         AnalyticsTrend[];
}

// ─── Metacognition Layer (Phase 2+) ──────────────────────────────

// Stored in .sdd/metacognition/score_weights.json
// Modified only by sdd_propose_evolution (Phase 5 governance).
// If the file is missing, sdd_compute_score uses DEFAULT_WEIGHTS.
export interface ScoreWeights {
  // Top-level split
  quality_weight:            number;    // default 0.7
  efficiency_weight:         number;    // default 0.3

  // Quality sub-weights (must sum to 1.0)
  review_result_weight:      number;    // default 0.40
  first_pass_rate_weight:    number;    // default 0.25
  findings_severity_weight:  number;    // default 0.20
  verify_clean_weight:       number;    // default 0.15

  // Efficiency sub-weights — adjusted for tokens=null (must sum to 1.0)
  fix_loops_weight:          number;    // default 0.50 (was 0.40; token weight redistributed)
  phases_skipped_weight:     number;    // default 0.20 (was 0.30; token weight redistributed)
  duration_trend_weight:     number;    // default 0.30

  // Governance
  max_fix_loops_possible:    number;    // default 5 (3 verify + 2 review max)
  tokens_available:          boolean;   // false until Agent tool exposes usage natively

  // Audit trail (set by sdd_propose_evolution)
  updated_at?:  string;
  updated_by?:  string;
}

// ─── Metacognition: Pipeline Evolution (Phase 5) ─────────────────

export interface PipelineEvolution {
  evolution_id:     string;
  type:             "weight_adjust" | "phase_add" | "phase_remove" | "agent_redesign" | "contract_change";
  description:      string;
  rationale:        string;
  supporting_data:  Record<string, unknown>;    // metrics/trends that justify the change
  impact:           "low" | "medium" | "high";
  requires_human:   boolean;    // true for phase_add, phase_remove, agent_redesign (always)
  status:           "proposed" | "approved" | "approved_pending" | "applied" | "reverted" | "rejected";
  proposed_at:      string;
  approved_at?:     string;
  applied_at?:      string;
}

// ─── Metacognition: Exploration Experiments (Phase 4) ────────────

export interface Experiment {
  experiment_id:   string;
  hypothesis:      string;
  type:            "phase_merge" | "phase_skip" | "model_swap" | "parallel_expand" | "gate_relax" | "prompt_variant" | "new_phase";
  mutation:        Record<string, unknown>;    // concrete change to apply to the pipeline
  expected_impact: string;
  risk_level:      "low" | "medium" | "high";
  status:          "proposed" | "running" | "completed" | "abandoned";
  result_score:    number | null;    // pipeline_score of the experimental run
  baseline_score:  number | null;    // mean pipeline_score of recent non-experimental runs
  verdict:         "promote" | "discard" | "retry" | null;
  retry_count:     number;           // max 2
  created_at:      string;
  started_at?:     string;           // when status → running
  completed_at?:   string;           // when verdict written
}

// ─── Metacognition: Exploitation Patterns (Phase 3) ─────────────

export interface ExploitationPattern {
  pattern_id:       string;      // stable slug, e.g. "skip-plan-api-low"
  type:             "skip_phase" | "reorder" | "model_swap" | "prompt_tuning" | "gate_adjust";
  condition:        string;      // match expression, e.g. "feature_type=api AND complexity=low"
  action:           string;      // what to do, e.g. "skip phase=plan"
  confidence:       number;      // 0–1; derived from Beta posterior mean α/(α+β)
  alpha:            number;      // Bayesian prior + successes (default 1)
  beta_param:       number;      // Bayesian prior + failures (default 1, named to avoid reserved word collision)
  last_confirmed_tick: number;   // tick at which last confirmed (default 0)
  total_ticks_alive:   number;   // total ticks since creation (default 0)
  decay_rate:          number;   // adaptive decay lambda, computed dynamically
  supporting_runs:  number;      // runs that support this pattern; must be >= min_runs to promote
  min_runs:         number;      // promotion threshold (default 5)
  ttl:              number;      // decrements remaining before expiry
  status:           "candidate" | "active" | "decayed";
  created_at:       string;
  promoted_at?:     string;
  decayed_at?:      string;
}

export interface CompositeScore {
  run_id:          string;
  feature_id:      string;
  pipeline_score:  number;    // 0-100, 1 decimal
  quality_score:   number;    // 0-100, integer
  efficiency_score: number;   // 0-100, integer
  breakdown: {
    review_result_score:    number;
    first_pass_rate_score:  number;
    findings_score:         number;
    verify_clean_score:     number;
    fix_loops_score:        number;
    phases_skipped_score:   number;
    duration_trend_score:   number;
  };
  weights_used: ScoreWeights;
}

// ─── MCP Tool Output Types ───────────────────────────────────────

export interface GetStateOutput {
  feature_id?: string;
  error?: string;
  // When feature_id is provided, returns FeatureEntry fields spread at top level.
  // When no feature_id, returns full StateJson.
}

export interface TransitionOutput {
  success: boolean;
  new_state?: string;
  error?: { code: string; message: string; allowed_transitions: string[] };
}

export interface GetContractOutput {
  // Returns StageContract fields or error
  error?: string;
}

export interface EvaluateGateOutput {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  needs_semantic_validation?: { check: string; description: string };
  error?: string;
}

export interface ClassifyFailureOutput {
  category: "implementation_bug" | "spec_gap" | "infra_issue";
  confidence: "high" | "medium" | "low";
  reasoning: string;
}

export interface DeltaCheckOutput {
  result: "continue" | "abort";
  previous_failures?: number;
  reason: string;
}

export interface LogEventOutput {
  logged: boolean;
  timestamp: string;
}

export interface MemoryReadOutput {
  content: string;
  section: string;
  scope: "project" | "user";
}

export interface MemoryWriteOutput {
  written: boolean;
  timestamp?: string;
  reason?: string;
}

export interface TickDecayOutput {
  patterns_removed: number;
  explorations_expired: number;
  total_removed: number;
}

export interface UpdateTaskOutput {
  updated: boolean;
  task_id: string;
  status: string;
  error?: string;
}

export interface UpdateFeatureOutput {
  updated: boolean;
  fields: string[];
  error?: string;
}

export interface AppendSignalOutput {
  appended: boolean;
  signal_id: string;
  in_state: boolean;
}

export interface EmitMetricsOutput {
  emitted: boolean;
  run_id: string;
  phase: string;
}

export interface GetRunSummaryOutput {
  // When last_n_runs is provided: { summaries, runs_analyzed }
  // Otherwise: full RunSummary or error
  error?: string;
}

export interface GetAnalyticsOutput extends AnalyticsResult {}

export interface CheckThresholdsOutput {
  alerts: Array<{
    level: "warning" | "critical";
    metric: string;
    phase?: string;
    current_value: number;
    threshold: number;
    message: string;
  }>;
  checked_at: string;
  error?: string;
}

export interface EstimateCostOutput {
  total_cost_usd: number;
  phases: Array<{ phase: string; model: string; tokens_in: number | null; tokens_out: number | null; cost_usd: number }>;
  model_breakdown: Record<string, number>;
  error?: string;
}

export interface GetLiveStatusOutput {
  status: "running" | "idle";
  feature_state?: string;
  current_phase?: string | null;
  started_at?: string | null;
  elapsed_seconds?: number | null;
  last_completed_phase?: string | null;
  last_completed_at?: string | null;
  error?: string;
}

export interface CompareRunsOutput {
  run_a: { id: string; feature_id: string; outcome: string; pipeline_score: number | null };
  run_b: { id: string; feature_id: string; outcome: string; pipeline_score: number | null };
  diffs: Record<string, { a: number | null; b: number | null; diff: number | null; diff_pct: number | null }>;
  phase_diffs: Array<{ phase: string; metric: string; a: number; b: number; diff: number }>;
  better_run: string;
  error?: string;
}

export interface DetectAnomalyOutput {
  is_anomaly: boolean;
  status: "analyzed" | "insufficient_data";
  sensitivity?: number;
  anomalies?: Array<{ metric: string; value: number; mean: number; stddev: number; z_score: number }>;
  run_percentile?: number | null;
  message?: string;
  error?: string;
}

export interface ValidateMetricsOutput {
  valid: boolean;
  errors: Array<{ field: string; message: string }>;
  warnings: Array<{ field: string; message: string }>;
}

export interface GetPatternsOutput {
  patterns: ExploitationPattern[];
  count: number;
}

export interface ProposePatternOutput {
  proposed: boolean;
  pattern_id: string;
  status: "candidate";
  error?: string;
}

export interface PromotePatternOutput {
  promoted: boolean;
  pattern_id?: string;
  status?: string;
  reason?: string;
  error?: string;
}

export interface TickPatternsOutput {
  ticked: boolean;
  decayed: number;
}

export interface ProposeExperimentOutput {
  proposed: boolean;
  experiment_id: string;
  status: "proposed";
  error?: string;
}

export interface EvaluateExperimentOutput {
  evaluated: boolean;
  experiment_id: string;
  verdict: "promote" | "discard" | "retry";
  status: string;
  result_score: number;
  baseline_score: number;
  retry_count: number;
  error?: string;
}

export interface ProposeEvolutionOutput {
  proposed: boolean;
  evolution_id: string;
  requires_human: boolean;
  status: "proposed";
  error?: string;
}

export interface ApproveEvolutionOutput {
  evolution_id: string;
  status: string;
  auto_applied?: boolean;
  weights_updated?: string[];
  message?: string;
  reason?: string;
  error?: string;
}

export interface AbandonExperimentOutput {
  abandoned: boolean;
  experiment_id: string;
  reason: string;
  error?: string;
}

export interface UpdatePatternOutput {
  updated: boolean;
  pattern_id: string;
  supporting_runs: number;
  confidence: number;
  status: string;
  error?: string;
}

export interface GetStrategyOutput {
  feature_type: string;
  complexity: string;
  applicable_patterns: ExploitationPattern[];
  active_experiments: Experiment[];
  current_weights: ScoreWeights | null;
  recommendations: string[];
}

export interface RunRetroOutput {
  feature_id: string;
  run_id: string;
  outcome: string;
  expected_vs_actual: { expected: string | null; actual: string; match: boolean } | null;
  pipeline_score: number | null;
  total_duration_ms: number;
  total_fix_loops: number;
  first_pass_rate: number;
  phase_breakdown: Array<{ phase: string; duration_ms: number; fix_loops: number; skipped: boolean; gate_result: string }>;
  bottlenecks: Array<{ phase: string; reason: string; duration_ms: number; fix_loops: number }>;
  patterns_confirmed: string[];
  patterns_contradicted: string[];
  suggestions: string[];
  generated_at: string;
  error?: string;
}

export interface PhaseConfidenceOutput {
  persisted: boolean;
  feature_id: string;
  phase: string;
  confidence: number;
  reasoning: string;
  factors: Record<string, number> | null;
  updated_at: string;
  error?: string;
}

// ─── Tool Factory (Self-Evolution) ───────────────────────────────

export interface ToolProposal {
  name: string;
  description: string;
  rationale: string;
  proposed_input_schema: Record<string, unknown>;
  proposed_output_schema: Record<string, unknown>;
  proposed_handler_logic: string;
  target_file: string;
  pipeline_phase: string;
  trigger_context: string;
  proposed_at: string;
  proposed_by: string;
  status: "proposed" | "validated" | "rejected" | "prompt_generated";
  run_id: string;
  feature_id: string;
  reviewed_at?: string;
  overlap_details?: Array<{ tool: string; score: number }>;
  rejection_reason?: string;
  reviewer_assessment?: string;
}

export interface ToolReviewResult {
  status: "validated" | "rejected";
  reason?: string;
  overlapping_tools?: string[];
  overlap_scores?: Array<{ tool: string; score: number }>;
}

export interface ToolPromptResult {
  success: boolean;
  prompt_path: string;
}
