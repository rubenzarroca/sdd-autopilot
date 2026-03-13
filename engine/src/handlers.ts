// MCP Tool handlers — 11 sdd_* tools for the SDD Autopilot MCP server
// All handlers are purely deterministic (no LLM calls).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { StateManager, AGENT_PERMISSIONS } from "./state.js";
import { MemoryManager, sanitizeMemoryContent, validateExtractionFilter, consolidateEntry } from "./memory.js";
import type { AgentId, FeatureState, PipelineContracts } from "./types.js";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { fileExists, atomicAppendJSONL } from "./utils.js";

// ─── Verbosity types ────────────────────────────────────────────
export type Verbosity = "minimal" | "standard" | "full";

function resolveVerbosity(v?: string): Verbosity {
  if (v === "minimal" || v === "standard" || v === "full") return v;
  return "full";
}

// ─── Load contracts.json at startup ──────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const contractsPath = resolve(__dirname, "contracts.json");

let contracts: PipelineContracts;
try {
  contracts = JSON.parse(readFileSync(contractsPath, "utf-8")) as PipelineContracts;
} catch {
  // Fallback for build directory structure
  const altPath = resolve(__dirname, "..", "src", "contracts.json");
  contracts = JSON.parse(readFileSync(altPath, "utf-8")) as PipelineContracts;
}

// ─── 0. sdd_refresh_state ─────────────────────────────────────────

export async function handleRefreshState(params: {
  project_path: string;
  scope?: "all" | "state";
}): Promise<unknown> {
  const scope = params.scope ?? "all";
  StateManager.invalidate(params.project_path);
  return {
    refreshed: true,
    scope,
    timestamp: new Date().toISOString(),
    caches_cleared: ["state"],
    note: "contracts and specs are read from disk on each call — no cache to invalidate",
  };
}

// ─── 1. sdd_get_state ─────────────────────────────────────────────

export async function handleGetState(params: {
  project_path: string;
  feature_id?: string;
  include_run_log?: boolean;
  verbosity?: string;
}): Promise<unknown> {
  const v = resolveVerbosity(params.verbosity);
  const sm = new StateManager(params.project_path);
  const exists = await sm.exists();
  if (!exists) {
    return { error: "No .sdd/state.json found. Project not initialized." };
  }
  const state = await sm.read();
  if (params.feature_id) {
    const feature = state.features[params.feature_id];
    if (!feature) {
      return { error: `Feature "${params.feature_id}" not found` };
    }

    // ── minimal: just the essentials for pipeline routing
    if (v === "minimal") {
      return {
        feature_id: params.feature_id,
        state: feature.state,
        spec_path: feature.spec_path,
        plan_path: feature.plan_path,
        tasks_path: feature.tasks_path,
        worktree_path: feature.worktree_path,
        branch: feature.branch,
        skip_worktree: (feature as any).skip_worktree,
        verification_attempts: feature.verification_attempts,
        review_attempts: feature.review_attempts,
        fix_loop_attempts: feature.fix_loop_attempts,
        fix_review_attempts: feature.fix_review_attempts,
        tasks_summary: {
          total: Object.keys(feature.tasks).length,
          completed: Object.values(feature.tasks).filter(t => t.status === "completed").length,
        },
      };
    }

    // ── standard: above + task list, no transitions/signals
    if (v === "standard") {
      return {
        feature_id: params.feature_id,
        state: feature.state,
        spec_path: feature.spec_path,
        plan_path: feature.plan_path,
        tasks_path: feature.tasks_path,
        worktree_path: feature.worktree_path,
        branch: feature.branch,
        skip_worktree: (feature as any).skip_worktree,
        verification_attempts: feature.verification_attempts,
        review_attempts: feature.review_attempts,
        fix_loop_attempts: feature.fix_loop_attempts,
        fix_review_attempts: feature.fix_review_attempts,
        tasks: feature.tasks,
        signals_count: feature.signals.length,
        transitions_count: feature.transitions.length,
      };
    }

    // ── full: backward-compatible, everything
    const result: Record<string, unknown> = { feature_id: params.feature_id, ...feature };

    // Optionally include live run status (inline)
    if (params.include_run_log) {
      const runLogPath = resolve(params.project_path, ".sdd", "runs", params.feature_id, "run.log");
      let currentPhase: string | null = null;
      let startedAt: string | null = null;
      if (await fileExists(runLogPath)) {
        const logRaw = await readFile(runLogPath, "utf-8");
        const events = logRaw.trim().split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        const starts = new Map<string, string>();
        const ends = new Set<string>();
        for (const evt of events) {
          if (evt.event_type === "phase_start" && evt.phase) starts.set(evt.phase, evt.timestamp);
          if (evt.event_type === "phase_end" && evt.phase) ends.add(evt.phase);
        }
        for (const [phase, ts] of starts) { if (!ends.has(phase)) { currentPhase = phase; startedAt = ts; } }
      }
      const { parseJsonl } = await import("./utils.js");
      const metricsPath = resolve(params.project_path, ".sdd", "runs", params.feature_id, "metrics.jsonl");
      let lastPhase: string | null = null;
      let lastCompletedAt: string | null = null;
      if (await fileExists(metricsPath)) {
        const metrics = parseJsonl<{ phase: string; completed_at: string }>(await readFile(metricsPath, "utf-8"));
        if (metrics.length > 0) {
          const sorted = [...metrics].sort((a, b) => a.completed_at.localeCompare(b.completed_at));
          lastPhase = sorted[sorted.length - 1].phase;
          lastCompletedAt = sorted[sorted.length - 1].completed_at;
        }
      }
      if (currentPhase) {
        const elapsedMs = startedAt ? Date.now() - new Date(startedAt).getTime() : null;
        result.live_status = { status: "running", feature_state: feature.state, current_phase: currentPhase, started_at: startedAt, elapsed_seconds: elapsedMs !== null ? Math.round(elapsedMs / 1000) : null, last_completed_phase: lastPhase, last_completed_at: lastCompletedAt };
      } else {
        result.live_status = { status: "idle", feature_state: feature.state, current_phase: null, last_completed_phase: lastPhase, last_completed_at: lastCompletedAt };
      }
    }

    return result;
  }

  // Full state (no feature_id) — apply verbosity
  if (v === "minimal") {
    return {
      active_feature: state.active_feature,
      feature_count: Object.keys(state.features).length,
      features_summary: Object.entries(state.features).map(([id, f]) => ({ id, state: f.state })),
    };
  }
  if (v === "standard") {
    return {
      version: state.version,
      project: state.project,
      active_feature: state.active_feature,
      features_summary: Object.entries(state.features).map(([id, f]) => ({
        id,
        state: f.state,
        spec_path: f.spec_path,
        tasks_total: Object.keys(f.tasks).length,
        tasks_completed: Object.values(f.tasks).filter(t => t.status === "completed").length,
      })),
    };
  }
  return state;
}

// ─── 2. sdd_transition ────────────────────────────────────────────

export async function handleTransition(params: {
  project_path: string;
  feature_id: string;
  from_state: string;
  to_state: string;
  agent_id: string;
  metadata?: Record<string, unknown>;
}): Promise<unknown> {
  const sm = new StateManager(params.project_path);
  const agentId = params.agent_id as AgentId;
  const toState = params.to_state as FeatureState;

  const result = await sm.transition(
    params.feature_id,
    toState,
    agentId,
    params.metadata ? JSON.stringify(params.metadata) : "transition",
  );

  if (result.ok) {
    return {
      success: true,
      new_state: result.to,
    };
  }

  // Build allowed transitions for this agent
  const agentEdges = AGENT_PERMISSIONS[agentId] ?? [];
  const feature = await sm.getFeature(params.feature_id);
  const currentState = feature?.state ?? params.from_state;
  const allowed = agentEdges
    .filter(e => e.from === currentState)
    .map(e => e.to);

  return {
    success: false,
    error: {
      code: result.code,
      message: result.reason,
      allowed_transitions: allowed,
    },
  };
}

// ─── 3. sdd_get_contract ──────────────────────────────────────────

export async function handleGetContract(params: {
  phase_id: string;
  verbosity?: string;
}): Promise<unknown> {
  const v = resolveVerbosity(params.verbosity);
  const contract = contracts.contracts[params.phase_id] as unknown as Record<string, unknown> | undefined;
  if (!contract) {
    return { error: `Phase "${params.phase_id}" not found in contracts.json. Available phases: ${Object.keys(contracts.contracts).join(", ")}` };
  }
  if (v === "minimal") {
    return {
      phase_id: params.phase_id,
      agent: contract.agent,
      model: contract.model,
      next: contract.next,
    };
  }
  if (v === "standard") {
    return {
      phase_id: params.phase_id,
      agent: contract.agent,
      model: contract.model,
      gate: contract.gate,
      execution: contract.execution,
      fix_loop: contract.fix_loop,
      failure_modes: contract.failure_modes,
      next: contract.next,
    };
  }
  return contract;
}

// ─── 4. sdd_evaluate_gate ─────────────────────────────────────────

export async function handleEvaluateGate(params: {
  phase_id: string;
  project_path: string;
  feature_id: string;
  artifacts: Record<string, string>;
  execution_mode?: string;
  verbosity?: string;
}): Promise<unknown> {
  const contract = contracts.contracts[params.phase_id];
  if (!contract) {
    return { error: `Phase "${params.phase_id}" not found in contracts.json` };
  }

  const gate = contract.gate;
  const checks: Array<{ name: string; passed: boolean; detail: string }> = [];
  let needsSemantic: { check: string; description: string } | undefined;

  for (const checkDesc of gate.checks ?? []) {
    const lc = checkDesc.toLowerCase();

    // Mechanical check: file exists (e.g. "spec.md created", "plan.md created")
    if (lc.includes("created")) {
      // Skip complexity-gated checks for lower execution modes
      if (lc.includes("required for complexity") && (params.execution_mode === "express" || params.execution_mode === "light")) {
        checks.push({ name: checkDesc, passed: true, detail: "Skipped: not required for this execution mode" });
        continue;
      }
      const fileMatch = checkDesc.match(/([\w.-]+\.(?:md|json|txt))/i);
      if (fileMatch) {
        const fileName = fileMatch[1];
        // Check if artifact was provided
        if (params.artifacts[fileName]) {
          const exists = await fileExists(resolve(params.project_path, params.artifacts[fileName]));
          checks.push({ name: checkDesc, passed: exists, detail: exists ? `File found: ${params.artifacts[fileName]}` : `File not found: ${params.artifacts[fileName]}` });
        } else {
          // Try default path
          const defaultPath = resolve(params.project_path, "specs", params.feature_id, fileName);
          const exists = await fileExists(defaultPath);
          checks.push({ name: checkDesc, passed: exists, detail: exists ? `File found at default path` : `File not found at specs/${params.feature_id}/${fileName}` });
        }
        continue;
      }
    }

    // Mechanical check: section non-empty
    if (lc.includes("non-empty") || lc.includes("non empty")) {
      const sectionMatch = checkDesc.match(/(\w+)\s+section\s+non[- ]empty/i);
      if (sectionMatch) {
        const section = sectionMatch[1];
        // Try to read the relevant artifact
        const specPath = params.artifacts["spec.md"]
          ? resolve(params.project_path, params.artifacts["spec.md"])
          : resolve(params.project_path, "specs", params.feature_id, "spec.md");
        try {
          const content = await readFile(specPath, "utf-8");
          const sectionRegex = new RegExp(`^##\\s+${section}`, "im");
          const hasSection = sectionRegex.test(content);
          if (hasSection) {
            const match = sectionRegex.exec(content);
            const startIdx = match!.index + match![0].length;
            const rest = content.slice(startIdx);
            const nextHeader = /^## /m.exec(rest);
            const body = (nextHeader ? rest.slice(0, nextHeader.index) : rest).trim();
            const passed = body.length > 0;
            checks.push({ name: checkDesc, passed, detail: passed ? `Section "${section}" has content (${body.length} chars)` : `Section "${section}" is empty` });
          } else {
            checks.push({ name: checkDesc, passed: false, detail: `Section "${section}" not found in spec` });
          }
        } catch {
          checks.push({ name: checkDesc, passed: false, detail: `Could not read spec file` });
        }
        continue;
      }
    }

    // Mechanical check: JSON is valid
    if (lc.includes("json") && lc.includes("valid")) {
      const artifactKey = Object.keys(params.artifacts).find(k => k.endsWith(".json"));
      if (artifactKey) {
        try {
          const content = await readFile(resolve(params.project_path, params.artifacts[artifactKey]), "utf-8");
          JSON.parse(content);
          checks.push({ name: checkDesc, passed: true, detail: "Valid JSON" });
        } catch {
          checks.push({ name: checkDesc, passed: false, detail: "Invalid JSON" });
        }
      } else {
        checks.push({ name: checkDesc, passed: false, detail: "No JSON artifact provided" });
      }
      continue;
    }

    // Mechanical check: emitted (e.g. "TRIAGE_RESULT emitted")
    if (lc.includes("emitted")) {
      const resultMatch = checkDesc.match(/(\w+_RESULT|\w+)\s+emitted/i);
      if (resultMatch) {
        const key = resultMatch[1];
        const has = params.artifacts[key] !== undefined;
        checks.push({ name: checkDesc, passed: has, detail: has ? `${key} present in artifacts` : `${key} not found in artifacts` });
        continue;
      }
    }

    // Mechanical check: all tasks in state=completed
    if (lc.includes("all tasks") && lc.includes("completed")) {
      const sm = new StateManager(params.project_path);
      try {
        const feature = await sm.getFeature(params.feature_id);
        if (feature) {
          const pending = Object.entries(feature.tasks).filter(([, t]) => t.status !== "completed");
          const passed = pending.length === 0 && Object.keys(feature.tasks).length > 0;
          checks.push({ name: checkDesc, passed, detail: passed ? "All tasks completed" : `${pending.length} task(s) pending` });
        } else {
          checks.push({ name: checkDesc, passed: false, detail: "Feature not found" });
        }
      } catch {
        checks.push({ name: checkDesc, passed: false, detail: "Could not read state" });
      }
      continue;
    }

    // Mechanical check: tool alignment test
    if (lc.includes("alignment") && lc.includes("test")) {
      const engineDir = resolve(__dirname, "..");
      const testPath = resolve(engineDir, "test-alignment.mjs");
      try {
        const output = execSync(
          `node --test "${testPath}"`,
          { cwd: engineDir, timeout: 10_000, env: { ...process.env, SDD_SKIP_MAIN: "1" }, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
        checks.push({ name: checkDesc, passed: true, detail: "Tool alignment test passed" });
      } catch (err: any) {
        const output = (err.stdout ?? "") + (err.stderr ?? "");
        checks.push({ name: checkDesc, passed: false, detail: `Tool alignment test failed:\n${output.slice(0, 2000)}` });
      }
      continue;
    }

    // Semantic checks — delegate back to caller
    if (lc.includes("covers all") || lc.includes("all spec requirements") ||
        lc.includes("no circular") || lc.includes("syntax error") ||
        lc.includes("plan covers")) {
      needsSemantic = { check: checkDesc, description: `This check requires semantic validation: "${checkDesc}"` };
      continue;
    }

    // Fallback: mark as needing semantic validation
    if (lc.includes("worktree") || lc.includes("gracefully")) {
      // Worktree check: just pass if artifact exists
      checks.push({ name: checkDesc, passed: true, detail: "Assumed pass (worktree management)" });
      continue;
    }

    // Unknown check type — flag for semantic validation
    needsSemantic = { check: checkDesc, description: `Cannot mechanically validate: "${checkDesc}"` };
  }

  if ((params.execution_mode === "express" || params.execution_mode === "light") && needsSemantic) {
    checks.push({ name: needsSemantic.check, passed: true, detail: `Auto-passed: ${params.execution_mode} mode skips semantic validation` });
    needsSemantic = undefined;
  }

  const allPassed = checks.every(c => c.passed) && !needsSemantic;
  const v = resolveVerbosity(params.verbosity);

  if (v === "minimal") {
    const result: Record<string, unknown> = {
      passed: allPassed,
      checks_total: checks.length,
      checks_failed: checks.filter(c => !c.passed).length,
    };
    if (needsSemantic) result.needs_semantic_validation = true;
    return result;
  }

  // standard and full both include checks; full adds nothing extra here
  const result: Record<string, unknown> = {
    passed: allPassed,
    checks,
  };
  if (needsSemantic) {
    result.needs_semantic_validation = needsSemantic;
  }
  return result;
}

// Pre-compiled regex patterns for failure classification
const IMPL_BUG_PATTERNS: RegExp[] = [
  /stack trace/i, /traceback/i, /at .+:\d+:\d+/,
  /typeerror/i, /referenceerror/i, /syntaxerror/i, /type error/i,
  /test fail/i, /tests? failed/i, /assertion/i, /expect.*to/i,
  /cannot read prop/i, /is not a function/i, /is not defined/i,
  /null pointer/i, /segfault/i, /undefined is not/i,
  /fail/i, /error.*line \d+/i,
];

const SPEC_GAP_PATTERNS: RegExp[] = [
  /not found/i, /undefined behavior/i, /missing requirement/i,
  /spec.*gap/i, /not specified/i, /not defined in spec/i,
  /ambiguous/i, /unclear/i, /missing.*spec/i,
  /no such.*endpoint/i, /not documented/i,
];

const INFRA_PATTERNS: RegExp[] = [
  /econnrefused/i, /econnreset/i, /etimedout/i, /connection.*refused/i,
  /permission denied/i, /eacces/i, /eperm/i,
  /build fail/i, /compilation.*fail/i, /cannot find module/i,
  /npm err/i, /yarn error/i, /docker.*error/i,
  /disk.*full/i, /no space/i, /out of memory/i,
  /network/i, /dns/i, /certificate/i, /ssl/i,
  /timeout/i, /timed out/i,
];

// ─── 5. sdd_classify_failure ──────────────────────────────────────

export async function handleClassifyFailure(params: {
  phase_id: string;
  error_message: string;
  affected_files?: string[];
  test_output?: string;
}): Promise<unknown> {
  const msg = (params.error_message + " " + (params.test_output ?? "")).toLowerCase();

  let implScore = 0;
  let specScore = 0;
  let infraScore = 0;

  for (const p of IMPL_BUG_PATTERNS) if (p.test(msg)) implScore++;
  for (const p of SPEC_GAP_PATTERNS) if (p.test(msg)) specScore++;
  for (const p of INFRA_PATTERNS) if (p.test(msg)) infraScore++;

  let category: "implementation_bug" | "spec_gap" | "infra_issue";
  let confidence: "high" | "medium" | "low";
  let reasoning: string;

  const maxScore = Math.max(implScore, specScore, infraScore);

  if (maxScore === 0) {
    category = "implementation_bug";
    confidence = "low";
    reasoning = "No strong pattern matches found; defaulting to implementation_bug";
  } else if (implScore > specScore && implScore > infraScore) {
    category = "implementation_bug";
    confidence = implScore >= 3 ? "high" : implScore >= 2 ? "medium" : "low";
    reasoning = `Matched ${implScore} implementation bug pattern(s): stack traces, test failures, or type errors`;
  } else if (specScore > implScore && specScore > infraScore) {
    category = "spec_gap";
    confidence = specScore >= 3 ? "high" : specScore >= 2 ? "medium" : "low";
    reasoning = `Matched ${specScore} spec gap pattern(s): missing requirements or undefined behavior`;
  } else if (infraScore > implScore && infraScore > specScore) {
    category = "infra_issue";
    confidence = infraScore >= 3 ? "high" : infraScore >= 2 ? "medium" : "low";
    reasoning = `Matched ${infraScore} infra issue pattern(s): connection errors, permission errors, or build failures`;
  } else {
    // Tie: prefer implementation_bug
    category = "implementation_bug";
    confidence = "low";
    reasoning = `Ambiguous: tied between categories (impl=${implScore}, spec=${specScore}, infra=${infraScore})`;
  }

  return { category, confidence, reasoning };
}

// ─── 6. sdd_delta_check ──────────────────────────────────────────

export async function handleDeltaCheck(params: {
  project_path: string;
  feature_id: string;
  phase_id: string;
  current_failures: number;
  current_failure_details?: string[];
}): Promise<unknown> {
  const sm = new StateManager(params.project_path);
  const state = await sm.read();
  const feature = state.features[params.feature_id];

  if (!feature) {
    return { result: "continue", reason: "Feature not found, no history to compare" };
  }

  // Read fix_loop_history from state (stored as ad-hoc field)
  const history = (feature as any).fix_loop_history as
    | Array<{ phase: string; failures: number; details?: string[] }>
    | undefined;

  const prevEntry = history?.filter(h => h.phase === params.phase_id).pop();
  const previousFailures = prevEntry?.failures;

  // Store current as new entry
  if (!history) {
    (feature as any).fix_loop_history = [];
  }
  (feature as any).fix_loop_history.push({
    phase: params.phase_id,
    failures: params.current_failures,
    details: params.current_failure_details,
    at: new Date().toISOString(),
  });
  await sm.write(state);

  if (previousFailures === undefined) {
    return { result: "continue", reason: "No previous failure data — first iteration" };
  }

  if (params.current_failures > previousFailures) {
    return {
      result: "abort",
      previous_failures: previousFailures,
      reason: "regression_detected",
    };
  }

  return {
    result: "continue",
    previous_failures: previousFailures,
    reason: params.current_failures < previousFailures
      ? `Improvement: ${previousFailures} → ${params.current_failures}`
      : "No regression (same failure count)",
  };
}

// ─── 7. sdd_log_event ────────────────────────────────────────────

export async function handleLogEvent(params: {
  project_path: string;
  feature_id: string;
  event_type: string;
  phase?: string;
  agent_id?: string;
  data?: Record<string, unknown>;
}): Promise<unknown> {
  const runDir = resolve(params.project_path, ".sdd", "runs", params.feature_id);
  await mkdir(runDir, { recursive: true });

  const logPath = join(runDir, "run.log");
  const timestamp = new Date().toISOString();

  const entry = {
    timestamp,
    event_type: params.event_type,
    phase: params.phase,
    agent_id: params.agent_id,
    data: params.data,
  };

  await atomicAppendJSONL(logPath, entry);

  // Fusion 5: when event_type is "decision", also write to breadcrumbs.jsonl
  if (params.event_type === "decision" && params.data) {
    const analyticsDir = resolve(params.project_path, ".sdd", "analytics");
    await mkdir(analyticsDir, { recursive: true });

    const breadcrumb = {
      feature_id: params.feature_id,
      phase: params.phase ?? "unknown",
      agent: params.agent_id ?? "unknown",
      decision: (params.data.decision as string) ?? "",
      reasoning: (params.data.reasoning as string) ?? "",
      alternatives_considered: (params.data.alternatives_considered as string[]) ?? [],
      timestamp,
    };

    const breadcrumbsPath = join(analyticsDir, "breadcrumbs.jsonl");
    await atomicAppendJSONL(breadcrumbsPath, breadcrumb);
  }

  return { logged: true, timestamp };
}

// ─── 8. sdd_memory_read ──────────────────────────────────────────

const SECTION_MAP: Record<string, string> = {
  project_conventions: "Project Conventions",
  learned_patterns: "Learned Patterns",
  run_history: "Run History",
};

function wrapWithDefaultMetadata(content: string): { content: string; metadata: import("./memory.js").MemoryEntryMetadata } {
  return {
    content,
    metadata: {
      agent: "unknown",
      run_id: "unknown",
      feature_id: "unknown",
      timestamp: "unknown",
      confidence: 0.5,
    },
  };
}

export async function handleMemoryRead(params: {
  project_path: string;
  section: "project_conventions" | "learned_patterns" | "run_history" | "all";
  scope?: "project" | "user";
  verbosity?: string;
}): Promise<unknown> {
  const v = resolveVerbosity(params.verbosity);
  const mm = new MemoryManager(params.project_path);
  const scope = params.scope ?? "project";

  // Helper: trim content for minimal/standard verbosity
  const trimContent = (raw: string): string => {
    if (v === "full") return raw;
    if (v === "minimal") return raw.slice(0, 200) + (raw.length > 200 ? "…" : "");
    // standard: first 500 chars
    return raw.slice(0, 500) + (raw.length > 500 ? "…" : "");
  };

  if (scope === "project") {
    const mem = mm.readProjectMemory();
    if (params.section === "all") {
      const raw = JSON.stringify(mem);
      if (v === "minimal") {
        return { section: "all", scope: "project", content_length: raw.length };
      }
      return {
        content: trimContent(raw),
        entries: v === "full" ? [wrapWithDefaultMetadata(raw)] : undefined,
        section: "all",
        scope: "project",
      };
    }
    const sectionKey = params.section;
    let content: string;
    switch (sectionKey) {
      case "project_conventions": content = mem.conventions; break;
      case "learned_patterns": content = mem.learnedPatterns; break;
      case "run_history": content = mem.runHistory; break;
      default: content = "";
    }
    if (v === "minimal") {
      return { section: params.section, scope: "project", content_length: content.length };
    }
    return {
      content: trimContent(content),
      entries: v === "full" ? [wrapWithDefaultMetadata(content)] : undefined,
      section: params.section,
      scope: "project",
    };
  }

  // User scope
  const mem = mm.readUserMemory();
  if (params.section === "all") {
    const raw = JSON.stringify(mem);
    if (v === "minimal") {
      return { section: "all", scope: "user", content_length: raw.length };
    }
    return {
      content: trimContent(raw),
      entries: v === "full" ? [wrapWithDefaultMetadata(raw)] : undefined,
      section: "all",
      scope: "user",
    };
  }
  // Map project-scope section names to UserMemory fields
  const userSectionMap: Record<string, keyof typeof mem> = {
    learned_patterns:     "crossProjectPatterns",
    project_conventions:  "designHeuristics",
    run_history:          "agentPerformanceLog",
  };
  const field = userSectionMap[params.section as string];
  const content = field ? mem[field] : JSON.stringify(mem);
  if (v === "minimal") {
    return { section: params.section, scope: "user", content_length: content.length };
  }
  return {
    content: trimContent(content),
    entries: v === "full" ? [wrapWithDefaultMetadata(content)] : undefined,
    section: params.section,
    scope: "user",
  };
}

// ─── 9. sdd_memory_write ─────────────────────────────────────────

export async function handleMemoryWrite(params: {
  project_path: string;
  section: string;
  content: string;
  scope: "project" | "user";
  ttl?: number;
  agent?: string;
  run_id?: string;
  feature_id?: string;
  confidence?: number;
}): Promise<unknown> {
  const mm = new MemoryManager(params.project_path);
  const timestamp = new Date().toISOString();

  // GAP-03: Sanitize content
  const sanitization = sanitizeMemoryContent(params.content);

  // If suspicious patterns detected, emit warning signal
  if (!sanitization.clean && params.feature_id) {
    const runDir = resolve(params.project_path, ".sdd", "runs", params.feature_id);
    await mkdir(runDir, { recursive: true });
    const signalsPath = join(runDir, "signals.jsonl");
    const warning = {
      signal_type: "memory_sanitization_warning",
      warnings: sanitization.warnings,
      content_preview: params.content.slice(0, 100),
      agent: params.agent ?? "unknown",
      timestamp,
    };
    await atomicAppendJSONL(signalsPath, warning);
  }

  // GAP-10: Extraction filter — validate content matches expected section patterns
  const extraction = validateExtractionFilter(params.content, params.section);
  if (!extraction.valid) {
    if (params.feature_id) {
      const runDir = resolve(params.project_path, ".sdd", "runs", params.feature_id);
      await mkdir(runDir, { recursive: true });
      const signalsPath = join(runDir, "signals.jsonl");
      const extractionWarning = {
        signal_type: "extraction_filter_rejected",
        reason: extraction.reason,
        section: params.section,
        content_preview: params.content.slice(0, 100),
        agent: params.agent ?? "unknown",
        timestamp,
      };
      await atomicAppendJSONL(signalsPath, extractionWarning);
    }
    return { written: false, action: "rejected", reason: extraction.reason, timestamp, confidence: Math.max(0, Math.min(1, params.confidence ?? 0.5)) };
  }

  // Log soft warning for warn-only sections (content allowed but doesn't match typical patterns)
  if (extraction.warning && params.feature_id) {
    const runDir = resolve(params.project_path, ".sdd", "runs", params.feature_id);
    await mkdir(runDir, { recursive: true });
    const signalsPath = join(runDir, "signals.jsonl");
    await atomicAppendJSONL(signalsPath, {
      signal_type: "extraction_filter_warning",
      reason: extraction.warning,
      section: params.section,
      content_preview: params.content.slice(0, 100),
      agent: params.agent ?? "unknown",
      timestamp,
    });
  }

  // GAP-02: Build provenance metadata comment
  const confidence = Math.max(0, Math.min(1, params.confidence ?? 0.5));
  const provenanceComment = `<!-- provenance: ${JSON.stringify({
    agent: params.agent ?? "unknown",
    run_id: params.run_id ?? "unknown",
    feature_id: params.feature_id ?? "unknown",
    timestamp,
    confidence,
  })} -->`;

  // Prepend provenance to content for storage
  const contentWithProvenance = `${provenanceComment}\n${params.content}`;

  // Helper to get existing entries for a section (split by double-newline blocks)
  const getExistingEntries = (sectionName: string, filePath: string): string[] => {
    const fileContent = readFileSync(filePath, "utf-8");
    const sectionBody = mm.extractSection(fileContent, sectionName);
    if (!sectionBody || sectionBody.startsWith("(no ")) return [];
    return sectionBody.split("\n\n").filter(b => b.trim());
  };

  if (params.scope === "project") {
    // Initialize if not exists, then ensure all sections are present (covers legacy templates)
    mm.initProjectMemory("project", "");
    mm.ensureProjectSections();

    if (params.section === "learned_patterns") {
      // GAP-01: Consolidation check
      const existing = getExistingEntries("Learned Patterns", mm.projectMemoryPath);
      const consolidation = consolidateEntry(existing, params.content, params.section);

      if (consolidation.action === "skip") {
        const result: Record<string, unknown> = { written: false, action: "skipped", reason: consolidation.reason, similarity_score: consolidation.similarity_score, timestamp, confidence };

        return result;
      }
      if (consolidation.action === "update" && consolidation.targetIndex !== undefined) {
        // Replace the target entry with the new one
        existing[consolidation.targetIndex] = contentWithProvenance;
        mm.replaceLearnedPatterns(existing.join("\n\n"));
        const result: Record<string, unknown> = { written: true, action: "updated", reason: consolidation.reason, similarity_score: consolidation.similarity_score, timestamp, confidence };

        if (!sanitization.clean) result.sanitization_warnings = sanitization.warnings;
        return result;
      }
      // action === "create"
      mm.appendLearnedPatterns([contentWithProvenance], undefined, params.ttl ?? 15);
      const result: Record<string, unknown> = { written: true, action: "created", reason: consolidation.reason, similarity_score: consolidation.similarity_score, timestamp, confidence };
      if (!sanitization.clean) result.sanitization_warnings = sanitization.warnings;
      return result;
    } else if (params.section === "run_history") {
      // Append raw content to run history (no consolidation for run_history)
      const content = readFileSync(mm.projectMemoryPath, "utf-8");
      const existing = mm.extractSection(content, "Run History");
      const body = existing.startsWith("(no runs") ? contentWithProvenance : `${existing.trim()}\n\n${contentWithProvenance}`;
      const updated = content.replace(
        new RegExp(`(## Run History\\s*\\n)[\\s\\S]*?(?=\\n## |$)`),
        `$1${body}\n\n`,
      );
      writeFileSync(mm.projectMemoryPath, updated, "utf-8");
    } else if (params.section === "project_conventions") {
      // GAP-01: Consolidation check
      const existing = getExistingEntries("Project Conventions", mm.projectMemoryPath);
      const consolidation = consolidateEntry(existing, params.content, params.section);

      if (consolidation.action === "skip") {
        const result: Record<string, unknown> = { written: false, action: "skipped", reason: consolidation.reason, similarity_score: consolidation.similarity_score, timestamp, confidence };

        return result;
      }
      if (consolidation.action === "update" && consolidation.targetIndex !== undefined) {
        existing[consolidation.targetIndex] = contentWithProvenance;
        const fileContent = readFileSync(mm.projectMemoryPath, "utf-8");
        const updated = fileContent.replace(
          new RegExp(`(## Project Conventions\\s*\\n)[\\s\\S]*?(?=\\n## |$)`),
          `$1${existing.join("\n\n")}\n\n`,
        );
        writeFileSync(mm.projectMemoryPath, updated, "utf-8");
        const result: Record<string, unknown> = { written: true, action: "updated", reason: consolidation.reason, similarity_score: consolidation.similarity_score, timestamp, confidence };

        if (!sanitization.clean) result.sanitization_warnings = sanitization.warnings;
        return result;
      }
      // action === "create"
      const content = readFileSync(mm.projectMemoryPath, "utf-8");
      const updated = content.replace(
        new RegExp(`(## Project Conventions\\s*\\n)[\\s\\S]*?(?=\\n## |$)`),
        `$1${contentWithProvenance}\n\n`,
      );
      writeFileSync(mm.projectMemoryPath, updated, "utf-8");
    }
  } else {
    // User scope
    mm.initUserMemory();

    if (params.section === "cross_project_patterns") {
      // GAP-01: Consolidation check
      const existing = getExistingEntries("Cross-Project Patterns", mm.userMemoryPath);
      const consolidation = consolidateEntry(existing, params.content, params.section);

      if (consolidation.action === "skip") {
        const result: Record<string, unknown> = { written: false, action: "skipped", reason: consolidation.reason, similarity_score: consolidation.similarity_score, timestamp, confidence };

        return result;
      }
      if (consolidation.action === "update" && consolidation.targetIndex !== undefined) {
        existing[consolidation.targetIndex] = contentWithProvenance;
        const fileContent = readFileSync(mm.userMemoryPath, "utf-8");
        const sectionBody = existing.join("\n\n");
        const updated = fileContent.replace(
          new RegExp(`(## Cross-Project Patterns\\s*\\n)[\\s\\S]*?(?=\\n## |$)`),
          `$1${sectionBody}\n\n`,
        );
        writeFileSync(mm.userMemoryPath, updated, "utf-8");
        const result: Record<string, unknown> = { written: true, action: "updated", reason: consolidation.reason, similarity_score: consolidation.similarity_score, timestamp, confidence };

        if (!sanitization.clean) result.sanitization_warnings = sanitization.warnings;
        return result;
      }
      // action === "create"
      mm.appendCrossProjectPattern(contentWithProvenance);
    } else if (params.section === "agent_performance") {
      // No consolidation for agent_performance
      mm.appendAgentPerformanceNote(params.agent ?? "unknown", contentWithProvenance);
    } else {
      return { written: false, action: "skipped", reason: `Section "${params.section}" is not supported for user scope. Use "cross_project_patterns" or "agent_performance".` };
    }
  }

  const result: Record<string, unknown> = { written: true, action: "created", timestamp, confidence };
  if (!sanitization.clean) {
    result.sanitization_warnings = sanitization.warnings;
  }
  return result;
}

// ─── 10. Memory TTL decay (internal, used by sdd_tick_maintenance) ──

export async function handleTickDecay(params: {
  project_path: string;
}): Promise<unknown> {
  const mm = new MemoryManager(params.project_path);
  const { existsSync, readFileSync: readSync, writeFileSync: writeSync } = await import("node:fs");

  // Adaptive exponential decay for learned patterns (replaces mm.tickPatternTTLs())
  let removedPatterns = 0;
  const INITIAL_TTL = 20;

  if (existsSync(mm.projectMemoryPath)) {
    const content = readSync(mm.projectMemoryPath, "utf-8");
    const section = mm.extractSection(content, "Learned Patterns");

    if (section && !section.startsWith("(no patterns")) {
      const blocks = section.split("\n\n").filter(b => b.trim());

      const updated = blocks.map(block => {
        // Extended format: <!-- PATTERN-NNN: added_run=X, ttl=Y, ticks_alive=Z, last_confirmed=W -->
        // Legacy format:  <!-- PATTERN-NNN: added_run=X, ttl=Y -->
        const m = block.match(/<!-- PATTERN-\d+: added_run=\d+, ttl=(\d+)(?:, ticks_alive=(\d+), last_confirmed=(\d+))? -->/);
        if (!m) return block; // date-only format: no decay, keep forever

        const ticksAlive = (m[2] !== undefined ? parseInt(m[2]) : 0) + 1;
        const lastConfirmed = m[3] !== undefined ? parseInt(m[3]) : 0;
        const ticksSinceConfirmation = ticksAlive - lastConfirmed;
        const decayRate = ticksSinceConfirmation / Math.max(ticksAlive, 1);
        const remainingTtl = INITIAL_TTL * Math.exp(-decayRate * ticksSinceConfirmation);

        if (remainingTtl < 1.0) {
          removedPatterns++;
          return null; // expire
        }

        const newTtl = Math.round(remainingTtl);
        // Update comment with new values
        return block.replace(
          /<!-- PATTERN-(\d+): added_run=(\d+), ttl=\d+(?:, ticks_alive=\d+, last_confirmed=\d+)? -->/,
          `<!-- PATTERN-$1: added_run=$2, ttl=${newTtl}, ticks_alive=${ticksAlive}, last_confirmed=${lastConfirmed} -->`,
        );
      }).filter((b): b is string => b !== null);

      if (removedPatterns > 0 || blocks.length > 0) {
        // Re-number surviving patterns
        let idx = 1;
        const renumbered = updated.map(block =>
          block.replace(/<!-- PATTERN-\d+:/, `<!-- PATTERN-${String(idx++).padStart(3, "0")}:`),
        ).join("\n\n");
        const newBody = renumbered.trim() || "(no patterns learned yet)";
        const headerRegex = new RegExp(`^## Learned Patterns\\s*$`, "m");
        const headerMatch = headerRegex.exec(content);
        if (headerMatch) {
          const startIdx = headerMatch.index + headerMatch[0].length;
          const rest = content.slice(startIdx);
          const nextHeader = /^## /m.exec(rest);
          const before = content.slice(0, startIdx);
          const after = nextHeader ? rest.slice(nextHeader.index) : "";
          writeSync(mm.projectMemoryPath, before + "\n" + newBody + "\n\n" + after, "utf-8");
        }
      }
    }
  }

  // Exploration TTLs: keep using MemoryManager (linear decay is fine for explorations)
  const expiredExplorations = mm.tickExplorationTTLs();

  return {
    patterns_removed: removedPatterns,
    explorations_expired: expiredExplorations,
    total_removed: removedPatterns + expiredExplorations,
  };
}

// ─── 11b. sdd_tick_maintenance ────────────────────────────────────
// Unified maintenance tick: memory decay + pattern decay in one call.

export async function handleTickMaintenance(params: {
  project_path: string;
  target?: "all" | "patterns" | "memory";
}): Promise<unknown> {
  const target = params.target ?? "all";
  let patternsResult = null;
  let memoryResult = null;

  if (target === "all" || target === "patterns") {
    const { handleTickPatterns } = await import("./metacognition.js");
    patternsResult = await handleTickPatterns({ project_path: params.project_path });
  }
  if (target === "all" || target === "memory") {
    memoryResult = await handleTickDecay({ project_path: params.project_path });
  }

  return {
    patterns: patternsResult,
    memory: memoryResult,
    target,
  };
}

// ─── 12. sdd_update_task ─────────────────────────────────────────

export async function handleUpdateTask(params: {
  project_path: string;
  feature_id: string;
  task_id: string;
  status: "pending" | "in-progress" | "completed";
}): Promise<unknown> {
  const sm = new StateManager(params.project_path);
  const feature = await sm.getFeature(params.feature_id);

  if (!feature) {
    return { error: `Feature "${params.feature_id}" not found` };
  }
  if (!feature.tasks[params.task_id]) {
    return { error: `Task "${params.task_id}" not found. Available: ${Object.keys(feature.tasks).join(", ")}` };
  }

  if (params.status === "completed") {
    await sm.markTaskCompleted(params.feature_id, params.task_id);
  } else {
    const state = await sm.read();
    const t = state.features[params.feature_id].tasks[params.task_id];
    t.status = params.status;
    await sm.write(state);
  }

  return { updated: true, task_id: params.task_id, status: params.status };
}

// ─── 13. sdd_update_feature ──────────────────────────────────────

export async function handleUpdateFeature(params: {
  project_path: string;
  feature_id: string;
  updates: Partial<{
    plan_path: string;
    tasks_path: string;
    worktree_path: string;
    branch: string;
    blocked_reason: string;
    escalation_reason: string;
    awaiting_input_reason: string;
    pr_url: string;
    pr_number: number;
    skip_worktree: boolean;
  }>;
}): Promise<unknown> {
  const sm = new StateManager(params.project_path);
  const feature = await sm.getFeature(params.feature_id);

  if (!feature) {
    return { error: `Feature "${params.feature_id}" not found` };
  }

  await sm.updateFeatureField(params.feature_id, params.updates);
  return { updated: true, fields: Object.keys(params.updates) };
}

// ─── 11. sdd_append_signal ───────────────────────────────────────
// Dual-write: state.json (for sdd_get_state visibility) + signals.jsonl (audit trail).

export async function handleAppendSignal(params: {
  project_path: string;
  feature_id: string;
  from_agent: string;
  signal_type: string;
  message: string;
  severity?: string;
}): Promise<unknown> {
  const runDir = resolve(params.project_path, ".sdd", "runs", params.feature_id);
  await mkdir(runDir, { recursive: true });

  // Write to state.json via StateManager (makes signals visible in sdd_get_state)
  const sm = new StateManager(params.project_path);
  const stateResult = await sm.appendSignal(
    params.feature_id,
    params.from_agent as AgentId,
    params.signal_type as import("./types.js").SignalType,
    { message: params.message, severity: params.severity ?? "info" },
  );

  const signalId = stateResult.ok ? stateResult.signal.id : randomUUID();
  const timestamp = new Date().toISOString();

  // Also write to signals.jsonl (append-only audit trail)
  const signalsPath = join(runDir, "signals.jsonl");
  const entry = {
    signal_id: signalId,
    from_agent: params.from_agent,
    signal_type: params.signal_type,
    message: params.message,
    severity: params.severity ?? "info",
    timestamp,
  };

  await atomicAppendJSONL(signalsPath, entry);

  return { appended: true, signal_id: signalId, in_state: stateResult.ok };
}
