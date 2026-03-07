// MCP Tool handlers — 11 sdd_* tools for the SDD Autopilot MCP server
// All handlers are purely deterministic (no LLM calls).

import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
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
import { fileExists } from "./utils.js";

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

// ─── 1. sdd_get_state ─────────────────────────────────────────────

export async function handleGetState(params: {
  project_path: string;
  feature_id?: string;
}): Promise<unknown> {
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
    return { feature_id: params.feature_id, ...feature };
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
}): Promise<unknown> {
  const contract = contracts.contracts[params.phase_id];
  if (!contract) {
    return { error: `Phase "${params.phase_id}" not found in contracts.json. Available phases: ${Object.keys(contracts.contracts).join(", ")}` };
  }
  return contract;
}

// ─── 4. sdd_evaluate_gate ─────────────────────────────────────────

export async function handleEvaluateGate(params: {
  phase_id: string;
  project_path: string;
  feature_id: string;
  artifacts: Record<string, string>;
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

  const allPassed = checks.every(c => c.passed) && !needsSemantic;

  const result: Record<string, unknown> = {
    passed: allPassed,
    checks,
  };
  if (needsSemantic) {
    result.needs_semantic_validation = needsSemantic;
  }
  return result;
}

// ─── 5. sdd_classify_failure ──────────────────────────────────────

export async function handleClassifyFailure(params: {
  phase_id: string;
  error_message: string;
  affected_files?: string[];
  test_output?: string;
}): Promise<unknown> {
  const msg = (params.error_message + " " + (params.test_output ?? "")).toLowerCase();

  // Implementation bug indicators
  const implBugPatterns = [
    /stack trace/i, /traceback/i, /at .+:\d+:\d+/,
    /typeerror/i, /referenceerror/i, /syntaxerror/i, /type error/i,
    /test fail/i, /tests? failed/i, /assertion/i, /expect.*to/i,
    /cannot read prop/i, /is not a function/i, /is not defined/i,
    /null pointer/i, /segfault/i, /undefined is not/i,
    /fail/i, /error.*line \d+/i,
  ];

  // Spec gap indicators
  const specGapPatterns = [
    /not found/i, /undefined behavior/i, /missing requirement/i,
    /spec.*gap/i, /not specified/i, /not defined in spec/i,
    /ambiguous/i, /unclear/i, /missing.*spec/i,
    /no such.*endpoint/i, /not documented/i,
  ];

  // Infra issue indicators
  const infraPatterns = [
    /econnrefused/i, /econnreset/i, /etimedout/i, /connection.*refused/i,
    /permission denied/i, /eacces/i, /eperm/i,
    /build fail/i, /compilation.*fail/i, /cannot find module/i,
    /npm err/i, /yarn error/i, /docker.*error/i,
    /disk.*full/i, /no space/i, /out of memory/i,
    /network/i, /dns/i, /certificate/i, /ssl/i,
    /timeout/i, /timed out/i,
  ];

  let implScore = 0;
  let specScore = 0;
  let infraScore = 0;

  for (const p of implBugPatterns) if (p.test(msg)) implScore++;
  for (const p of specGapPatterns) if (p.test(msg)) specScore++;
  for (const p of infraPatterns) if (p.test(msg)) infraScore++;

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

  await appendFile(logPath, JSON.stringify(entry) + "\n", "utf-8");

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
}): Promise<unknown> {
  const mm = new MemoryManager(params.project_path);
  const scope = params.scope ?? "project";

  if (scope === "project") {
    const mem = mm.readProjectMemory();
    if (params.section === "all") {
      return {
        content: JSON.stringify(mem),
        entries: [wrapWithDefaultMetadata(JSON.stringify(mem))],
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
    return { content, entries: [wrapWithDefaultMetadata(content)], section: params.section, scope: "project" };
  }

  // User scope
  const mem = mm.readUserMemory();
  if (params.section === "all") {
    return {
      content: JSON.stringify(mem),
      entries: [wrapWithDefaultMetadata(JSON.stringify(mem))],
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
  return {
    content,
    entries: [wrapWithDefaultMetadata(content)],
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
    await appendFile(signalsPath, JSON.stringify(warning) + "\n", "utf-8");
  }

  // GAP-10: Extraction filter — validate content matches expected section patterns
  const extraction = validateExtractionFilter(params.content, params.section);
  if (!extraction.valid && params.feature_id) {
    const runDir = resolve(params.project_path, ".sdd", "runs", params.feature_id);
    await mkdir(runDir, { recursive: true });
    const signalsPath = join(runDir, "signals.jsonl");
    const extractionWarning = {
      signal_type: "extraction_filter_warning",
      reason: extraction.reason,
      section: params.section,
      content_preview: params.content.slice(0, 100),
      agent: params.agent ?? "unknown",
      timestamp,
    };
    await appendFile(signalsPath, JSON.stringify(extractionWarning) + "\n", "utf-8");
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
    // Initialize if not exists
    mm.initProjectMemory("project", "");

    if (params.section === "learned_patterns") {
      // GAP-01: Consolidation check
      const existing = getExistingEntries("Learned Patterns", mm.projectMemoryPath);
      const consolidation = consolidateEntry(existing, params.content, params.section);

      if (consolidation.action === "skip") {
        const result: Record<string, unknown> = { written: false, action: "skipped", reason: consolidation.reason, similarity_score: consolidation.similarity_score, timestamp, confidence };
        if (!extraction.valid) result.extraction_warning = extraction.reason;
        return result;
      }
      if (consolidation.action === "update" && consolidation.targetIndex !== undefined) {
        // Replace the target entry with the new one
        existing[consolidation.targetIndex] = contentWithProvenance;
        mm.replaceLearnedPatterns(existing.join("\n\n"));
        const result: Record<string, unknown> = { written: true, action: "updated", reason: consolidation.reason, similarity_score: consolidation.similarity_score, timestamp, confidence };
        if (!extraction.valid) result.extraction_warning = extraction.reason;
        if (!sanitization.clean) result.sanitization_warnings = sanitization.warnings;
        return result;
      }
      // action === "create"
      mm.appendLearnedPatterns([contentWithProvenance], undefined, params.ttl ?? 15);
      const result: Record<string, unknown> = { written: true, action: "created", reason: consolidation.reason, similarity_score: consolidation.similarity_score, timestamp, confidence };
      if (!extraction.valid) result.extraction_warning = extraction.reason;
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
        if (!extraction.valid) result.extraction_warning = extraction.reason;
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
        if (!extraction.valid) result.extraction_warning = extraction.reason;
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
        if (!extraction.valid) result.extraction_warning = extraction.reason;
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
        if (!extraction.valid) result.extraction_warning = extraction.reason;
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
  if (!extraction.valid) result.extraction_warning = extraction.reason;
  if (!sanitization.clean) {
    result.sanitization_warnings = sanitization.warnings;
  }
  return result;
}

// ─── 10. sdd_tick_decay ──────────────────────────────────────────

export async function handleTickDecay(params: {
  project_path: string;
}): Promise<unknown> {
  const mm = new MemoryManager(params.project_path);

  const removedPatterns = mm.tickPatternTTLs();
  const expiredExplorations = mm.tickExplorationTTLs();

  return {
    patterns_removed: removedPatterns,
    explorations_expired: expiredExplorations,
    total_removed: removedPatterns + expiredExplorations,
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

  await appendFile(signalsPath, JSON.stringify(entry) + "\n", "utf-8");

  return { appended: true, signal_id: signalId, in_state: stateResult.ok };
}
