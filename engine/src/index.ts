#!/usr/bin/env node

// SDD Autopilot — CLI entry point + pipeline orchestrator
// Single Node.js process with multiple agentic loops (one per phase)
// Phases share state through filesystem (.sdd/state.json, specs/, code files)

import { resolve } from "node:path";
import { StateManager } from "./state.js";
import { runPhase } from "./phase.js";
import { worktreeStart, worktreeFinish, type WorktreeStartResult } from "./git.js";
import { buildSpecifyPrompt } from "./prompts/specify.js";
import { buildPlanPrompt } from "./prompts/plan.js";
import { buildTasksPrompt } from "./prompts/tasks.js";
import { buildImplementPrompt } from "./prompts/implement.js";
import { buildVerifyPrompt } from "./prompts/verify.js";
import { buildReviewPrompt } from "./prompts/review.js";
import { buildFixPrompt } from "./prompts/fix.js";
import { DEFAULT_CONFIG, PRICING, type PipelineConfig, type VerificationResult, type ReviewResult } from "./types.js";

// ─── CLI Argument Parsing ────────────────────────────────────────

function parseArgs(): PipelineConfig {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    console.log(`
SDD Autopilot — Autonomous specify → plan → tasks → implement → verify → review → PR pipeline

Usage:
  sdd-autopilot "<feature description>" --project <path> [options]

Arguments:
  <feature description>    Description of the feature to implement (in quotes)

Options:
  --project <path>         Path to the project root (required)
  --max-verify <n>         Max verification attempts (default: ${DEFAULT_CONFIG.maxVerifyAttempts})
  --max-review <n>         Max review attempts (default: ${DEFAULT_CONFIG.maxReviewAttempts})
  --skip-worktree          Skip git worktree creation (work in place)
  --skip-pr                Skip PR creation at the end
  --help, -h               Show this help message

Example:
  sdd-autopilot "Add a health check endpoint" --project /path/to/my-project
`);
    process.exit(0);
  }

  // Find feature description (first non-flag argument)
  let featureDescription = "";
  let projectPath = "";
  let maxVerifyAttempts = DEFAULT_CONFIG.maxVerifyAttempts;
  let maxReviewAttempts = DEFAULT_CONFIG.maxReviewAttempts;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) {
      projectPath = resolve(args[i + 1]);
      i++;
    } else if (args[i] === "--max-verify" && args[i + 1]) {
      maxVerifyAttempts = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--max-review" && args[i + 1]) {
      maxReviewAttempts = parseInt(args[i + 1], 10);
      i++;
    } else if (!args[i].startsWith("--")) {
      featureDescription = args[i];
    }
  }

  if (!featureDescription) {
    console.error("Error: Feature description is required.");
    process.exit(1);
  }
  if (!projectPath) {
    console.error("Error: --project <path> is required.");
    process.exit(1);
  }

  return {
    projectPath,
    featureDescription,
    maxVerifyAttempts,
    maxReviewAttempts,
    maxPhaseIterations: DEFAULT_CONFIG.maxPhaseIterations,
  };
}

// ─── Result Extractors ───────────────────────────────────────────

function extractVerificationResult(text: string): VerificationResult | null {
  const match = text.match(/VERIFICATION_RESULT:\s*(\{[\s\S]*?\n\})/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    // Try to determine status from text
    if (text.includes('"status": "PASS"') || text.includes('"status":"PASS"')) {
      return { status: "PASS", findings: [], tests_total: 0, tests_passed: 0, tests_failed: 0, spec_coverage_pct: 100, regression_clean: true, constitution_clean: true };
    }
    return null;
  }
}

function extractReviewResult(text: string): ReviewResult | null {
  const match = text.match(/REVIEW_RESULT:\s*(\{[\s\S]*?\n\})/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    if (text.includes('"decision": "APPROVE"') || text.includes('"decision":"APPROVE"')) {
      return { decision: "APPROVE", issues: [], warnings: [], summary: "Approved" };
    }
    return null;
  }
}

function sanitizeFeatureName(desc: string): string {
  return desc
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 50);
}

// ─── Pipeline ────────────────────────────────────────────────────

async function main() {
  const config = parseArgs();
  const skipWorktree = process.argv.includes("--skip-worktree");
  const skipPr = process.argv.includes("--skip-pr");

  const featureName = sanitizeFeatureName(config.featureDescription);
  let workingPath = config.projectPath;
  let worktreeResult: WorktreeStartResult | null = null;

  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║            SDD AUTOPILOT PIPELINE                ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`Feature: ${config.featureDescription}`);
  console.log(`Project: ${config.projectPath}`);
  console.log(`Feature name: ${featureName}`);
  console.log();

  const modelUsage = {
    sonnet: { input_tokens: 0, output_tokens: 0, tool_calls: 0 },
    opus:   { input_tokens: 0, output_tokens: 0, tool_calls: 0 },
  };

  function trackUsage(result: { model: "opus" | "sonnet"; usage: { input_tokens: number; output_tokens: number; tool_calls: number } }) {
    const bucket = modelUsage[result.model];
    bucket.input_tokens += result.usage.input_tokens;
    bucket.output_tokens += result.usage.output_tokens;
    bucket.tool_calls += result.usage.tool_calls;
  }

  try {
    // ── Phase 0: Initialize state ──────────────────────────────
    console.log("Phase 0: Initializing state...");
    const stateManager = new StateManager(config.projectPath);
    if (!(await stateManager.exists())) {
      const projectName = config.projectPath.split(/[/\\]/).pop() ?? "project";
      await stateManager.init(projectName);
      console.log("  Created .sdd/state.json");
    }

    // ── Phase 1: SPECIFY (Sonnet) ────────────────────────────────
    console.log("\n▶ Phase 1: SPECIFY");
    const specResult = await runPhase("specify", "Generate the specification now.", {
      model: "sonnet",
      systemPrompt: buildSpecifyPrompt(config.featureDescription, config.projectPath),
      projectPath: config.projectPath,
    });
    trackUsage(specResult);
    console.log(`  ✓ Spec generated (${specResult.usage.output_tokens} tokens)`);

    // ── Phase 2: PLAN (Sonnet) ───────────────────────────────────
    console.log("\n▶ Phase 2: PLAN");
    const planResult = await runPhase("plan", "Generate the technical plan and ADR now.", {
      model: "sonnet",
      systemPrompt: buildPlanPrompt(featureName),
      projectPath: config.projectPath,
    });
    trackUsage(planResult);
    console.log(`  ✓ Plan generated (${planResult.usage.output_tokens} tokens)`);

    // ── Phase 3: TASKS (Sonnet) ──────────────────────────────────
    console.log("\n▶ Phase 3: TASKS");
    const tasksResult = await runPhase("tasks", "Decompose the plan into tasks now.", {
      model: "sonnet",
      systemPrompt: buildTasksPrompt(featureName),
      projectPath: config.projectPath,
    });
    trackUsage(tasksResult);
    console.log(`  ✓ Tasks decomposed (${tasksResult.usage.output_tokens} tokens)`);

    // ── Phase 4: WORKTREE START ────────────────────────────────
    if (!skipWorktree) {
      console.log("\n▶ Phase 4: WORKTREE START");
      try {
        worktreeResult = await worktreeStart(config.projectPath, featureName);
        workingPath = worktreeResult.worktreePath;
        console.log(`  ✓ Worktree created at ${worktreeResult.worktreePath}`);
        console.log(`  ✓ Branch: ${worktreeResult.branchName}`);

        // Copy specs to worktree (they were generated in main repo)
        // The worktree is a git checkout so it already has the committed files
        // But the specs were written to the filesystem, not committed — need to copy
        const { execSync } = await import("node:child_process");
        execSync(`cp -r "${config.projectPath}/specs" "${workingPath}/specs" 2>/dev/null || true`, {
          shell: process.platform === "win32" ? "bash" : "/bin/bash",
        });
        execSync(`cp -r "${config.projectPath}/.sdd" "${workingPath}/.sdd" 2>/dev/null || true`, {
          shell: process.platform === "win32" ? "bash" : "/bin/bash",
        });
        execSync(`cp -r "${config.projectPath}/docs" "${workingPath}/docs" 2>/dev/null || true`, {
          shell: process.platform === "win32" ? "bash" : "/bin/bash",
        });
      } catch (err) {
        console.warn(`  ⚠ Worktree creation failed: ${(err as Error).message}`);
        console.warn("  Continuing in main project directory...");
      }
    } else {
      console.log("\n▶ Phase 4: WORKTREE START (skipped)");
    }

    // ── Phase 5: IMPLEMENT (Sonnet) ─────────────────────────────
    console.log("\n▶ Phase 5: IMPLEMENT");
    const implResult = await runPhase("implement", "Implement all tasks now.", {
      model: "sonnet",
      systemPrompt: buildImplementPrompt(featureName),
      projectPath: workingPath,
      maxIterations: 50, // Implementation may need more iterations
    });
    trackUsage(implResult);
    console.log(`  ✓ Implementation complete (${implResult.usage.output_tokens} tokens, ${implResult.usage.tool_calls} tool calls)`);

    // ── Phase 6: VERIFICATION LOOP (Sonnet) ────────────────────
    console.log("\n▶ Phase 6: VERIFICATION");
    let verificationPassed = false;

    for (let attempt = 1; attempt <= config.maxVerifyAttempts; attempt++) {
      console.log(`  Attempt ${attempt}/${config.maxVerifyAttempts}...`);

      const verifyResult = await runPhase("verify", "Run the full verification now.", {
        model: "sonnet",
        systemPrompt: buildVerifyPrompt(featureName),
        projectPath: workingPath,
      });
      trackUsage(verifyResult);

      const verification = extractVerificationResult(verifyResult.text);
      if (verification?.status === "PASS") {
        verificationPassed = true;
        console.log("  ✓ Verification PASSED");
        break;
      }

      console.log(`  ✗ Verification FAILED (${verification?.findings?.length ?? 0} findings)`);

      if (attempt < config.maxVerifyAttempts) {
        // Fix and retry
        const findings = verification?.findings
          ? JSON.stringify(verification.findings, null, 2)
          : verifyResult.text.slice(-2000); // Fallback: use last 2000 chars

        console.log("  Applying fixes...");
        const fixResult = await runPhase("fix", "Fix the verification failures now.", {
          model: "sonnet",
          systemPrompt: buildFixPrompt(featureName, findings, "verification", attempt),
          projectPath: workingPath,
        });
        trackUsage(fixResult);
      }
    }

    if (!verificationPassed) {
      console.error("\n╔══════════════════════════════════════════════════╗");
      console.error("║  VERIFICATION FAILED — ESCALATING TO HUMAN       ║");
      console.error("╚══════════════════════════════════════════════════╝");
      console.error(`Max attempts (${config.maxVerifyAttempts}) exhausted.`);
      console.error(`Working directory: ${workingPath}`);
      printUsage(modelUsage);
      process.exit(1);
    }

    // ── Phase 7: PR REVIEW LOOP (Opus) ─────────────────────────
    console.log("\n▶ Phase 7: PR REVIEW");
    let reviewApproved = false;

    for (let attempt = 1; attempt <= config.maxReviewAttempts; attempt++) {
      console.log(`  Attempt ${attempt}/${config.maxReviewAttempts}...`);

      const reviewResult = await runPhase("review", "Review the implementation now.", {
        model: "opus",
        systemPrompt: buildReviewPrompt(featureName),
        projectPath: workingPath,
      });
      trackUsage(reviewResult);

      const review = extractReviewResult(reviewResult.text);
      if (review?.decision === "APPROVE") {
        reviewApproved = true;
        console.log("  ✓ Review APPROVED");
        if (review.warnings?.length) {
          console.log(`  ⚠ ${review.warnings.length} warning(s) noted`);
        }
        break;
      }

      const blockingIssues = review?.issues?.filter(i => i.severity === "blocking") ?? [];
      console.log(`  ✗ Review REQUEST_CHANGES (${blockingIssues.length} blocking issue(s))`);

      if (attempt < config.maxReviewAttempts) {
        const issues = review?.issues
          ? JSON.stringify(review.issues, null, 2)
          : reviewResult.text.slice(-2000);

        console.log("  Applying fixes...");
        const fixResult = await runPhase("fix", "Fix the review issues now.", {
          model: "opus",
          systemPrompt: buildFixPrompt(featureName, issues, "review", attempt),
          projectPath: workingPath,
        });
        trackUsage(fixResult);
      }
    }

    if (!reviewApproved) {
      console.error("\n╔══════════════════════════════════════════════════╗");
      console.error("║  REVIEW FAILED — ESCALATING TO HUMAN             ║");
      console.error("╚══════════════════════════════════════════════════╝");
      console.error(`Max attempts (${config.maxReviewAttempts}) exhausted.`);
      console.error(`Working directory: ${workingPath}`);
      printUsage(modelUsage);
      process.exit(1);
    }

    // ── Phase 8: WORKTREE FINISH ───────────────────────────────
    if (!skipPr && worktreeResult) {
      console.log("\n▶ Phase 8: WORKTREE FINISH");
      try {
        const prResult = await worktreeFinish(
          workingPath,
          featureName,
          config.featureDescription,
        );
        console.log(`  ✓ PR created: ${prResult.prUrl}`);
        console.log(`  ✓ Diff: ${prResult.diffStats.split("\n").pop()}`);
      } catch (err) {
        console.error(`  ✗ PR creation failed: ${(err as Error).message}`);
        console.error(`  Working directory preserved at: ${workingPath}`);
      }
    } else if (!skipPr && !worktreeResult) {
      console.log("\n▶ Phase 8: WORKTREE FINISH (skipped — no worktree)");
      console.log("  Implementation is in: " + workingPath);
    } else {
      console.log("\n▶ Phase 8: PR CREATION (skipped)");
    }

    // ── Done ───────────────────────────────────────────────────
    console.log("\n╔══════════════════════════════════════════════════╗");
    console.log("║            PIPELINE COMPLETE ✓                   ║");
    console.log("╚══════════════════════════════════════════════════╝");
    printUsage(modelUsage);

  } catch (err) {
    console.error("\n╔══════════════════════════════════════════════════╗");
    console.error("║            PIPELINE ERROR                        ║");
    console.error("╚══════════════════════════════════════════════════╝");
    console.error((err as Error).message);
    if (workingPath !== config.projectPath) {
      console.error(`Working directory preserved at: ${workingPath}`);
    }
    printUsage(modelUsage);
    process.exit(1);
  }
}

type ModelUsage = Record<"sonnet" | "opus", { input_tokens: number; output_tokens: number; tool_calls: number }>;

function printUsage(usage: ModelUsage) {
  const totalInput = usage.sonnet.input_tokens + usage.opus.input_tokens;
  const totalOutput = usage.sonnet.output_tokens + usage.opus.output_tokens;
  const totalTools = usage.sonnet.tool_calls + usage.opus.tool_calls;

  const sonnetCost =
    (usage.sonnet.input_tokens / 1_000_000) * PRICING.sonnet.input +
    (usage.sonnet.output_tokens / 1_000_000) * PRICING.sonnet.output;
  const opusCost =
    (usage.opus.input_tokens / 1_000_000) * PRICING.opus.input +
    (usage.opus.output_tokens / 1_000_000) * PRICING.opus.output;
  const totalCost = sonnetCost + opusCost;

  console.log(`\nToken usage:`);
  console.log(`  Sonnet: ${usage.sonnet.input_tokens.toLocaleString()} in / ${usage.sonnet.output_tokens.toLocaleString()} out → $${sonnetCost.toFixed(2)}`);
  console.log(`  Opus:   ${usage.opus.input_tokens.toLocaleString()} in / ${usage.opus.output_tokens.toLocaleString()} out → $${opusCost.toFixed(2)}`);
  console.log(`  Total:  ${totalInput.toLocaleString()} in / ${totalOutput.toLocaleString()} out / ${totalTools} tool calls`);
  console.log(`  Est. cost: ~$${totalCost.toFixed(2)}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
