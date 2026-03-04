// SDD Autopilot — Shared types
// Stripped of coaching types, adds verification/review types

// ─── State Machine ───────────────────────────────────────────────

export type FeatureState =
  | "drafting"
  | "specified"
  | "planned"
  | "tasked"
  | "implementing"
  | "verifying"
  | "reviewing"
  | "completed";

export interface TaskStatus {
  status: "pending" | "in-progress" | "completed";
  title: string;
  completed_at?: string;
}

export interface FeatureTransition {
  from: FeatureState;
  to: FeatureState;
  at: string;
  command: string;
}

export interface FeatureEntry {
  state: FeatureState;
  spec_path: string;
  plan_path?: string;
  tasks_path?: string;
  worktree_path?: string;
  branch?: string;
  transitions: FeatureTransition[];
  tasks: Record<string, TaskStatus>;
  verification_attempts: number;
  review_attempts: number;
}

export interface StateJson {
  version: string;
  project: string;
  initialized_at: string;
  active_feature: string | null;
  features: Record<string, FeatureEntry>;
  allowed_transitions: Record<string, string[]>;
}

// ─── Phase Results ───────────────────────────────────────────────

export interface PhaseResult {
  text: string;
  steps: string[];
  model: "opus" | "sonnet";
  usage: {
    input_tokens: number;
    output_tokens: number;
    tool_calls: number;
  };
}

// ─── Pricing (per million tokens) ───────────────────────────────

export const PRICING = {
  opus:   { input: 15, output: 75 },
  sonnet: { input:  3, output: 15 },
} as const;

export interface VerificationFinding {
  category: "tests_failing" | "spec_coverage_gap" | "regression_detected" | "constitution_violation" | "build_error";
  description: string;
  evidence: string;
  affected_file?: string;
  affected_line?: number;
}

export interface VerificationResult {
  status: "PASS" | "FAIL";
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
  severity: "blocking" | "warning";
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

export const MODELS = {
  opus: "claude-opus-4-6-20250514",
  sonnet: "claude-sonnet-4-6-20250514",
} as const;
