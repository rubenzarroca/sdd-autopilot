#!/usr/bin/env node

// SDD Autopilot v2 — Data-driven pipeline orchestrator
// Pipeline structure is loaded from contracts.json — no hardcoded phase logic.
// Alternative pipelines (quick, security, docs) require only a different contracts.json.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StateManager } from "./state.js";
import { runPhase } from "./phase.js";
import { worktreeStart, worktreeFinish, type WorktreeStartResult } from "./git.js";
import { buildSpecifyPrompt } from "./prompts/specify.js";
import { buildPlanPrompt } from "./prompts/plan.js";
import { buildTasksPrompt } from "./prompts/tasks.js";
import { buildImplementTaskPrompt } from "./prompts/implement.js";
import { parseTasks, computeWaves } from "./tasks.js";
import { buildVerifyPrompt } from "./prompts/verify.js";
import { buildReviewPrompt } from "./prompts/review.js";
import { buildFixPrompt } from "./prompts/fix.js";
import { buildPairCoachPrompt, buildPairCorrectionPrompt, type PairStage } from "./prompts/pair.js";
import { buildCodebaseIndexPrompt } from "./prompts/index-codebase.js";
import { buildTriagePrompt } from "./prompts/triage.js";
import { buildSpecTestPrompt } from "./prompts/spec-test.js";
import { buildMemoryUpdatePrompt } from "./prompts/memory-update.js";
import { buildMemoryConsolidatePrompt } from "./prompts/memory-consolidate.js";
import { buildRetroImmediatePrompt } from "./prompts/retro-immediate.js";
import { buildRetroTrendsPrompt } from "./prompts/retro-trends.js";
import { buildHaikuValidatorPrompt } from "./prompts/haiku-validator.js";
import { MemoryManager, type ProjectMemory, type UserMemory, type RunHistoryEntry } from "./memory.js";
import { RunLogger } from "./observability.js";
import {
  DEFAULT_CONFIG,
  PRICING,
  type PipelineConfig,
  type VerificationResult,
  type ReviewResult,
  type PhaseResult,
  type PipelineContracts,
  type StageContract,
  type TriageResult,
  type RetroResult,
  type TrendsResult,
  type ExplorationEntry,
  type RunLogEntry,
  type AuditEvent,
} from "./types.js";

// ─── Typed Pipeline Errors ────────────────────────────────────────
// Distinct error types let main() route to the correct state transition and human message.

export class SpecGapError extends Error {
  constructor(public readonly diagnosis: string) {
    super(`[spec_gap] ${diagnosis}`);
    this.name = "SpecGapError";
  }
}

export class InfraIssueError extends Error {
  constructor(public readonly diagnosis: string) {
    super(`[infra_issue] ${diagnosis}`);
    this.name = "InfraIssueError";
  }
}

export class CriticalComplexityError extends Error {
  constructor(public readonly triage: TriageResult) {
    super(`[critical_complexity] ${triage.reason}`);
    this.name = "CriticalComplexityError";
  }
}

// ─── Contracts ────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadContracts(): PipelineContracts {
  return JSON.parse(readFileSync(resolve(__dirname, "contracts.json"), "utf-8")) as PipelineContracts;
}

// ─── CLI ──────────────────────────────────────────────────────────

interface CliArgs extends PipelineConfig {
  skipWorktree: boolean;
  skipPr: boolean;
  forceTriage: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    console.log(`
SDD Autopilot v2 — Autonomous specify → plan → tasks → implement → verify → review → PR pipeline
Pipeline structure is driven by contracts.json.

Usage:
  sdd-autopilot "<feature description>" --project <path> [options]

Options:
  --project <path>    Path to the project root (required)
  --max-verify <n>    Override max verification attempts (default: from contracts)
  --max-review <n>    Override max review attempts (default: from contracts)
  --skip-worktree     Skip git worktree creation (work in place)
  --skip-pr           Skip PR creation
  --force-triage      Proceed even if triage estimates critical complexity
  --help, -h          Show this help

Example:
  sdd-autopilot "Add a health check endpoint" --project /path/to/my-project
`);
    process.exit(0);
  }

  let featureDescription = "";
  let projectPath = "";
  let maxVerifyAttempts = DEFAULT_CONFIG.maxVerifyAttempts;
  let maxReviewAttempts = DEFAULT_CONFIG.maxReviewAttempts;
  let skipWorktree = false;
  let skipPr = false;
  let forceTriage = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) {
      projectPath = resolve(args[++i]);
    } else if (args[i] === "--max-verify" && args[i + 1]) {
      maxVerifyAttempts = parseInt(args[++i], 10);
    } else if (args[i] === "--max-review" && args[i + 1]) {
      maxReviewAttempts = parseInt(args[++i], 10);
    } else if (args[i] === "--skip-worktree") {
      skipWorktree = true;
    } else if (args[i] === "--skip-pr") {
      skipPr = true;
    } else if (args[i] === "--force-triage") {
      forceTriage = true;
    } else if (!args[i].startsWith("--")) {
      featureDescription = args[i];
    }
  }

  if (!featureDescription) { console.error("Error: Feature description required."); process.exit(1); }
  if (!projectPath) { console.error("Error: --project required."); process.exit(1); }

  return {
    projectPath,
    featureDescription,
    maxVerifyAttempts,
    maxReviewAttempts,
    maxPhaseIterations: DEFAULT_CONFIG.maxPhaseIterations,
    skipWorktree,
    skipPr,
    forceTriage,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────

function extractVerificationResult(text: string): VerificationResult | null {
  const match = text.match(/VERIFICATION_RESULT:\s*(\{[\s\S]*?\n\})/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

function extractReviewResult(text: string): ReviewResult | null {
  const match = text.match(/REVIEW_RESULT:\s*(\{[\s\S]*?\n\})/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

function extractFailureClass(text: string): "implementation_bug" | "spec_gap" | "infra_issue" | null {
  const match = text.match(/FAILURE_CLASS:\s*(implementation_bug|spec_gap|infra_issue)/i);
  return (match?.[1]?.toLowerCase() as "implementation_bug" | "spec_gap" | "infra_issue") ?? null;
}

function extractFailureDiagnosis(text: string): string {
  const match = text.match(/FAILURE_DIAGNOSIS:\s*(.+?)(?=\n\n|\nFAILURE_CLASS|\nFIXES_APPLIED|$)/s);
  return match?.[1]?.trim() ?? "[no diagnosis provided]";
}

function extractTriageResult(text: string): TriageResult | null {
  const match = text.match(/TRIAGE_RESULT:\s*(\{[\s\S]*?\n\})/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

interface SpecTestResult {
  stubs_generated: number;
  gaps: string[];
  coverage_pct: number;
}

function extractSpecTestResult(text: string): SpecTestResult | null {
  const match = text.match(/SPEC_TEST_RESULT:\s*(\{[\s\S]*?\n\})/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

function extractLearnedPatterns(text: string): string[] {
  const match = text.match(/LEARNED_PATTERNS:\s*(\{[\s\S]*?\n\})/);
  if (!match) return [];
  try {
    const result = JSON.parse(match[1]);
    return Array.isArray(result.patterns) ? result.patterns : [];
  } catch { return []; }
}

interface ConsolidationResult {
  consolidated_patterns: string[];
  cross_project_candidates: string[];
  removed_count: number;
  merged_count: number;
}

function extractConsolidationResult(text: string): ConsolidationResult | null {
  const match = text.match(/CONSOLIDATION_RESULT:\s*(\{[\s\S]*?\n\})/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

function extractRetroResult(text: string): RetroResult | null {
  const match = text.match(/RETRO_RESULT:\s*(\{[\s\S]*?\n\})/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

function extractTrendsResult(text: string): TrendsResult | null {
  const match = text.match(/TRENDS_RESULT:\s*(\{[\s\S]*?\n\})/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

interface ValidatorResult {
  passed: boolean;
  blocking_issues: string[];
  warnings: string[];
}

function extractValidatorResult(text: string): ValidatorResult | null {
  const match = text.match(/VALIDATOR_RESULT:\s*(\{[\s\S]*?\n\})/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

interface PairFeedback {
  overall: "PASS" | "NEEDS_CORRECTION";
  findings: Array<{ severity: "critical" | "major" | "minor"; description: string; location: string; suggestion: string }>;
}

function extractPairFeedback(text: string): PairFeedback | null {
  const match = text.match(/PAIR_FEEDBACK:\s*(\{[\s\S]*?\n\})/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

// ─── Pair Review ──────────────────────────────────────────────────
// Opus-as-coach: reviews the stage artifact and emits PAIR_FEEDBACK.
// If overall=NEEDS_CORRECTION (critical findings): Sonnet applies one correction pass.
// Pair review runs AFTER the stage gate passes — it's a quality layer on top of correctness.
// Selective: only stages with pair_review.enabled=true in contracts.json participate.

async function runPairReview(
  stageName: PairStage,
  contract: StageContract,
  ctx: PipelineContext,
): Promise<void> {
  if (!contract.pair_review?.enabled) return;

  // Gather artifact for Opus to review
  const artifact = await getPairArtifact(stageName, ctx);

  console.log("  Running Opus pair review...");
  const coachResult = await runPhase("pair-coach", "Review this artifact now.", {
    model: "opus",
    systemPrompt: buildPairCoachPrompt(stageName, artifact, ctx.featureName),
    projectPath: ctx.workingPath,
    fileCache: ctx.fileCache,
    onAuditEvent: makeAuditCallback(ctx, "pair-coach", "pair-coach"),
  });
  logAndTrack(ctx, coachResult, "pair-coach", "pair-coach");

  const feedback = extractPairFeedback(coachResult.text);

  if (!feedback || feedback.overall === "PASS") {
    console.log("  ✓ Pair review: PASS");
    return;
  }

  const criticalCount = feedback.findings.filter(f => f.severity === "critical").length;
  const majorCount    = feedback.findings.filter(f => f.severity === "major").length;
  const minorCount    = feedback.findings.filter(f => f.severity === "minor").length;
  console.log(`  ⚠ Pair review: ${criticalCount} critical / ${majorCount} major / ${minorCount} minor`);
  if (majorCount > 0) console.log(`    major findings will be carried to next stage as context`);

  // One Sonnet correction pass for critical findings only
  console.log("  Running Sonnet pair correction...");
  const correctionResult = await runPhase("pair-correction", "Apply the critical feedback now.", {
    model: contract.model,  // sonnet
    systemPrompt: buildPairCorrectionPrompt(stageName, JSON.stringify(feedback, null, 2), ctx.featureName),
    projectPath: ctx.workingPath,
    fileCache: ctx.fileCache,
    onAuditEvent: makeAuditCallback(ctx, "pair-correction", "pair-correction"),
  });
  logAndTrack(ctx, correctionResult, "pair-correction", "pair-correction");
  console.log(`  ✓ Pair correction applied (${criticalCount} critical finding(s) addressed)`);
}

async function getPairArtifact(stageName: PairStage, ctx: PipelineContext): Promise<string> {
  if (stageName === "specify") {
    return readFileSync(resolve(ctx.workingPath, `specs/${ctx.featureName}/spec.md`), "utf-8");
  }
  if (stageName === "implement") {
    return ctx.lastImplementDiff ?? "[diff unavailable — no task commits found]";
  }
  // verify: pair review checks whether the spec's edge cases are tested; spec is the source of truth
  return readFileSync(resolve(ctx.workingPath, `specs/${ctx.featureName}/spec.md`), "utf-8");
}

function sanitizeFeatureName(desc: string): string {
  return desc.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 50);
}

// ─── Pipeline Context ─────────────────────────────────────────────

type ModelUsage = Record<"sonnet" | "opus" | "haiku", { input_tokens: number; output_tokens: number; tool_calls: number }>;

interface PipelineContext {
  featureName: string;
  featureDescription: string;
  projectPath: string;
  workingPath: string;           // mutable: updated to worktree path after worktree creation
  modelUsage: ModelUsage;
  maxVerifyOverride?: number;    // CLI override for contracts.verify.fix_loop.max_attempts
  maxReviewOverride?: number;    // CLI override for contracts.review.fix_loop.max_attempts
  lastImplementDiff?: string;    // accumulated git diff after implement stage (for pair review)
  firstPassDiff?: string;        // (11.1) diff after first implement pass, before fix loops
  fileCache: Map<string, string>;  // (9.3) per-run read_file cache; invalidated on write/edit
  codemapContent?: string;         // (9.1) codebase-map.md injected into implement + verify
  forceTriage: boolean;            // (9.2) --force-triage: proceed even if complexity=critical
  // (10) two-layer memory
  memoryManager: MemoryManager;
  projectMemory: ProjectMemory;
  userMemory: UserMemory;
  // (12) observability
  logger: RunLogger;
}

function trackUsage(ctx: PipelineContext, result: PhaseResult): void {
  const b = ctx.modelUsage[result.model];
  b.input_tokens += result.usage.input_tokens;
  b.output_tokens += result.usage.output_tokens;
  b.tool_calls += result.usage.tool_calls;
}

// (12.1) Log phase result to run.log and accumulate model usage.
// Replaces bare trackUsage() calls — keeps logging co-located with tracking.
function logAndTrack(
  ctx: PipelineContext,
  result: PhaseResult,
  phaseName: string,
  agentId: string,
  extra?: Partial<RunLogEntry>,
): void {
  trackUsage(ctx, result);
  ctx.logger.logPhase({
    run_id:        ctx.logger.runId,
    phase:         phaseName,
    agent:         agentId,
    model:         result.model,
    started_at:    result.started_at,
    elapsed_ms:    result.elapsed_ms,
    input_tokens:  result.usage.input_tokens,
    output_tokens: result.usage.output_tokens,
    tool_calls:    result.usage.tool_calls,
    outcome:       "pass",
    ...extra,
  });
}

// (12.2) Build the onAuditEvent callback for a phase call.
// The callback closes over run_id, phase, and agent — the caller provides these.
function makeAuditCallback(
  ctx: PipelineContext,
  phaseName: string,
  agentId: string,
): (event: { seq: number; ts: string; tool: string; params_summary: string; result_summary: string; outcome: "ok" | "error" }) => void {
  return (partial) =>
    ctx.logger.logAuditEvent({
      run_id: ctx.logger.runId,
      phase:  phaseName,
      agent:  agentId,
      ...partial,
    } as AuditEvent);
}

// ─── Agent Prompt Router ──────────────────────────────────────────
// Maps agent IDs from contracts.json to prompt builder functions.
// To add a new agent: register it here and in contracts.json.

function buildAgentPrompt(agentId: string, ctx: PipelineContext): string {
  switch (agentId) {
    case "spec-generator":        return buildSpecifyPrompt(ctx.featureDescription, ctx.projectPath);
    case "plan-generator":        return buildPlanPrompt(ctx.featureName);
    case "task-decomposer":       return buildTasksPrompt(ctx.featureName);
    case "verification-engine":   return buildVerifyPrompt(ctx.featureName, ctx.codemapContent, ctx.projectMemory.conventions || undefined);
    case "adversarial-reviewer":  return buildReviewPrompt(ctx.featureName);
    default: throw new Error(`No prompt builder registered for agent: ${agentId}`);
  }
}

// ─── Gate Evaluation ─────────────────────────────────────────────

interface GateResult {
  pass: boolean;
  failureCount: number;
  output: VerificationResult | ReviewResult | null;
}

// (4.3) haiku-validator: semantic gate check, opt-in per stage via contract.gate.validator.
// Reads stage artifacts via tools and verifies the checks list semantically.
// Fail-safe: if VALIDATOR_RESULT is missing, the gate passes (never block on validator failure).
async function runHaikuValidatorGate(
  stageName: string,
  checks: string[],
  ctx: PipelineContext,
): Promise<{ passed: boolean; blockingIssues: string[] }> {
  console.log("  Running haiku-validator gate check...");
  const result = await runPhase(`gate-validate-${stageName}`, "Validate this artifact now.", {
    model: "haiku",
    systemPrompt: buildHaikuValidatorPrompt(stageName, checks, ctx.featureName),
    projectPath: ctx.workingPath,
    fileCache: ctx.fileCache,
    maxIterations: 5,
    onAuditEvent: makeAuditCallback(ctx, `gate-validate-${stageName}`, "haiku-validator"),
  });
  logAndTrack(ctx, result, `gate-validate-${stageName}`, "haiku-validator");

  const validatorResult = extractValidatorResult(result.text);
  if (!validatorResult) {
    console.warn("  ⚠ VALIDATOR_RESULT not found — gate passes by default");
    return { passed: true, blockingIssues: [] };
  }
  if (validatorResult.warnings.length > 0) {
    for (const w of validatorResult.warnings) console.log(`  ⚠ validator: ${w}`);
  }
  return { passed: validatorResult.passed, blockingIssues: validatorResult.blocking_issues };
}

async function evaluateGate(stageName: string, contract: StageContract, result: PhaseResult, ctx: PipelineContext): Promise<GateResult> {
  if (stageName === "verify") {
    const vr = extractVerificationResult(result.text);
    if (vr?.status === "PASS") return { pass: true, failureCount: 0, output: vr };
    return { pass: false, failureCount: vr?.findings?.length ?? 0, output: vr };
  }
  if (stageName === "review") {
    const rr = extractReviewResult(result.text);
    const critical = rr?.issues?.filter(i => i.severity === "critical").length ?? 0;
    const major = rr?.issues?.filter(i => i.severity === "major").length ?? 0;
    const minor = rr?.issues?.filter(i => i.severity === "minor").length ?? 0;
    if (major > 0) console.log(`  ⚠ ${major} major finding(s) — non-blocking, will appear in PR`);
    if (minor > 0) console.log(`  ℹ ${minor} minor finding(s) — logged as learning signal`);
    if (critical === 0) return { pass: true, failureCount: 0, output: rr };
    return { pass: false, failureCount: critical, output: rr };
  }
  // Mechanical gate with optional semantic validator (4.3)
  if (contract.gate.validator) {
    const { passed, blockingIssues } = await runHaikuValidatorGate(stageName, contract.gate.checks ?? [], ctx);
    if (!passed) {
      for (const issue of blockingIssues) console.error(`  ✗ validator: ${issue}`);
      return { pass: false, failureCount: blockingIssues.length, output: null };
    }
    console.log("  ✓ haiku-validator: gate passed");
  }
  return { pass: true, failureCount: 0, output: null };
}

// ─── Stage Runner ─────────────────────────────────────────────────

async function runStage(
  stageName: string,
  contract: StageContract,
  ctx: PipelineContext,
  maxAttemptsOverride?: number,
): Promise<void> {
  const maxAttempts = maxAttemptsOverride ?? contract.fix_loop?.max_attempts ?? 1;
  const hasLoop = maxAttempts > 1;
  let lastFailureCount = Infinity;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (hasLoop) console.log(`  Attempt ${attempt}/${maxAttempts}...`);

    const result = await runPhase(stageName, "Execute your mission now.", {
      model: contract.model,
      systemPrompt: buildAgentPrompt(contract.agent, ctx),
      projectPath: ctx.workingPath,
      fileCache: ctx.fileCache,
      onAuditEvent: makeAuditCallback(ctx, stageName, contract.agent),
      ...(stageName === "implement" ? { maxIterations: 50 } : {}),
    });
    logAndTrack(ctx, result, stageName, contract.agent);

    const gate = await evaluateGate(stageName, contract, result, ctx);

    if (gate.pass) {
      console.log(`  ✓ ${stageName} passed (${result.usage.output_tokens} tokens)`);
      return;
    }

    console.log(`  ✗ ${stageName} failed (${gate.failureCount} findings)`);

    // delta_check: abort if failures increased — regression means fixes are making things worse
    if (contract.fix_loop?.delta_check && gate.failureCount > lastFailureCount) {
      throw new Error(
        `[${stageName}] Failures regressed: ${lastFailureCount} → ${gate.failureCount}. Escalating.`,
      );
    }
    lastFailureCount = gate.failureCount;

    if (attempt >= maxAttempts) {
      throw new Error(
        `[${stageName}] Max attempts (${maxAttempts}) exhausted with ${gate.failureCount} findings. Escalating.`,
      );
    }

    // Fix-engine pass between attempts
    const findings = gate.output ? JSON.stringify(gate.output, null, 2) : "[no structured output]";
    const fixSource = stageName === "verify" ? "verification" : "review" as const;
    const classifyFailure = contract.fix_loop?.classify_failure ?? false;
    console.log(`  Running fix-engine${classifyFailure ? " (with classification)" : ""}...`);
    const fixResult = await runPhase("fix", "Fix all failures now.", {
      model: contract.model,
      systemPrompt: buildFixPrompt(ctx.featureName, findings, fixSource, attempt, classifyFailure),
      projectPath: ctx.workingPath,
      fileCache: ctx.fileCache,
      onAuditEvent: makeAuditCallback(ctx, "fix", "fix-engine"),
    });
    logAndTrack(ctx, fixResult, "fix", "fix-engine", { outcome: "fix_loop" });

    // Classification gate — only when classify_failure=true (verify stage)
    if (classifyFailure) {
      const failureClass = extractFailureClass(fixResult.text);
      if (failureClass === "spec_gap") {
        throw new SpecGapError(extractFailureDiagnosis(fixResult.text));
      }
      if (failureClass === "infra_issue") {
        throw new InfraIssueError(extractFailureDiagnosis(fixResult.text));
      }
      // implementation_bug: fix was applied above, loop continues to next verify attempt
    }
  }
}

// ─── Infrastructure Stages ────────────────────────────────────────

async function runWorktreeStage(ctx: PipelineContext, skipWorktree: boolean): Promise<WorktreeStartResult | null> {
  if (skipWorktree) {
    console.log("  Skipped (--skip-worktree)");
    return null;
  }
  try {
    const result = await worktreeStart(ctx.projectPath, ctx.featureName);
    ctx.workingPath = result.worktreePath;  // update context for downstream stages
    console.log(`  ✓ Worktree: ${result.worktreePath}`);
    console.log(`  ✓ Branch: ${result.branchName}`);
    const { execSync } = await import("node:child_process");
    for (const dir of ["specs", ".sdd", "docs"]) {
      execSync(
        `cp -r "${ctx.projectPath}/${dir}" "${result.worktreePath}/${dir}" 2>/dev/null || true`,
        { shell: process.platform === "win32" ? "bash" : "/bin/bash" },
      );
    }
    return result;
  } catch (err) {
    console.warn(`  ⚠ Worktree failed: ${(err as Error).message} — continuing in main repo`);
    return null;
  }
}

// ─── Codebase Index Stage (9.1) ───────────────────────────────────
// Haiku explores the project structure and writes codebase-map.md.
// The map is stored in ctx.codemapContent and injected into implement + verify prompts.

async function runCodebaseIndexStage(ctx: PipelineContext): Promise<void> {
  const result = await runPhase("codebase-index", "Index this codebase now.", {
    model: "haiku",
    systemPrompt: buildCodebaseIndexPrompt(ctx.featureName),
    projectPath: ctx.workingPath,
    fileCache: ctx.fileCache,
    maxIterations: 10,
    onAuditEvent: makeAuditCallback(ctx, "codebase-index", "codebase-indexer"),
  });
  logAndTrack(ctx, result, "codebase-index", "codebase-indexer");

  try {
    const mapPath = resolve(ctx.workingPath, `specs/${ctx.featureName}/codebase-map.md`);
    ctx.codemapContent = readFileSync(mapPath, "utf-8");
    const lineCount = ctx.codemapContent.split("\n").length;
    console.log(`  ✓ codebase-map.md (${lineCount} lines)`);
  } catch {
    console.warn("  ⚠ codebase-map.md not found — implement/verify will run without codemap");
  }

  // (10.1) Init project memory from codebase-map if it doesn't exist yet
  if (!ctx.projectMemory.conventions && ctx.codemapContent) {
    const projectName = ctx.projectPath.split(/[/\\]/).pop() ?? "project";
    ctx.memoryManager.initProjectMemory(projectName, ctx.codemapContent);
    ctx.projectMemory = ctx.memoryManager.readProjectMemory();
    console.log("  ✓ project memory initialized from codebase-map");
  }
}

// ─── Triage Stage (9.2) ───────────────────────────────────────────
// Haiku estimates complexity before the full pipeline runs.
// critical complexity → CriticalComplexityError unless --force-triage.

async function runTriageStage(ctx: PipelineContext): Promise<void> {
  const result = await runPhase("triage", "Triage this feature now.", {
    model: "haiku",
    systemPrompt: buildTriagePrompt(
      ctx.featureName,
      ctx.featureDescription,
      ctx.projectMemory.runHistory || undefined,
      ctx.userMemory.agentPerformanceLog || undefined,
    ),
    projectPath: ctx.workingPath,
    fileCache: ctx.fileCache,
    maxIterations: 5,
    onAuditEvent: makeAuditCallback(ctx, "triage", "triage-engine"),
  });
  logAndTrack(ctx, result, "triage", "triage-engine");

  const triage = extractTriageResult(result.text);
  if (!triage) {
    console.warn("  ⚠ TRIAGE_RESULT not found in output — continuing");
    return;
  }

  const icon = { low: "✓", medium: "⚠", high: "✗", critical: "✗" }[triage.complexity] ?? "?";
  console.log(`  ${icon} complexity=${triage.complexity}  tasks≈${triage.estimated_tasks}  files≈${triage.estimated_files}  regression=${triage.regression_risk}  ~${(triage.estimated_tokens / 1000).toFixed(0)}k tokens`);
  console.log(`    ${triage.reason}`);

  if (triage.complexity === "critical" && !ctx.forceTriage) {
    throw new CriticalComplexityError(triage);
  }
  if (triage.complexity === "high") {
    console.log("  ⚠ High complexity — consider breaking into smaller features");
  }
}

// ─── Spec Test Stage (9.4) ────────────────────────────────────────
// Haiku generates test stubs from spec.md before implementation.
// Gaps are logged as warnings — does not block the pipeline.

async function runSpecTestStage(ctx: PipelineContext): Promise<void> {
  const result = await runPhase("spec-test", "Generate test stubs now.", {
    model: "haiku",
    systemPrompt: buildSpecTestPrompt(ctx.featureName),
    projectPath: ctx.workingPath,
    fileCache: ctx.fileCache,
    maxIterations: 8,
    onAuditEvent: makeAuditCallback(ctx, "spec-test", "spec-tester"),
  });
  logAndTrack(ctx, result, "spec-test", "spec-tester");

  const specTest = extractSpecTestResult(result.text);
  if (!specTest) {
    console.warn("  ⚠ SPEC_TEST_RESULT not found — spec-test output incomplete");
    return;
  }

  console.log(`  ✓ ${specTest.stubs_generated} stubs generated (${specTest.coverage_pct}% spec coverage)`);
  if (specTest.gaps.length > 0) {
    console.log(`  ⚠ ${specTest.gaps.length} spec gap(s) detected:`);
    for (const gap of specTest.gaps) {
      console.log(`    - ${gap}`);
    }
    console.log("    Non-blocking — review specs or proceed and address during implementation.");
  }
}

// ─── Implement Stage (per-task) ───────────────────────────────────
// One fresh PTC loop per task. Each task gets: its own definition + spec.md + codemap.
// A local commit is created after each successful task for granular rollback.

async function runImplementStage(contract: StageContract, ctx: PipelineContext): Promise<void> {
  const tasksPath = resolve(ctx.workingPath, `specs/${ctx.featureName}/tasks.md`);
  const tasks = parseTasks(readFileSync(tasksPath, "utf-8"));

  if (tasks.length === 0) throw new Error("[implement] No tasks found in tasks.md");
  console.log(`  ${tasks.length} tasks to implement`);

  const { execSync } = await import("node:child_process");
  let successfulCommits = 0;

  for (const task of tasks) {
    console.log(`  → ${task.id}: ${task.title}`);

    const result = await runPhase("implement", "Execute this task now.", {
      model: contract.model,
      systemPrompt: buildImplementTaskPrompt(
        ctx.featureName,
        task.raw,
        ctx.codemapContent,
        ctx.projectMemory.conventions || undefined,
        ctx.projectMemory.learnedPatterns || undefined,
      ),
      projectPath: ctx.workingPath,
      fileCache: ctx.fileCache,
      onAuditEvent: makeAuditCallback(ctx, "implement", "implementation-engine"),
    });
    logAndTrack(ctx, result, "implement", "implementation-engine");

    // Commit per task (local only — pushed later by git-operator)
    try {
      execSync(`git -C "${ctx.workingPath}" add -A`, { stdio: "pipe" });
      execSync(
        `git -C "${ctx.workingPath}" commit -m "task(${ctx.featureName}): ${task.id} — ${task.title.slice(0, 50)}"`,
        { stdio: "pipe" },
      );
      console.log(`    ✓ committed ${task.id}`);
      successfulCommits++;
    } catch {
      // Commit failure is non-fatal — files are still on disk
      console.warn(`    ⚠ commit skipped for ${task.id} (no changes or git error)`);
    }
  }

  // Capture accumulated diff for pair review (capped at ~3000 tokens for Opus context budget)
  if (successfulCommits > 0) {
    try {
      const rawDiff = execSync(
        `git -C "${ctx.workingPath}" diff HEAD~${successfulCommits}`,
        { stdio: "pipe" },
      ).toString();
      ctx.lastImplementDiff = rawDiff.slice(0, 12000);
    } catch {
      ctx.lastImplementDiff = "[diff unavailable]";
    }
  }
  // (11.1) Snapshot first-pass diff — fix loops may overwrite lastImplementDiff later
  ctx.firstPassDiff ??= ctx.lastImplementDiff;

  console.log(`  ✓ implement passed (${tasks.length} tasks)`);
}

// ─── Implement Stage (parallel waves) ────────────────────────────
// Computes dependency waves from task graph. Runs each wave in parallel via Promise.all.
// Tasks within a wave are independent by definition (no shared dependsOn).
// One commit per wave (after all parallel tasks complete).
// Star topology: agents write to isolated file scopes; orchestrator sequences waves.

async function runParallelWavesStage(contract: StageContract, ctx: PipelineContext): Promise<void> {
  const tasksPath = resolve(ctx.workingPath, `specs/${ctx.featureName}/tasks.md`);
  const tasks = parseTasks(readFileSync(tasksPath, "utf-8"));

  if (tasks.length === 0) throw new Error("[implement] No tasks found in tasks.md");

  const waves = computeWaves(tasks);
  const messageBudget = contract.wave_config?.message_budget ?? 3;
  console.log(`  ${tasks.length} tasks in ${waves.length} wave(s) (budget: ${messageBudget} msgs/wave)`);

  const { execSync } = await import("node:child_process");
  let totalWaveCommits = 0;

  for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
    const wave = waves[waveIdx];
    console.log(`  Wave ${waveIdx + 1}/${waves.length}: ${wave.map(t => t.id).join(", ")}`);

    // Parallel execution — all tasks in this wave have no inter-dependencies
    await Promise.all(wave.map(async (task) => {
      console.log(`    → ${task.id}: ${task.title}`);
      const result = await runPhase("implement", "Execute this task now.", {
        model: contract.model,
        systemPrompt: buildImplementTaskPrompt(
          ctx.featureName,
          task.raw,
          ctx.codemapContent,
          ctx.projectMemory.conventions || undefined,
          ctx.projectMemory.learnedPatterns || undefined,
        ),
        projectPath: ctx.workingPath,
        fileCache: ctx.fileCache,
        onAuditEvent: makeAuditCallback(ctx, "implement", "implementation-engine"),
      });
      logAndTrack(ctx, result, "implement", "implementation-engine");
      console.log(`    ✓ ${task.id} done`);
    }));

    // One atomic commit per wave (after all parallel tasks complete)
    try {
      execSync(`git -C "${ctx.workingPath}" add -A`, { stdio: "pipe" });
      const taskIds = wave.map(t => t.id).join(", ");
      execSync(
        `git -C "${ctx.workingPath}" commit -m "wave_${waveIdx + 1}(${ctx.featureName}): [${taskIds}]"`,
        { stdio: "pipe" },
      );
      console.log(`    ✓ committed wave ${waveIdx + 1}`);
      totalWaveCommits++;
    } catch {
      console.warn(`    ⚠ commit skipped for wave ${waveIdx + 1} (no changes or git error)`);
    }
  }

  // Capture accumulated diff for pair review
  if (totalWaveCommits > 0) {
    try {
      const rawDiff = execSync(
        `git -C "${ctx.workingPath}" diff HEAD~${totalWaveCommits}`,
        { stdio: "pipe" },
      ).toString();
      ctx.lastImplementDiff = rawDiff.slice(0, 12000);
    } catch {
      ctx.lastImplementDiff = "[diff unavailable]";
    }
  }
  // (11.1) Snapshot first-pass diff — fix loops may overwrite lastImplementDiff later
  ctx.firstPassDiff ??= ctx.lastImplementDiff;

  console.log(`  ✓ implement passed (${tasks.length} tasks in ${waves.length} waves)`);
}

async function runGitOperatorStage(
  ctx: PipelineContext,
  worktreeResult: WorktreeStartResult | null,
  skipPr: boolean,
): Promise<void> {
  if (skipPr) { console.log("  Skipped (--skip-pr)"); return; }
  if (!worktreeResult) { console.log("  No worktree — skipping PR"); return; }
  const pr = await worktreeFinish(ctx.workingPath, ctx.featureName, ctx.featureDescription);
  console.log(`  ✓ PR: ${pr.prUrl}`);
  console.log(`  ✓ Diff: ${pr.diffStats.split("\n").pop()}`);
}

// ─── Memory Update Stage (10.2) ───────────────────────────────────
// Runs after a successful pipeline. Haiku extracts learned patterns from the final diff.
// Appends patterns to project memory and records a run history entry.

async function runMemoryUpdateStage(
  ctx: PipelineContext,
  runResult: "merged" | "escalated" | "critical_complexity" | "spec_gap" | "infra_issue",
  costStr: string,
  fixLoops: number,
): Promise<void> {
  console.log("\n▶ MEMORY UPDATE — memory-agent");

  // Append run history first (always, regardless of diff availability)
  const entry: RunHistoryEntry = {
    feature: ctx.featureName,
    date: new Date().toISOString().slice(0, 10),
    cost: costStr,
    fix_loops: fixLoops,
    result: runResult,
  };
  ctx.memoryManager.appendRunHistory(entry);
  console.log(`  ✓ run history updated (${entry.date}, ${costStr}, result=${runResult})`);

  // Extract learned patterns from diff + spec (only on successful merges with a diff)
  const diff = ctx.lastImplementDiff;
  if (!diff || runResult !== "merged") return;

  let specContent = "";
  try {
    specContent = readFileSync(resolve(ctx.workingPath, `specs/${ctx.featureName}/spec.md`), "utf-8");
  } catch { return; }

  const result = await runPhase("memory-update", "Extract learned patterns now.", {
    model: "haiku",
    systemPrompt: buildMemoryUpdatePrompt(ctx.featureName, diff, specContent),
    projectPath: ctx.workingPath,
    fileCache: ctx.fileCache,
    maxIterations: 3,
    onAuditEvent: makeAuditCallback(ctx, "memory-update", "memory-agent"),
  });
  logAndTrack(ctx, result, "memory-update", "memory-agent");

  const patterns = extractLearnedPatterns(result.text);
  if (patterns.length > 0) {
    ctx.memoryManager.appendLearnedPatterns(patterns);
    console.log(`  ✓ ${patterns.length} pattern(s) learned`);
    for (const p of patterns) console.log(`    · ${p.slice(0, 80)}${p.length > 80 ? "…" : ""}`);
  } else {
    console.log("  ✓ no new patterns extracted");
  }
}

// ─── Memory Consolidate Stage (10.4) ──────────────────────────────
// Runs every 10 runs per project. Opus cleans duplicates, resolves contradictions,
// promotes cross-project patterns to user memory.

async function runMemoryConsolidateStage(ctx: PipelineContext): Promise<void> {
  console.log("\n▶ MEMORY CONSOLIDATE — memory-agent (Opus)");
  const projectName = ctx.projectPath.split(/[/\\]/).pop() ?? "project";
  const { learnedPatterns, runHistory } = ctx.memoryManager.readProjectMemory();

  const result = await runPhase("memory-consolidate", "Consolidate project memory now.", {
    model: "opus",
    systemPrompt: buildMemoryConsolidatePrompt(projectName, learnedPatterns, runHistory),
    projectPath: ctx.workingPath,
    fileCache: ctx.fileCache,
    maxIterations: 3,
    onAuditEvent: makeAuditCallback(ctx, "memory-consolidate", "memory-agent"),
  });
  logAndTrack(ctx, result, "memory-consolidate", "memory-agent");

  const consolidation = extractConsolidationResult(result.text);
  if (!consolidation) {
    console.warn("  ⚠ CONSOLIDATION_RESULT not found — memory unchanged");
    return;
  }

  // Replace learned patterns with consolidated set
  const numbered = consolidation.consolidated_patterns.map((p, i) => {
    const id = String(i + 1).padStart(3, "0");
    return `<!-- PATTERN-${id}: consolidated -->\n${p.trim()}`;
  }).join("\n\n");
  ctx.memoryManager.replaceLearnedPatterns(numbered);

  // Promote cross-project candidates to user memory
  for (const pattern of consolidation.cross_project_candidates) {
    ctx.memoryManager.appendCrossProjectPattern(pattern);
  }

  console.log(`  ✓ consolidated: ${consolidation.consolidated_patterns.length} patterns kept, ${consolidation.removed_count} removed, ${consolidation.merged_count} merged`);
  if (consolidation.cross_project_candidates.length > 0) {
    console.log(`  ✓ ${consolidation.cross_project_candidates.length} pattern(s) promoted to user memory`);
  }
}

// ─── Decay Stage (11.4) ───────────────────────────────────────────
// Synchronous. Ticks TTLs for learned patterns and exploration entries at the start of each run.
// Patterns in TTL format are removed when ttl reaches 0; exploration entries are marked expired.

function runDecayStage(ctx: PipelineContext): void {
  const removedPatterns   = ctx.memoryManager.tickPatternTTLs();
  const expiredExperiments = ctx.memoryManager.tickExplorationTTLs();
  if (removedPatterns > 0 || expiredExperiments > 0) {
    console.log(`▶ DECAY — ${removedPatterns} pattern(s) expired, ${expiredExperiments} experiment(s) expired`);
  }
}

// ─── Immediate Retro Stage (11.1) ────────────────────────────────
// Haiku compares the first-pass implement diff with the final diff (post fix loops).
// clean_merge=true if identical. Otherwise: root cause analysis, learnings → project memory.

async function runImmediateRetroStage(ctx: PipelineContext): Promise<void> {
  console.log("\n▶ RETRO IMMEDIATE — retro-agent (Haiku)");
  if (!ctx.firstPassDiff || !ctx.lastImplementDiff) {
    console.log("  Skipped — no diff available");
    return;
  }

  let specContent = "";
  try {
    specContent = readFileSync(resolve(ctx.workingPath, `specs/${ctx.featureName}/spec.md`), "utf-8");
  } catch { /* proceed without spec */ }

  const result = await runPhase("retro-immediate", "Run retrospective now.", {
    model: "haiku",
    systemPrompt: buildRetroImmediatePrompt(
      ctx.featureName,
      ctx.firstPassDiff,
      ctx.lastImplementDiff,
      specContent,
    ),
    projectPath: ctx.workingPath,
    fileCache: ctx.fileCache,
    maxIterations: 3,
    onAuditEvent: makeAuditCallback(ctx, "retro-immediate", "retro-agent"),
  });
  logAndTrack(ctx, result, "retro-immediate", "retro-agent");

  const retro = extractRetroResult(result.text);
  if (!retro) {
    console.warn("  ⚠ RETRO_RESULT not found — retro skipped");
    return;
  }

  const cleanTag = retro.clean_merge ? "✓ clean merge" : `✗ ${retro.human_changes_count} correction(s)`;
  console.log(`  ${cleanTag}`);
  if (retro.delta_summary) console.log(`    ${retro.delta_summary}`);

  ctx.memoryManager.appendRetroEntry(retro, ctx.featureName);

  if (retro.learnings.length > 0) {
    const freshRunCount = ctx.memoryManager.readProjectMemory().runCount;
    ctx.memoryManager.appendLearnedPatterns(retro.learnings, freshRunCount);
    console.log(`  ✓ ${retro.learnings.length} retro learning(s) added to project memory`);
    for (const l of retro.learnings) console.log(`    · ${l.slice(0, 80)}${l.length > 80 ? "…" : ""}`);
  }
}

// ─── Trends Retro Stage (11.2/11.3) ──────────────────────────────
// Opus runs every 5 clean merges per project. Finds recurring patterns across retros
// and proposes one bounded exploration experiment (with hard guardrails).

async function runTrendsRetroStage(ctx: PipelineContext): Promise<void> {
  console.log("\n▶ RETRO TRENDS — meta-agent (Opus)");
  const projectName = ctx.projectPath.split(/[/\\]/).pop() ?? "project";
  const mem = ctx.memoryManager.readProjectMemory();
  const explorationLog = ctx.memoryManager.readExplorationLog();

  const result = await runPhase("retro-trends", "Run trends retrospective now.", {
    model: "opus",
    systemPrompt: buildRetroTrendsPrompt(
      projectName,
      mem.retroHistory,
      mem.learnedPatterns,
      explorationLog,
      mem.runCount,
    ),
    projectPath: ctx.workingPath,
    fileCache: ctx.fileCache,
    maxIterations: 5,
    onAuditEvent: makeAuditCallback(ctx, "retro-trends", "meta-agent"),
  });
  logAndTrack(ctx, result, "retro-trends", "meta-agent");

  const trends = extractTrendsResult(result.text);
  if (!trends) {
    console.warn("  ⚠ TRENDS_RESULT not found — trends retro skipped");
    return;
  }

  if (trends.meta_learnings.length > 0) {
    const freshRunCount = ctx.memoryManager.readProjectMemory().runCount;
    ctx.memoryManager.appendLearnedPatterns(trends.meta_learnings, freshRunCount);
    console.log(`  ✓ ${trends.meta_learnings.length} meta-learning(s) added to project memory`);
  }

  for (const adj of trends.agent_adjustments) {
    ctx.memoryManager.appendAgentPerformanceNote(adj.agent, adj.observation);
  }
  if (trends.agent_adjustments.length > 0) {
    console.log(`  ✓ ${trends.agent_adjustments.length} agent adjustment(s) recorded`);
  }

  if (trends.exploration_proposal) {
    const proposal = trends.exploration_proposal;
    const freshMem = ctx.memoryManager.readProjectMemory();
    const expCount = (ctx.memoryManager.readExplorationLog().match(/^<!-- EXP-/gm) ?? []).length;
    const entry: ExplorationEntry = {
      ...proposal,
      id: String(expCount + 1).padStart(3, "0"),
      added_at_run: freshMem.runCount,
      runs_remaining: proposal.ttl_runs,
      status: "active",
    };
    ctx.memoryManager.appendExplorationEntry(entry);
    console.log(`  ✓ exploration proposal logged (EXP-${entry.id}, ttl=${entry.runs_remaining} runs)`);
    console.log(`    target=${entry.target}  metric=${entry.metric}`);
    console.log(`    hypothesis: ${entry.hypothesis.slice(0, 80)}${entry.hypothesis.length > 80 ? "…" : ""}`);
  }
}

// ─── Pipeline Runner ──────────────────────────────────────────────
// Follows the `next` chain in contracts.json. No hardcoded stage order.
// Adding or reordering stages requires only contracts.json changes.

async function runPipeline(
  contracts: PipelineContracts,
  ctx: PipelineContext,
  skipWorktree: boolean,
  skipPr: boolean,
): Promise<void> {
  let stageName: string | null = "codebase-index";
  let worktreeResult: WorktreeStartResult | null = null;

  while (stageName !== null) {
    const contract: StageContract = contracts.contracts[stageName];
    if (!contract) throw new Error(`No contract found for stage: ${stageName}`);

    console.log(`\n▶ ${stageName.toUpperCase()} — ${contract.agent}`);

    if (contract.agent === "codebase-indexer") {
      await runCodebaseIndexStage(ctx);
    } else if (contract.agent === "triage-engine") {
      await runTriageStage(ctx);
    } else if (contract.agent === "spec-tester") {
      await runSpecTestStage(ctx);
    } else if (contract.agent === "worktree-manager") {
      worktreeResult = await runWorktreeStage(ctx, skipWorktree);
    } else if (contract.agent === "implementation-engine") {
      if (contract.execution === "parallel_waves") {
        await runParallelWavesStage(contract, ctx);
      } else {
        await runImplementStage(contract, ctx);   // per_task: sequential (default)
      }
    } else if (contract.agent === "git-operator") {
      await runGitOperatorStage(ctx, worktreeResult, skipPr);
    } else {
      const maxOverride =
        stageName === "verify" ? ctx.maxVerifyOverride :
        stageName === "review" ? ctx.maxReviewOverride :
        undefined;
      await runStage(stageName, contract, ctx, maxOverride);
    }

    // Pair review — runs after stage completes (gate already passed)
    // Only for stages with pair_review.enabled=true in contracts.json
    if (contract.pair_review?.enabled && stageName !== null) {
      await runPairReview(stageName as PairStage, contract, ctx);
    }

    stageName = contract.next;
  }
}

// ─── Main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  const contracts = loadContracts();
  const featureName = sanitizeFeatureName(args.featureDescription);
  const modelUsage: ModelUsage = {
    sonnet: { input_tokens: 0, output_tokens: 0, tool_calls: 0 },
    opus:   { input_tokens: 0, output_tokens: 0, tool_calls: 0 },
    haiku:  { input_tokens: 0, output_tokens: 0, tool_calls: 0 },
  };

  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║         SDD AUTOPILOT v2 PIPELINE                ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`Feature:  ${args.featureDescription}`);
  console.log(`Project:  ${args.projectPath}`);
  console.log(`Name:     ${featureName}`);
  console.log(`Pipeline: ${contracts.pipeline} v${contracts.version}`);
  console.log();

  // (10) Memory — load both layers before the pipeline starts
  const memoryManager = new MemoryManager(args.projectPath);
  memoryManager.initUserMemory();
  const projectMemory = memoryManager.readProjectMemory();
  const userMemory    = memoryManager.readUserMemory();

  // (12) Observability — one RunLogger per run; creates .sdd/run.log and .sdd/audit.log
  const logger = new RunLogger(args.projectPath, featureName);

  const ctx: PipelineContext = {
    featureName,
    featureDescription: args.featureDescription,
    projectPath: args.projectPath,
    workingPath: args.projectPath,
    modelUsage,
    maxVerifyOverride: args.maxVerifyAttempts !== DEFAULT_CONFIG.maxVerifyAttempts
      ? args.maxVerifyAttempts : undefined,
    maxReviewOverride: args.maxReviewAttempts !== DEFAULT_CONFIG.maxReviewAttempts
      ? args.maxReviewAttempts : undefined,
    fileCache: new Map(),
    forceTriage: args.forceTriage,
    memoryManager,
    projectMemory,
    userMemory,
    logger,
  };

  // Hoisted so the catch block can emit state diagnostics
  const stateManager = new StateManager(args.projectPath);

  try {
    console.log("▶ INIT");
    if (!(await stateManager.exists())) {
      const projectName = args.projectPath.split(/[/\\]/).pop() ?? "project";
      await stateManager.init(projectName);
      console.log("  Created .sdd/state.json");
    }

    // (11.4) Decay — tick TTLs at start of each run (before the pipeline touches memory)
    runDecayStage(ctx);

    await runPipeline(contracts, ctx, args.skipWorktree, args.skipPr);

    // (10) Post-run memory update — extract patterns, record run history
    const totalCost = computeTotalCost(modelUsage);
    const costStr = `$${totalCost.toFixed(2)}`;
    const fixLoops =
      (ctx as any)._fixLoopCount ?? 0;  // tracked below; 0 if not available
    await runMemoryUpdateStage(ctx, "merged", costStr, fixLoops);

    // (11.1) Immediate retro — compare first-pass vs final diff, extract learnings
    if (ctx.firstPassDiff) {
      await runImmediateRetroStage(ctx);
    }

    // Consolidate every 10 runs
    const updatedRunCount = ctx.memoryManager.readProjectMemory().runCount;
    if (updatedRunCount > 0 && updatedRunCount % 10 === 0) {
      await runMemoryConsolidateStage(ctx);
    }

    // (11.2) Trends retro — every 5 clean merges, Opus meta-analysis + bounded exploration
    const freshMemory = ctx.memoryManager.readProjectMemory();
    if (freshMemory.cleanMergeCount > 0 && freshMemory.cleanMergeCount % 5 === 0) {
      await runTrendsRetroStage(ctx);
    }

    console.log("\n╔══════════════════════════════════════════════════╗");
    console.log("║          PIPELINE COMPLETE ✓                     ║");
    console.log("╚══════════════════════════════════════════════════╝");
    printUsage(modelUsage);

  } catch (err) {
    if (err instanceof SpecGapError) {
      console.error("\n╔══════════════════════════════════════════════════╗");
      console.error("║    SPEC GAP DETECTED — AWAITING HUMAN INPUT       ║");
      console.error("╚══════════════════════════════════════════════════╝");
      console.error("\nThe pipeline cannot converge because the spec is incomplete or ambiguous.");
      console.error("\nDiagnosis:");
      console.error(err.diagnosis);
      console.error("\nNext step: Clarify the spec and re-run. The working directory is preserved.");
      if (ctx.workingPath !== args.projectPath) {
        console.error(`Working directory: ${ctx.workingPath}`);
      }
      printUsage(modelUsage);
      process.exit(2);  // 2 = spec_gap (awaiting_input)

    } else if (err instanceof InfraIssueError) {
      console.error("\n╔══════════════════════════════════════════════════╗");
      console.error("║    INFRA ISSUE — ESCALATING TO HUMAN              ║");
      console.error("╚══════════════════════════════════════════════════╝");
      console.error("\nTest infrastructure, environment, or dependencies are broken.");
      console.error("\nDiagnosis:");
      console.error(err.diagnosis);
      console.error("\nNext step: Fix the environment issue and re-run. No implementation changes were made.");
      if (ctx.workingPath !== args.projectPath) {
        console.error(`Working directory: ${ctx.workingPath}`);
      }
      printUsage(modelUsage);
      process.exit(3);  // 3 = infra_issue (escalated)

    } else if (err instanceof CriticalComplexityError) {
      console.error("\n╔══════════════════════════════════════════════════╗");
      console.error("║   CRITICAL COMPLEXITY — HUMAN REVIEW REQUIRED     ║");
      console.error("╚══════════════════════════════════════════════════╝");
      console.error("\nTriage estimated this feature exceeds safe autopilot scope.");
      console.error(`\nComplexity:  ${err.triage.complexity}`);
      console.error(`Tasks:       ~${err.triage.estimated_tasks}`);
      console.error(`Files:       ~${err.triage.estimated_files}`);
      console.error(`Regression:  ${err.triage.regression_risk}`);
      console.error(`\nReason: ${err.triage.reason}`);
      console.error("\nOptions:");
      console.error("  1. Break the feature into smaller, focused pieces.");
      console.error("  2. Re-run with --force-triage to proceed anyway.");
      printUsage(modelUsage);
      process.exit(4);  // 4 = critical_complexity

    } else {
      console.error("\n╔══════════════════════════════════════════════════╗");
      console.error("║       PIPELINE ERROR — ESCALATING TO HUMAN       ║");
      console.error("╚══════════════════════════════════════════════════╝");
      console.error((err as Error).message);
      if (ctx.workingPath !== args.projectPath) {
        console.error(`Working directory preserved: ${ctx.workingPath}`);
      }
      printUsage(modelUsage);
      process.exit(1);  // 1 = generic escalation
    }
  }
}

// ─── Cost Reporting ───────────────────────────────────────────────

function computeTotalCost(usage: ModelUsage): number {
  return (
    (usage.sonnet.input_tokens / 1_000_000) * PRICING.sonnet.input +
    (usage.sonnet.output_tokens / 1_000_000) * PRICING.sonnet.output +
    (usage.opus.input_tokens / 1_000_000) * PRICING.opus.input +
    (usage.opus.output_tokens / 1_000_000) * PRICING.opus.output +
    (usage.haiku.input_tokens / 1_000_000) * PRICING.haiku.input +
    (usage.haiku.output_tokens / 1_000_000) * PRICING.haiku.output
  );
}

function printUsage(usage: ModelUsage): void {
  const sonnetCost =
    (usage.sonnet.input_tokens / 1_000_000) * PRICING.sonnet.input +
    (usage.sonnet.output_tokens / 1_000_000) * PRICING.sonnet.output;
  const opusCost =
    (usage.opus.input_tokens / 1_000_000) * PRICING.opus.input +
    (usage.opus.output_tokens / 1_000_000) * PRICING.opus.output;
  const haikuCost =
    (usage.haiku.input_tokens / 1_000_000) * PRICING.haiku.input +
    (usage.haiku.output_tokens / 1_000_000) * PRICING.haiku.output;

  console.log("\nToken usage:");
  console.log(`  Sonnet: ${usage.sonnet.input_tokens.toLocaleString()} in / ${usage.sonnet.output_tokens.toLocaleString()} out → $${sonnetCost.toFixed(2)}`);
  console.log(`  Opus:   ${usage.opus.input_tokens.toLocaleString()} in / ${usage.opus.output_tokens.toLocaleString()} out → $${opusCost.toFixed(2)}`);
  console.log(`  Haiku:  ${usage.haiku.input_tokens.toLocaleString()} in / ${usage.haiku.output_tokens.toLocaleString()} out → $${haikuCost.toFixed(2)}`);
  console.log(`  Tools:  ${(usage.sonnet.tool_calls + usage.opus.tool_calls + usage.haiku.tool_calls)} calls`);
  console.log(`  Est. cost: ~$${computeTotalCost(usage).toFixed(2)}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
