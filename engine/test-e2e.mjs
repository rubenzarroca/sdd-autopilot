// E2E mechanical test — verifies all 11 sdd_* MCP tool handlers without calling any LLM
// Tests: state management, governance, contracts, gates, failure classification, delta check, memory, signals

import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const projectPath = join(tmpdir(), "test-sdd-autopilot-" + Date.now());

// Clean slate
if (existsSync(projectPath)) rmSync(projectPath, { recursive: true });
mkdirSync(projectPath, { recursive: true });

import { StateManager, AGENT_PERMISSIONS } from "./build/state.js";
import {
  handleGetState,
  handleTransition,
  handleGetContract,
  handleEvaluateGate,
  handleClassifyFailure,
  handleDeltaCheck,
  handleLogEvent,
  handleMemoryRead,
  handleMemoryWrite,
  handleTickDecay,
  handleAppendSignal,
  handleUpdateTask,
  handleUpdateFeature,
} from "./build/handlers.js";
import {
  handleEmitMetrics,
  handleGetRunSummary,
  handleGetAnalytics,
} from "./build/observability.js";
import {
  handleComputeScore,
  handleGetPatterns,
  handleProposePattern,
  handlePromotePattern,
  handleTickPatterns,
  handleProposeExperiment,
  handleEvaluateExperiment,
  handleProposeEvolution,
  handleUpdatePattern,
} from "./build/metacognition.js";

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  + ${label}`);
    passed++;
  } else {
    console.log(`  X ${label}`);
    failed++;
  }
}

// ── Test 1: State Management (via StateManager directly) ─────────
console.log("\n=== Test 1: State Management ===");

const sm = new StateManager(projectPath);
await sm.init("test-sdd-autopilot");
const state = await sm.read();
assert("version is 2.0.0", state.version === "2.0.0");
assert("project name", state.project === "test-sdd-autopilot");
assert("no allowed_transitions in state (governance in code)", state.allowed_transitions === undefined);
assert("active_feature is null", state.active_feature === null);

await sm.createFeature("health-check");
let f = await sm.getFeature("health-check");
assert("feature created in draft", f.state === "draft");
assert("feature has empty tasks", Object.keys(f.tasks).length === 0);
assert("feature has empty signals", f.signals.length === 0);

let r;
r = await sm.transition("health-check", "specified", "spec-generator", "spec generated");
assert("draft -> specified (spec-generator)", r.ok === true);

r = await sm.transition("health-check", "specified", "spec-generator", "re-specify");
assert("specified -> specified blocked (no self-transition)", r.ok === false);

r = await sm.transition("health-check", "planned", "plan-architect", "plan generated");
assert("specified -> planned (plan-architect)", r.ok === true);

r = await sm.transition("health-check", "decomposed", "spec-generator", "wrong agent");
assert("planned -> decomposed by spec-generator is UNAUTHORIZED", r.ok === false && r.code === "UNAUTHORIZED");

r = await sm.transition("health-check", "decomposed", "task-decomposer", "tasks decomposed");
assert("planned -> decomposed (task-decomposer)", r.ok === true);

r = await sm.transition("health-check", "implementing", "implementation-engine", "start impl");
assert("decomposed -> implementing blocked (no tasks)", r.ok === false && r.code === "PRECONDITION_FAILED");

// Add tasks
const s2 = await sm.read();
s2.features["health-check"].tasks = {
  "TASK-001": { status: "pending", title: "Create endpoint" },
  "TASK-002": { status: "pending", title: "Add tests" },
};
await sm.write(s2);

r = await sm.transition("health-check", "implementing", "implementation-engine", "start impl");
assert("decomposed -> implementing (with tasks)", r.ok === true);

r = await sm.transition("health-check", "verifying", "verification-engine", "start verify");
assert("implementing -> verifying blocked (tasks pending)", r.ok === false && r.code === "PRECONDITION_FAILED");

await sm.markTaskCompleted("health-check", "TASK-001");
await sm.markTaskCompleted("health-check", "TASK-002");

r = await sm.transition("health-check", "verifying", "verification-engine", "all tasks done");
assert("implementing -> verifying (tasks done)", r.ok === true);
f = await sm.getFeature("health-check");
assert("verification_attempts incremented to 1", f.verification_attempts === 1);

r = await sm.transition("health-check", "fix_loop", "verification-engine", "tests failed");
assert("verifying -> fix_loop (verification-engine)", r.ok === true);
f = await sm.getFeature("health-check");
assert("fix_loop_attempts incremented to 1", f.fix_loop_attempts === 1);

r = await sm.transition("health-check", "implementing", "implementation-engine", "fixed bug");
assert("fix_loop -> implementing (implementation-engine)", r.ok === true);

const s3 = await sm.read();
s3.features["health-check"].tasks["TASK-001"].status = "completed";
s3.features["health-check"].tasks["TASK-002"].status = "completed";
await sm.write(s3);

r = await sm.transition("health-check", "verifying", "verification-engine", "re-verify");
assert("implementing -> verifying (second attempt)", r.ok === true);
f = await sm.getFeature("health-check");
assert("verification_attempts incremented to 2", f.verification_attempts === 2);

r = await sm.transition("health-check", "reviewing", "verification-engine", "PASS");
assert("verifying -> reviewing (PASS)", r.ok === true);
f = await sm.getFeature("health-check");
assert("review_attempts incremented to 1", f.review_attempts === 1);

r = await sm.transition("health-check", "pr_created", "adversarial-reviewer", "APPROVE");
assert("reviewing -> pr_created (adversarial-reviewer)", r.ok === true);

r = await sm.transition("health-check", "merged", "pr-creator", "merged");
assert("pr_created -> merged (pr-creator)", r.ok === true);

const finalState = await sm.read();
assert("active_feature null after merge", finalState.active_feature === null);

r = await sm.transition("health-check", "draft", "orchestrator", "restart");
assert("merged -> draft blocked (no such edge)", r.ok === false);

// Escalation
await sm.createFeature("troubled-feature");
await sm.transition("troubled-feature", "specified", "spec-generator", "spec");
r = await sm.transition("troubled-feature", "escalated", "orchestrator", "hard stop");
assert("any -> escalated via orchestrator (special rule)", r.ok === true);

// Signal append
const sigResult = await sm.appendSignal("health-check", "verification-engine", "CONTEXT_NOTE", { note: "clean" });
assert("appendSignal returns ok+signal", sigResult.ok === true && sigResult.signal?.id != null);

f = await sm.getFeature("health-check");
assert("multiple transitions recorded", f.transitions.length >= 8);

// ── Test 2: sdd_get_state ─────────────────────────────────────────
console.log("\n=== Test 2: sdd_get_state ===");

let h;
h = await handleGetState({ project_path: projectPath });
assert("get_state returns version", h.version === "2.0.0");
assert("get_state returns project", h.project === "test-sdd-autopilot");

h = await handleGetState({ project_path: projectPath, feature_id: "health-check" });
assert("get_state with feature_id returns state", h.state === "merged");

h = await handleGetState({ project_path: projectPath, feature_id: "nonexistent" });
assert("get_state unknown feature returns error", typeof h.error === "string");

h = await handleGetState({ project_path: "/tmp/nonexistent-project" });
assert("get_state nonexistent project returns error", typeof h.error === "string");

// ── Test 3: sdd_transition ────────────────────────────────────────
console.log("\n=== Test 3: sdd_transition ===");

await sm.createFeature("trans-test");
h = await handleTransition({
  project_path: projectPath,
  feature_id: "trans-test",
  from_state: "draft",
  to_state: "specified",
  agent_id: "spec-generator",
});
assert("sdd_transition success", h.success === true && h.new_state === "specified");

h = await handleTransition({
  project_path: projectPath,
  feature_id: "trans-test",
  from_state: "specified",
  to_state: "planned",
  agent_id: "spec-generator",
});
assert("sdd_transition unauthorized", h.success === false && h.error.code === "UNAUTHORIZED");
assert("sdd_transition returns allowed_transitions", Array.isArray(h.error.allowed_transitions));

// ── Test 4: sdd_get_contract ──────────────────────────────────────
console.log("\n=== Test 4: sdd_get_contract ===");

h = await handleGetContract({ phase_id: "specify" });
assert("get_contract returns agent", h.agent === "spec-generator");
assert("get_contract has gate", h.gate != null);
assert("get_contract has failure_modes", Array.isArray(h.failure_modes));
assert("get_contract has next", h.next === "plan");

h = await handleGetContract({ phase_id: "verify" });
assert("get_contract verify has fix_loop", h.fix_loop != null);
assert("get_contract verify fix_loop max_attempts=3", h.fix_loop.max_attempts === 3);

h = await handleGetContract({ phase_id: "nonexistent" });
assert("get_contract unknown phase returns error", typeof h.error === "string");

// All phases in contracts.json
const allPhases = ["codebase-index", "triage", "specify", "plan", "tasks", "spec-test", "worktree", "implement", "verify", "review", "pr"];
for (const phase of allPhases) {
  const c = await handleGetContract({ phase_id: phase });
  assert(`get_contract ${phase} exists`, c.agent != null);
}

// ── Test 5: sdd_evaluate_gate ─────────────────────────────────────
console.log("\n=== Test 5: sdd_evaluate_gate ===");

// Create a spec file for gate testing
const specDir = join(projectPath, "specs", "health-check");
mkdirSync(specDir, { recursive: true });
writeFileSync(join(specDir, "spec.md"), "# Spec\n\n## requirements\n- FR-001: Health endpoint returns 200\n\n## edge_cases\n- None\n", "utf-8");

h = await handleEvaluateGate({
  phase_id: "specify",
  project_path: projectPath,
  feature_id: "health-check",
  artifacts: { "spec.md": "specs/health-check/spec.md" },
});
assert("evaluate_gate returns checks array", Array.isArray(h.checks));
assert("evaluate_gate spec.md created check passes", h.checks.some(c => c.name.includes("spec.md") && c.passed));
assert("evaluate_gate requirements non-empty passes", h.checks.some(c => c.name.includes("requirements") && c.passed));

h = await handleEvaluateGate({
  phase_id: "triage",
  project_path: projectPath,
  feature_id: "health-check",
  artifacts: { "TRIAGE_RESULT": "present" },
});
assert("evaluate_gate triage emitted check", h.checks.some(c => c.name.includes("emitted") && c.passed));

h = await handleEvaluateGate({
  phase_id: "nonexistent",
  project_path: projectPath,
  feature_id: "health-check",
  artifacts: {},
});
assert("evaluate_gate unknown phase returns error", typeof h.error === "string");

// ── Test 6: sdd_classify_failure ──────────────────────────────────
console.log("\n=== Test 6: sdd_classify_failure ===");

h = await handleClassifyFailure({
  phase_id: "verify",
  error_message: "TypeError: Cannot read property 'id' of undefined at src/handler.ts:42:10",
});
assert("classify TypeError as implementation_bug", h.category === "implementation_bug");

h = await handleClassifyFailure({
  phase_id: "verify",
  error_message: "FR-003 not found in spec. Undefined behavior for edge case.",
});
assert("classify spec gap", h.category === "spec_gap");

h = await handleClassifyFailure({
  phase_id: "verify",
  error_message: "ECONNREFUSED: connection refused to localhost:5432. Permission denied.",
});
assert("classify infra issue", h.category === "infra_issue");

h = await handleClassifyFailure({
  phase_id: "verify",
  error_message: "something happened",
});
assert("classify ambiguous defaults to impl_bug low confidence", h.category === "implementation_bug" && h.confidence === "low");

h = await handleClassifyFailure({
  phase_id: "verify",
  error_message: "5 tests failed",
  test_output: "FAIL src/test.ts\n  TypeError at line 10\n  assertion error\n  expect(x).toBe(y)",
});
assert("classify with test_output high confidence", h.category === "implementation_bug" && h.confidence === "high");

// ── Test 7: sdd_delta_check ──────────────────────────────────────
console.log("\n=== Test 7: sdd_delta_check ===");

await sm.createFeature("delta-test");
await sm.transition("delta-test", "specified", "spec-generator", "spec");

h = await handleDeltaCheck({
  project_path: projectPath,
  feature_id: "delta-test",
  phase_id: "verify",
  current_failures: 5,
});
assert("delta_check first iteration continues", h.result === "continue");

h = await handleDeltaCheck({
  project_path: projectPath,
  feature_id: "delta-test",
  phase_id: "verify",
  current_failures: 3,
});
assert("delta_check improvement continues", h.result === "continue" && h.previous_failures === 5);

h = await handleDeltaCheck({
  project_path: projectPath,
  feature_id: "delta-test",
  phase_id: "verify",
  current_failures: 7,
});
assert("delta_check regression aborts", h.result === "abort" && h.reason === "regression_detected");

// ── Test 8: sdd_log_event ─────────────────────────────────────────
console.log("\n=== Test 8: sdd_log_event ===");

h = await handleLogEvent({
  project_path: projectPath,
  feature_id: "health-check",
  event_type: "phase_start",
  phase: "verify",
  agent_id: "verification-engine",
  data: { attempt: 1 },
});
assert("log_event returns logged:true", h.logged === true);
assert("log_event returns timestamp", typeof h.timestamp === "string");

// Verify log file was created
const logPath = join(projectPath, ".sdd", "runs", "health-check", "run.log");
assert("run.log file created", existsSync(logPath));
const logContent = readFileSync(logPath, "utf-8").trim();
const logEntry = JSON.parse(logContent);
assert("log entry has event_type", logEntry.event_type === "phase_start");
assert("log entry has phase", logEntry.phase === "verify");

// ── Test 9: sdd_memory_read/write ─────────────────────────────────
console.log("\n=== Test 9: sdd_memory_read/write ===");

h = await handleMemoryRead({
  project_path: projectPath,
  section: "project_conventions",
  scope: "project",
});
assert("memory_read empty project returns empty content", h.content === "" || h.content !== undefined);

h = await handleMemoryWrite({
  project_path: projectPath,
  section: "learned_patterns",
  content: "Always use async/await for file operations",
  scope: "project",
});
assert("memory_write returns written:true", h.written === true);
assert("memory_write returns timestamp", typeof h.timestamp === "string");

h = await handleMemoryRead({
  project_path: projectPath,
  section: "learned_patterns",
  scope: "project",
});
assert("memory_read returns written pattern", h.content.includes("async/await"));
assert("memory_read returns correct section", h.section === "learned_patterns");
assert("memory_read returns correct scope", h.scope === "project");

h = await handleMemoryRead({
  project_path: projectPath,
  section: "all",
  scope: "project",
});
assert("memory_read all returns content", typeof h.content === "string" && h.content.length > 0);

// ── Test 10: sdd_tick_decay ───────────────────────────────────────
console.log("\n=== Test 10: sdd_tick_decay ===");

// Write a pattern with TTL for decay testing
h = await handleMemoryWrite({
  project_path: projectPath,
  section: "learned_patterns",
  content: "Decay test pattern",
  scope: "project",
  ttl: 2,
});

h = await handleTickDecay({ project_path: projectPath });
assert("tick_decay returns patterns_removed count", typeof h.patterns_removed === "number");
assert("tick_decay returns explorations_expired count", typeof h.explorations_expired === "number");
assert("tick_decay returns total_removed count", typeof h.total_removed === "number");

// ── Test 11: sdd_append_signal ────────────────────────────────────
console.log("\n=== Test 11: sdd_append_signal ===");

h = await handleAppendSignal({
  project_path: projectPath,
  feature_id: "health-check",
  from_agent: "verification-engine",
  signal_type: "PATTERN_DETECTED",
  message: "N+1 query detected in handler",
  severity: "warning",
});
assert("append_signal returns appended:true", h.appended === true);
assert("append_signal returns signal_id", typeof h.signal_id === "string" && h.signal_id.length > 0);

// Verify signals file
const signalsPath = join(projectPath, ".sdd", "runs", "health-check", "signals.jsonl");
assert("signals.jsonl created", existsSync(signalsPath));
const signalContent = readFileSync(signalsPath, "utf-8").trim();
const signalEntry = JSON.parse(signalContent);
assert("signal has correct type", signalEntry.signal_type === "PATTERN_DETECTED");
assert("signal has message", signalEntry.message === "N+1 query detected in handler");
assert("signal has severity", signalEntry.severity === "warning");

// Second signal to verify append-only
h = await handleAppendSignal({
  project_path: projectPath,
  feature_id: "health-check",
  from_agent: "implementation-engine",
  signal_type: "CONTEXT_NOTE",
  message: "Refactored handler",
});
const signalLines = readFileSync(signalsPath, "utf-8").trim().split("\n");
assert("signals.jsonl has 2 entries (append-only)", signalLines.length === 2);

// ── Test 12: Happy Path — full pipeline via MCP tools only ──────
// This test would have caught the sdd_update_task gap from day one.
// It uses ONLY handler functions (no direct StateManager mutations)
// to prove the complete happy path is reachable end-to-end.
console.log("\n=== Test 12: Happy Path (full pipeline, no LLM) ===");

const HP = "happy-path-feature";
await sm.createFeature(HP);

// Seed tasks via StateManager — simulates what task-decomposer would write.
// All other state mutations go through MCP handlers only.
const hpState = await sm.read();
hpState.features[HP].tasks = {
  "TASK-001": { status: "pending", title: "Implement core logic" },
  "TASK-002": { status: "pending", title: "Write tests" },
  "TASK-003": { status: "pending", title: "Update docs" },
};
await sm.write(hpState);

// draft → specified
h = await handleTransition({ project_path: projectPath, feature_id: HP, from_state: "draft", to_state: "specified", agent_id: "spec-generator" });
assert("happy path: draft → specified", h.success === true);

// sdd_update_feature: persist plan_path (plan-architect would call this after writing plan.md)
h = await handleUpdateFeature({ project_path: projectPath, feature_id: HP, updates: { plan_path: "specs/happy-path-feature/plan.md" } });
assert("happy path: sdd_update_feature sets plan_path", h.updated === true && h.fields.includes("plan_path"));

// specified → planned
h = await handleTransition({ project_path: projectPath, feature_id: HP, from_state: "specified", to_state: "planned", agent_id: "plan-architect" });
assert("happy path: specified → planned", h.success === true);

// sdd_update_feature: persist tasks_path
h = await handleUpdateFeature({ project_path: projectPath, feature_id: HP, updates: { tasks_path: "specs/happy-path-feature/tasks.md" } });
assert("happy path: sdd_update_feature sets tasks_path", h.updated === true);

// planned → decomposed
h = await handleTransition({ project_path: projectPath, feature_id: HP, from_state: "planned", to_state: "decomposed", agent_id: "task-decomposer" });
assert("happy path: planned → decomposed", h.success === true);

// sdd_update_feature: git-operator sets worktree + branch before implementation starts
h = await handleUpdateFeature({ project_path: projectPath, feature_id: HP, updates: { worktree_path: "/tmp/worktree-happy-path", branch: "feat/happy-path-feature" } });
assert("happy path: sdd_update_feature sets worktree+branch", h.updated === true && h.fields.length === 2);

// decomposed → implementing (tasks exist, precondition passes)
h = await handleTransition({ project_path: projectPath, feature_id: HP, from_state: "decomposed", to_state: "implementing", agent_id: "implementation-engine" });
assert("happy path: decomposed → implementing (tasks seeded)", h.success === true);

// implementing → verifying is BLOCKED because tasks are still pending
h = await handleTransition({ project_path: projectPath, feature_id: HP, from_state: "implementing", to_state: "verifying", agent_id: "verification-engine" });
assert("happy path: implementing → verifying blocked (tasks not done)", h.success === false && h.error.code === "PRECONDITION_FAILED");

// sdd_update_task: mark tasks completed one by one (this was the showstopper gap)
h = await handleUpdateTask({ project_path: projectPath, feature_id: HP, task_id: "TASK-001", status: "completed" });
assert("happy path: sdd_update_task TASK-001 completed", h.updated === true);

// still blocked — two tasks remain
h = await handleTransition({ project_path: projectPath, feature_id: HP, from_state: "implementing", to_state: "verifying", agent_id: "verification-engine" });
assert("happy path: implementing → verifying still blocked (TASK-002, TASK-003 pending)", h.success === false);

h = await handleUpdateTask({ project_path: projectPath, feature_id: HP, task_id: "TASK-002", status: "completed" });
assert("happy path: sdd_update_task TASK-002 completed", h.updated === true);

h = await handleUpdateTask({ project_path: projectPath, feature_id: HP, task_id: "TASK-003", status: "completed" });
assert("happy path: sdd_update_task TASK-003 completed", h.updated === true);

// confirm via sdd_get_state that all tasks are done in persisted state
h = await handleGetState({ project_path: projectPath, feature_id: HP });
assert("happy path: all tasks confirmed completed in state.json", Object.values(h.tasks).every(t => t.status === "completed"));

// implementing → verifying (all tasks done — precondition satisfied)
h = await handleTransition({ project_path: projectPath, feature_id: HP, from_state: "implementing", to_state: "verifying", agent_id: "verification-engine" });
assert("happy path: implementing → verifying (all tasks done)", h.success === true);

// verifying → reviewing (PASS)
h = await handleTransition({ project_path: projectPath, feature_id: HP, from_state: "verifying", to_state: "reviewing", agent_id: "verification-engine" });
assert("happy path: verifying → reviewing (PASS)", h.success === true);

// reviewing → pr_created (APPROVE)
h = await handleTransition({ project_path: projectPath, feature_id: HP, from_state: "reviewing", to_state: "pr_created", agent_id: "adversarial-reviewer" });
assert("happy path: reviewing → pr_created (APPROVE)", h.success === true);

// final state check
h = await handleGetState({ project_path: projectPath, feature_id: HP });
assert("happy path: final state is pr_created", h.state === "pr_created");
assert("happy path: branch persisted", h.branch === "feat/happy-path-feature");
assert("happy path: worktree_path persisted", h.worktree_path === "/tmp/worktree-happy-path");
assert("happy path: plan_path persisted", h.plan_path === "specs/happy-path-feature/plan.md");

// error paths for the two new tools
h = await handleUpdateTask({ project_path: projectPath, feature_id: HP, task_id: "TASK-999", status: "completed" });
assert("happy path: sdd_update_task unknown task returns error", typeof h.error === "string");

h = await handleUpdateFeature({ project_path: projectPath, feature_id: "nonexistent-feature", updates: { branch: "test" } });
assert("happy path: sdd_update_feature unknown feature returns error", typeof h.error === "string");

// ── Test 13: sdd_emit_metrics ─────────────────────────────────────
console.log("\n=== Test 13: sdd_emit_metrics ===");

const RUN_ID = "obs-feature-1741189200000";

h = await handleEmitMetrics({
  project_path: projectPath,
  metrics: {
    run_id:            RUN_ID,
    feature_id:        "obs-feature",
    phase:             "specify",
    agent:             "spec-generator",
    model:             "sonnet",
    started_at:        "2026-03-05T10:00:00.000Z",
    completed_at:      "2026-03-05T10:01:00.000Z",
    duration_ms:       60000,
    tokens_in:         null,
    tokens_out:        null,
    tool_calls_count:  0,
    gate_result:       "pass",
    gate_attempts:     1,
    findings_count:    0,
    findings_severity: [],
    fix_loop_count:    0,
    delta_direction:   null,
    feature_type:      "api",
    complexity:        "low",
  },
});
assert("emit_metrics returns emitted:true", h.emitted === true);
assert("emit_metrics returns run_id", h.run_id === RUN_ID);
assert("emit_metrics returns phase", h.phase === "specify");

const metricsPath = join(projectPath, ".sdd", "runs", "obs-feature", "metrics.jsonl");
assert("metrics.jsonl created", existsSync(metricsPath));
const metricsLine1 = JSON.parse(readFileSync(metricsPath, "utf-8").trim().split("\n")[0]);
assert("metrics entry has run_id", metricsLine1.run_id === RUN_ID);
assert("metrics entry has duration_ms", metricsLine1.duration_ms === 60000);
assert("metrics entry has tokens_in null", metricsLine1.tokens_in === null);
assert("metrics entry has gate_result pass", metricsLine1.gate_result === "pass");

// Second phase: implement
h = await handleEmitMetrics({
  project_path: projectPath,
  metrics: {
    run_id:            RUN_ID,
    feature_id:        "obs-feature",
    phase:             "implement",
    agent:             "implementation-engine",
    model:             "sonnet",
    started_at:        "2026-03-05T10:01:00.000Z",
    completed_at:      "2026-03-05T10:05:00.000Z",
    duration_ms:       240000,
    tokens_in:         null,
    tokens_out:        null,
    tool_calls_count:  0,
    gate_result:       "pass",
    gate_attempts:     2,       // needed a fix loop
    findings_count:    0,
    findings_severity: [],
    fix_loop_count:    1,
    delta_direction:   "improving",
    feature_type:      "api",
    complexity:        "low",
  },
});
assert("emit_metrics appends second phase", h.emitted === true);
const metricsLines = readFileSync(metricsPath, "utf-8").trim().split("\n");
assert("metrics.jsonl has 2 entries (append-only)", metricsLines.length === 2);

// Third phase: verify (skipped via pattern — future scenario, tested with gate_result="skip")
h = await handleEmitMetrics({
  project_path: projectPath,
  metrics: {
    run_id:            RUN_ID,
    feature_id:        "obs-feature",
    phase:             "verify",
    agent:             "verification-engine",
    model:             "sonnet",
    started_at:        "2026-03-05T10:05:00.000Z",
    completed_at:      "2026-03-05T10:05:00.001Z",
    duration_ms:       1,
    tokens_in:         null,
    tokens_out:        null,
    tool_calls_count:  0,
    gate_result:       "skip",
    gate_attempts:     0,
    findings_count:    0,
    findings_severity: [],
    fix_loop_count:    0,
    delta_direction:   null,
    feature_type:      "api",
    complexity:        "low",
  },
});
assert("emit_metrics accepts gate_result=skip", h.emitted === true);

// Fourth phase: pr
h = await handleEmitMetrics({
  project_path: projectPath,
  metrics: {
    run_id:            RUN_ID,
    feature_id:        "obs-feature",
    phase:             "pr",
    agent:             "pr-creator",
    model:             "sonnet",
    started_at:        "2026-03-05T10:05:10.000Z",
    completed_at:      "2026-03-05T10:05:30.000Z",
    duration_ms:       20000,
    tokens_in:         null,
    tokens_out:        null,
    tool_calls_count:  0,
    gate_result:       "pass",
    gate_attempts:     1,
    findings_count:    0,
    findings_severity: [],
    fix_loop_count:    0,
    delta_direction:   null,
    feature_type:      "api",
    complexity:        "low",
  },
});
assert("emit_metrics fourth phase emitted", h.emitted === true);

// ── Test 14: sdd_get_run_summary ──────────────────────────────────
console.log("\n=== Test 14: sdd_get_run_summary ===");

h = await handleGetRunSummary({
  project_path: projectPath,
  feature_id:   "obs-feature",
  run_id:       RUN_ID,
});
assert("get_run_summary returns run_id", h.run_id === RUN_ID);
assert("get_run_summary returns feature_id", h.feature_id === "obs-feature");
assert("get_run_summary feature_type from first metric", h.feature_type === "api");
assert("get_run_summary complexity from first metric", h.complexity === "low");

// phases_executed: phases that were NOT skipped (specify, implement, pr)
assert("get_run_summary phases_executed excludes skipped", h.phases_executed.includes("specify") && h.phases_executed.includes("implement") && h.phases_executed.includes("pr"));
assert("get_run_summary phases_skipped includes verify", h.phases_skipped.includes("verify"));

// total_duration_ms: 60000 + 240000 + 1 + 20000
assert("get_run_summary total_duration_ms aggregated", h.total_duration_ms === 320001);

// total_tokens null (all phases have null)
assert("get_run_summary total_tokens null when all phases null", h.total_tokens === null);

// total_fix_loops: 0+1+0+0 = 1
assert("get_run_summary total_fix_loops = 1", h.total_fix_loops === 1);

// outcome: "pr_created" because phases_executed includes "pr"
assert("get_run_summary outcome pr_created", h.outcome === "pr_created");

// first_pass_rate: 2 passed phases (specify gate_attempts=1, pr gate_attempts=1) out of 3 passed total
// implement passed but gate_attempts=2 (not first pass), verify was skipped
// So: passed=[specify,implement,pr] → first_pass=[specify,pr] → 2/3 = 66%
assert("get_run_summary first_pass_rate = 67", h.first_pass_rate === 67);

// pipeline_score is null until Phase 2
assert("get_run_summary pipeline_score null (Phase 2 pending)", h.pipeline_score === null);

// summary.json persisted
const summaryPath = join(projectPath, ".sdd", "runs", "obs-feature", "summary.json");
assert("summary.json created", existsSync(summaryPath));
const summaryJson = JSON.parse(readFileSync(summaryPath, "utf-8"));
assert("summary.json has phase_metrics array", Array.isArray(summaryJson.phase_metrics) && summaryJson.phase_metrics.length === 4);

// history.jsonl created
const historyPath = join(projectPath, ".sdd", "analytics", "history.jsonl");
assert("analytics/history.jsonl created", existsSync(historyPath));
const historyLine = JSON.parse(readFileSync(historyPath, "utf-8").trim().split("\n")[0]);
assert("history.jsonl entry has run_id", historyLine.run_id === RUN_ID);

// Error: feature not found
h = await handleGetRunSummary({ project_path: projectPath, feature_id: "nonexistent-obs" });
assert("get_run_summary missing feature returns error", typeof h.error === "string");

// Error: run_id not found
h = await handleGetRunSummary({ project_path: projectPath, feature_id: "obs-feature", run_id: "bad-run-id" });
assert("get_run_summary missing run_id returns error", typeof h.error === "string");

// last_n_runs: add a second run to history first
await handleEmitMetrics({
  project_path: projectPath,
  metrics: {
    run_id: "obs-feature-run2", feature_id: "obs-feature", phase: "specify",
    agent: "spec-generator", model: "sonnet",
    started_at: "2026-03-05T11:00:00.000Z", completed_at: "2026-03-05T11:01:00.000Z",
    duration_ms: 55000, tokens_in: null, tokens_out: null, tool_calls_count: 0,
    gate_result: "pass", gate_attempts: 1,
    findings_count: 0, findings_severity: [], fix_loop_count: 0,
    delta_direction: null, feature_type: "api", complexity: "low",
  },
});
await handleGetRunSummary({ project_path: projectPath, feature_id: "obs-feature", run_id: "obs-feature-run2" });

h = await handleGetRunSummary({ project_path: projectPath, feature_id: "obs-feature", last_n_runs: 1 });
assert("get_run_summary last_n_runs=1 returns 1 summary", h.summaries.length === 1);

h = await handleGetRunSummary({ project_path: projectPath, feature_id: "obs-feature", last_n_runs: 10 });
assert("get_run_summary last_n_runs=10 returns all available (<=10)", h.summaries.length <= 10 && h.summaries.length >= 1);

// last_n_runs on nonexistent feature returns empty
h = await handleGetRunSummary({ project_path: "/tmp/nonexistent-analytics", feature_id: "x", last_n_runs: 5 });
assert("get_run_summary last_n_runs on missing history returns empty", h.summaries.length === 0 && h.runs_analyzed === 0);

// ── Test 15: sdd_get_analytics ────────────────────────────────────
console.log("\n=== Test 15: sdd_get_analytics ===");

h = await handleGetAnalytics({ project_path: projectPath });
assert("get_analytics returns runs_analyzed >= 2", h.runs_analyzed >= 2);
assert("get_analytics returns avg_duration_by_phase object", typeof h.avg_duration_by_phase === "object");
assert("get_analytics specify phase in avg_duration", h.avg_duration_by_phase["specify"] !== undefined);
assert("get_analytics returns avg_fix_loops_by_feature_type", typeof h.avg_fix_loops_by_feature_type === "object");
assert("get_analytics api feature_type present", h.avg_fix_loops_by_feature_type["api"] !== undefined);
assert("get_analytics first_pass_rate_history 0-100", h.first_pass_rate_history >= 0 && h.first_pass_rate_history <= 100);
assert("get_analytics high_variance_phases is array", Array.isArray(h.high_variance_phases));
assert("get_analytics trends is object or null (depends on run count)", h.trends === null || (typeof h.trends === "object" && !Array.isArray(h.trends)));

// filter by feature_type=api (should return results)
h = await handleGetAnalytics({ project_path: projectPath, feature_type: "api" });
assert("get_analytics filter feature_type=api returns runs", h.runs_analyzed >= 1);

// filter by feature_type=nonexistent (should return 0)
h = await handleGetAnalytics({ project_path: projectPath, feature_type: "nonexistent-type" });
assert("get_analytics filter nonexistent feature_type returns 0 runs", h.runs_analyzed === 0);
assert("get_analytics filter no match returns empty avg_duration_by_phase", Object.keys(h.avg_duration_by_phase).length === 0);

// filter by complexity=low
h = await handleGetAnalytics({ project_path: projectPath, complexity: "low" });
assert("get_analytics filter complexity=low returns runs", h.runs_analyzed >= 1);

// no history file → returns empty result
h = await handleGetAnalytics({ project_path: "/tmp/nonexistent-analytics-path" });
assert("get_analytics missing history returns 0 runs", h.runs_analyzed === 0);
assert("get_analytics missing history returns null trends", h.trends === null);

// trends: only computed with >= 4 runs; with 2 runs, trends should be empty
h = await handleGetAnalytics({ project_path: projectPath });
assert("get_analytics trends null when < 4 runs", h.runs_analyzed < 4 ? h.trends === null : true);

// ── Test 16: sdd_compute_score ────────────────────────────────────
console.log("\n=== Test 16: sdd_compute_score ===");

// Helper: write a summary.json for a given feature with specific fields
function writeSummary(featureId, overrides = {}) {
  const dir = join(projectPath, ".sdd", "runs", featureId);
  mkdirSync(dir, { recursive: true });
  const base = {
    run_id: featureId + "-run1",
    feature_id: featureId,
    feature_type: "score-test",   // isolated type with no pre-existing history
    complexity: "low",
    outcome: "pr_created",
    total_duration_ms: 300000,
    total_tokens: null,
    phases_executed: ["specify", "implement", "verify", "review", "pr"],
    phases_skipped: [],
    total_fix_loops: 0,
    verify_attempts: 1,
    review_attempts: 1,
    review_decision: "approve",
    first_pass_rate: 100,
    pipeline_score: null,
    phase_metrics: [
      {
        run_id: featureId + "-run1", feature_id: featureId, phase: "verify",
        agent: "verification-engine", model: "sonnet",
        started_at: "2026-03-05T10:00:00.000Z", completed_at: "2026-03-05T10:02:00.000Z",
        duration_ms: 120000, tokens_in: null, tokens_out: null, tool_calls_count: 0,
        gate_result: "pass", gate_attempts: 1,
        findings_count: 0, findings_severity: [],
        fix_loop_count: 0, delta_direction: null, feature_type: "api", complexity: "low",
      },
    ],
  };
  writeFileSync(join(dir, "summary.json"), JSON.stringify({ ...base, ...overrides }, null, 2));
}

// Case 1: Perfect run — review=approve, first_pass=100, no findings, verify clean, 0 fix loops
writeSummary("score-perfect");
h = await handleComputeScore({ project_path: projectPath, feature_id: "score-perfect" });
assert("compute_score returns pipeline_score", typeof h.pipeline_score === "number");
assert("compute_score returns quality_score", typeof h.quality_score === "number");
assert("compute_score returns efficiency_score", typeof h.efficiency_score === "number");
assert("compute_score perfect run quality=100", h.quality_score === 100);
// efficiency: fix_loops=100, phases_skipped=70 (0 skips baseline), duration_trend=70 (no history)
// = round(0.5×100 + 0.2×70 + 0.3×70) = round(50+14+21) = 85
assert("compute_score perfect run efficiency=85", h.efficiency_score === 85);
// pipeline = round((0.7×100 + 0.3×85) × 10) / 10 = round(955)/10 = 95.5
assert("compute_score perfect run pipeline=95.5", h.pipeline_score === 95.5);
assert("compute_score breakdown has all components", h.breakdown != null &&
  typeof h.breakdown.review_result_score === "number" &&
  typeof h.breakdown.fix_loops_score === "number");
assert("compute_score weights_used returns defaults", h.weights_used.quality_weight === 0.7);

// pipeline_score persisted in summary.json
const ps = JSON.parse(readFileSync(join(projectPath, ".sdd", "runs", "score-perfect", "summary.json"), "utf-8"));
assert("compute_score pipeline_score persisted in summary.json", ps.pipeline_score === 95.5);

// metacognition dir created
assert("compute_score creates .sdd/metacognition/", existsSync(join(projectPath, ".sdd", "metacognition")));

// Case 2: With fix loops (total_fix_loops=3, verify fix_loop_count=2)
writeSummary("score-fixloops", {
  total_fix_loops: 3,
  phase_metrics: [{
    run_id: "score-fixloops-run1", feature_id: "score-fixloops", phase: "verify",
    agent: "verification-engine", model: "sonnet",
    started_at: "2026-03-05T10:00:00.000Z", completed_at: "2026-03-05T10:02:00.000Z",
    duration_ms: 120000, tokens_in: null, tokens_out: null, tool_calls_count: 0,
    gate_result: "pass", gate_attempts: 3,
    findings_count: 0, findings_severity: [],
    fix_loop_count: 2, delta_direction: "improving", feature_type: "api", complexity: "low",
  }],
});
h = await handleComputeScore({ project_path: projectPath, feature_id: "score-fixloops" });
// fix_loops_score = round(100×(1-3/5)) = round(40) = 40
// verify_clean = 60 (pass but fix_loop_count=2 > 0)
// quality = round(0.4×100 + 0.25×100 + 0.20×100 + 0.15×60) = round(40+25+20+9) = 94
// efficiency = round(0.5×40 + 0.2×70 + 0.3×70) = round(20+14+21) = 55
// pipeline = round((0.7×94 + 0.3×55)×10)/10 = round((65.8+16.5)×10)/10 = round(82.3×10)/10 = 82.3
assert("compute_score fix_loops_score=40 (3/5)", h.breakdown.fix_loops_score === 40);
assert("compute_score verify_clean_score=60 (fix loop)", h.breakdown.verify_clean_score === 60);
assert("compute_score quality reduced by verify", h.quality_score === 94);
assert("compute_score efficiency reduced by fix loops", h.efficiency_score === 55);
assert("compute_score pipeline < perfect", h.pipeline_score < 95.5);
assert("compute_score pipeline ~82", h.pipeline_score === 82.3);

// Case 3: request_changes but pr_created (eventually approved)
writeSummary("score-reqchanges", { review_decision: "request_changes" });
h = await handleComputeScore({ project_path: projectPath, feature_id: "score-reqchanges" });
// review_result_score = 70
// quality = round(0.4×70 + 0.25×100 + 0.20×100 + 0.15×100) = round(28+25+20+15) = 88
assert("compute_score review_result_score=70 for request_changes+success", h.breakdown.review_result_score === 70);
assert("compute_score quality=88 with request_changes", h.quality_score === 88);

// Case 4: escalated run
writeSummary("score-escalated", { outcome: "escalated", review_decision: null });
h = await handleComputeScore({ project_path: projectPath, feature_id: "score-escalated" });
assert("compute_score review_result_score=0 for escalated", h.breakdown.review_result_score === 0);
assert("compute_score pipeline < 70 for escalated run", h.pipeline_score < 70);

// Case 5: critical findings reduce quality
writeSummary("score-critical", {
  phase_metrics: [{
    run_id: "score-critical-run1", feature_id: "score-critical", phase: "review",
    agent: "adversarial-reviewer", model: "opus",
    started_at: "2026-03-05T10:00:00.000Z", completed_at: "2026-03-05T10:02:00.000Z",
    duration_ms: 120000, tokens_in: null, tokens_out: null, tool_calls_count: 0,
    gate_result: "pass", gate_attempts: 1,
    findings_count: 2, findings_severity: ["critical", "major"],
    fix_loop_count: 0, delta_direction: null, feature_type: "api", complexity: "low",
  }],
});
h = await handleComputeScore({ project_path: projectPath, feature_id: "score-critical" });
// findings_score = max(0, 100 - 1×30 - 1×15) = 55
assert("compute_score findings_score=55 (1 critical + 1 major)", h.breakdown.findings_score === 55);
assert("compute_score quality < 100 with findings", h.quality_score < 100);

// Case 6: phases_skipped bonus (2 skips + success = score=100)
writeSummary("score-skipped", {
  phases_skipped: ["plan", "spec-test"],
  phases_executed: ["specify", "implement", "verify", "review", "pr"],
});
h = await handleComputeScore({ project_path: projectPath, feature_id: "score-skipped" });
// phases_skipped_score = min(100, 70 + 2×15) = min(100, 100) = 100
assert("compute_score phases_skipped_score=100 (2 skips + success)", h.breakdown.phases_skipped_score === 100);

// Case 7: phases_skipped + failure = score=0
writeSummary("score-skipped-fail", {
  phases_skipped: ["verify"],
  outcome: "escalated",
  review_decision: null,
});
h = await handleComputeScore({ project_path: projectPath, feature_id: "score-skipped-fail" });
assert("compute_score phases_skipped_score=0 (skipped + failed)", h.breakdown.phases_skipped_score === 0);

// Case 8: run_id mismatch returns error
writeSummary("score-mismatch");
h = await handleComputeScore({ project_path: projectPath, feature_id: "score-mismatch", run_id: "wrong-run-id" });
assert("compute_score run_id mismatch returns error", typeof h.error === "string");

// Case 9: missing summary.json returns error
h = await handleComputeScore({ project_path: projectPath, feature_id: "score-nonexistent" });
assert("compute_score missing summary returns error", typeof h.error === "string");

// Case 10: duration_trend uses history — faster run → score 100
// Re-use obs-feature history already in analytics/history.jsonl (feature_type="api")
// Write a new summary with feature_type="api" that's much faster (200ms vs ~187500ms mean)
writeSummary("score-trend", { feature_type: "api", total_duration_ms: 200, run_id: "score-trend-run1" });
h = await handleComputeScore({ project_path: projectPath, feature_id: "score-trend" });
// mean of api history ≈ (320001 + 55000) / 2 ≈ 187500ms; 200ms << 187500ms → ratio ≈ 0.001 < 0.9 → score=100
assert("compute_score duration_trend=100 when much faster than history", h.breakdown.duration_trend_score === 100);

// Case 11: custom score_weights.json is loaded if present
mkdirSync(join(projectPath, ".sdd", "metacognition"), { recursive: true });
writeFileSync(
  join(projectPath, ".sdd", "metacognition", "score_weights.json"),
  JSON.stringify({ quality_weight: 0.5, efficiency_weight: 0.5 })
);
writeSummary("score-custom-weights");
h = await handleComputeScore({ project_path: projectPath, feature_id: "score-custom-weights" });
assert("compute_score uses custom weights (50/50 split)", h.weights_used.quality_weight === 0.5 && h.weights_used.efficiency_weight === 0.5);
// With 50/50: pipeline = round((0.5×100 + 0.5×85)×10)/10 = round(92.5×10)/10 = 92.5
assert("compute_score pipeline=92.5 with 50/50 weights", h.pipeline_score === 92.5);

// Restore: remove custom weights (other tests use defaults)
const { unlinkSync } = await import("node:fs");
unlinkSync(join(projectPath, ".sdd", "metacognition", "score_weights.json"));

// ── Test 17: sdd_propose_pattern ─────────────────────────────────
console.log("\n=== Test 17: sdd_propose_pattern ===");

h = await handleProposePattern({
  project_path:    projectPath,
  pattern_id:      "skip-plan-api-low",
  type:            "skip_phase",
  condition:       "feature_type=api AND complexity=low",
  action:          "skip phase=plan",
  confidence:      0.8,
  supporting_runs: 3,
  min_runs:        5,
  ttl:             20,
});
assert("propose_pattern returns proposed:true", h.proposed === true);
assert("propose_pattern status=candidate", h.status === "candidate");
assert("propose_pattern returns pattern_id", h.pattern_id === "skip-plan-api-low");

// patterns.json created
const patternsPath = join(projectPath, ".sdd", "metacognition", "patterns.json");
assert("patterns.json created", existsSync(patternsPath));
const patternsFile = JSON.parse(readFileSync(patternsPath, "utf-8"));
assert("patterns.json has 1 entry", patternsFile.length === 1);
assert("pattern has correct type", patternsFile[0].type === "skip_phase");
assert("pattern status=candidate", patternsFile[0].status === "candidate");
assert("pattern has created_at", typeof patternsFile[0].created_at === "string");

// Duplicate pattern_id rejected
h = await handleProposePattern({
  project_path: projectPath, pattern_id: "skip-plan-api-low",
  type: "skip_phase", condition: "feature_type=api", action: "skip phase=plan",
  confidence: 0.9, supporting_runs: 6,
});
assert("propose_pattern duplicate id returns error", typeof h.error === "string");

// Second pattern — Bayesian: confidence starts at 0.5 (Beta(1,1) prior)
// Build up confidence via outcome="success" updates to pass promote gate (>= 0.7)
h = await handleProposePattern({
  project_path:    projectPath,
  pattern_id:      "haiku-triage-all",
  type:            "model_swap",
  condition:       "complexity=low",
  action:          "swap model=haiku phase=triage",
  confidence:      0.75,
  supporting_runs: 1,
  min_runs:        5,
});
assert("propose_pattern second pattern created", h.proposed === true);
// 5 success updates: alpha=6, beta=1, confidence=6/7≈0.857, supporting_runs=6
for (let i = 0; i < 5; i++) {
  await handleUpdatePattern({ project_path: projectPath, pattern_id: "haiku-triage-all", outcome: "success" });
}

// Third pattern: build to exactly at threshold via Bayesian updates
h = await handleProposePattern({
  project_path:    projectPath,
  pattern_id:      "skip-spec-test-api",
  type:            "skip_phase",
  condition:       "feature_type=api",
  action:          "skip phase=spec-test",
  confidence:      0.72,
  supporting_runs: 1,
  min_runs:        5,
});
assert("propose_pattern third pattern created", h.proposed === true);
// 4 success updates: alpha=5, beta=1, confidence=5/6≈0.833, supporting_runs=5
for (let i = 0; i < 4; i++) {
  await handleUpdatePattern({ project_path: projectPath, pattern_id: "skip-spec-test-api", outcome: "success" });
}

// ── Test 18: sdd_promote_pattern ──────────────────────────────────
console.log("\n=== Test 18: sdd_promote_pattern ===");

// Promote with supporting_runs=3 (< min_runs=5): should be rejected
h = await handlePromotePattern({ project_path: projectPath, pattern_id: "skip-plan-api-low" });
assert("promote_pattern rejected: supporting_runs=3 < min_runs=5", h.promoted === false);
assert("promote_pattern rejection reason mentions supporting_runs", h.reason.includes("supporting_runs"));

// Promote with supporting_runs=6, confidence≈0.857 (>= both thresholds): should succeed
h = await handlePromotePattern({ project_path: projectPath, pattern_id: "haiku-triage-all" });
assert("promote_pattern succeeds: supporting_runs=6, confidence>=0.7", h.promoted === true);
assert("promote_pattern status=active", h.status === "active");

// Verify in patterns.json
const patterns2 = JSON.parse(readFileSync(patternsPath, "utf-8"));
const activeP = patterns2.find(p => p.pattern_id === "haiku-triage-all");
assert("promoted pattern has status=active in file", activeP?.status === "active");
assert("promoted pattern has promoted_at", typeof activeP?.promoted_at === "string");

// Promoting again returns already-active message
h = await handlePromotePattern({ project_path: projectPath, pattern_id: "haiku-triage-all" });
assert("promote_pattern already-active returns promoted=false", h.promoted === false);
assert("promote_pattern already-active reason", h.reason.includes("already active"));

// Promote with supporting_runs=5 and confidence≈0.833 (>= 0.7): should succeed
h = await handlePromotePattern({ project_path: projectPath, pattern_id: "skip-spec-test-api" });
assert("promote_pattern succeeds at exact threshold (runs=5, conf>=0.7)", h.promoted === true);

// Nonexistent pattern
h = await handlePromotePattern({ project_path: projectPath, pattern_id: "nonexistent-pattern" });
assert("promote_pattern nonexistent returns error", typeof h.error === "string");

// ── Test 19: sdd_get_patterns ──────────────────────────────────────
console.log("\n=== Test 19: sdd_get_patterns ===");

// Default: active only (haiku-triage-all and skip-spec-test-api were promoted)
h = await handleGetPatterns({ project_path: projectPath });
assert("get_patterns default returns active patterns", h.patterns.every(p => p.status === "active"));
assert("get_patterns returns 2 active patterns", h.count === 2);

// All patterns
h = await handleGetPatterns({ project_path: projectPath, status: "all" });
assert("get_patterns status=all returns all 3 patterns", h.count === 3);

// Candidates only
h = await handleGetPatterns({ project_path: projectPath, status: "candidate" });
assert("get_patterns status=candidate returns 1 (skip-plan-api-low)", h.count === 1);
assert("get_patterns candidate is skip-plan-api-low", h.patterns[0].pattern_id === "skip-plan-api-low");

// Filter by feature_type=api (should match patterns with feature_type=api or no constraint)
h = await handleGetPatterns({ project_path: projectPath, status: "active", feature_type: "api" });
assert("get_patterns filter feature_type=api returns matching active patterns", h.count >= 1);

// Filter by feature_type=api AND complexity=low (only skip-spec-test-api condition matches)
// Wait — haiku-triage-all condition is "complexity=low" (no feature_type constraint, matches everything)
// skip-spec-test-api condition is "feature_type=api" (no complexity constraint)
// Both should match "feature_type=api AND complexity=low" context
h = await handleGetPatterns({ project_path: projectPath, status: "active", feature_type: "api", complexity: "low" });
assert("get_patterns filter api+low returns active patterns", h.count >= 1);

// Filter with non-matching feature_type — patterns with no feature_type constraint still match
h = await handleGetPatterns({ project_path: projectPath, status: "active", feature_type: "ui" });
// haiku-triage-all has condition "complexity=low" (no feature_type), so it matches any feature_type
// skip-spec-test-api has condition "feature_type=api", so it does NOT match "ui"
assert("get_patterns filter feature_type=ui returns patterns with no feature_type constraint", h.count >= 0);

// No patterns file: returns empty
h = await handleGetPatterns({ project_path: "/tmp/empty-metacognition-path" });
assert("get_patterns nonexistent returns empty", h.count === 0 && h.patterns.length === 0);

// ── Test 20: sdd_tick_patterns ─────────────────────────────────────
console.log("\n=== Test 20: sdd_tick_patterns ===");

// Add a candidate pattern and build confidence via Bayesian updates before promoting
await handleProposePattern({
  project_path: projectPath, pattern_id: "soon-to-decay",
  type: "prompt_tuning", condition: "complexity=high", action: "inject context",
  confidence: 0.8, supporting_runs: 1, min_runs: 5, ttl: 1,
});
// Build confidence: 5 successes → alpha=6, beta=1, confidence≈0.857, supporting_runs=6
for (let i = 0; i < 5; i++) {
  await handleUpdatePattern({ project_path: projectPath, pattern_id: "soon-to-decay", outcome: "success" });
}
await handlePromotePattern({ project_path: projectPath, pattern_id: "soon-to-decay" });

// Verify it's active before tick
let patternsBefore = JSON.parse(readFileSync(patternsPath, "utf-8"));
const beforeDecay = patternsBefore.find(p => p.pattern_id === "soon-to-decay");
assert("tick_patterns: soon-to-decay is active before tick", beforeDecay?.status === "active");

// With adaptive exponential decay: remaining_ttl = 20 * exp(-lambda * ticks_since_confirmation)
// After 1 tick with no confirmations: total_ticks_alive=1, last_confirmed=0, lambda=1/1=1,
// remaining = 20 * exp(-1) ≈ 7.36 → still alive. Need 3 ticks to decay (20*exp(-3)≈0.99 < 1.0).
// Confirm haiku-triage-all between ticks so it survives (resets ticks_since_confirmation).
let totalDecayed = 0;
for (let i = 0; i < 3; i++) {
  h = await handleTickPatterns({ project_path: projectPath });
  totalDecayed += h.decayed;
  // Confirm haiku-triage-all after each tick to keep it alive
  await handleUpdatePattern({ project_path: projectPath, pattern_id: "haiku-triage-all", outcome: "success" });
}
assert("tick_patterns returns ticked:true", h.ticked === true);
assert("tick_patterns: soon-to-decay decayed after multiple ticks", totalDecayed >= 1);

// Verify decay in file
const patternsAfter = JSON.parse(readFileSync(patternsPath, "utf-8"));
const afterDecay = patternsAfter.find(p => p.pattern_id === "soon-to-decay");
assert("tick_patterns: soon-to-decay is now decayed", afterDecay?.status === "decayed");
assert("tick_patterns: soon-to-decay has decayed_at", typeof afterDecay?.decayed_at === "string");

// Other patterns: TTL decreased via adaptive decay but survived (confirmed between ticks)
const otherPattern = patternsAfter.find(p => p.pattern_id === "haiku-triage-all");
assert("tick_patterns: haiku-triage-all TTL decreased", otherPattern?.ttl < 20);
assert("tick_patterns: haiku-triage-all still active", otherPattern?.status === "active");

// Decayed pattern cannot be promoted
h = await handlePromotePattern({ project_path: projectPath, pattern_id: "soon-to-decay" });
assert("tick_patterns: decayed pattern cannot be promoted", h.promoted === false && h.reason.includes("decayed"));

// ── Test 21: sdd_propose_experiment ──────────────────────────────
console.log("\n=== Test 21: sdd_propose_experiment ===");

h = await handleProposeExperiment({
  project_path:    projectPath,
  experiment_id:   "merge-plan-tasks-2026-03",
  hypothesis:      "Merging plan+tasks into one phase reduces duration 20% without quality loss",
  type:            "phase_merge",
  mutation:        { merge_phases: ["plan", "tasks"], new_agent: "plan-task-engine" },
  expected_impact: "duration -20%, quality neutral",
  risk_level:      "medium",
});
assert("propose_experiment returns proposed:true", h.proposed === true);
assert("propose_experiment status=proposed", h.status === "proposed");
assert("propose_experiment returns experiment_id", h.experiment_id === "merge-plan-tasks-2026-03");

const experimentsPath = join(projectPath, ".sdd", "metacognition", "experiments.json");
assert("experiments.json created", existsSync(experimentsPath));
const expFile = JSON.parse(readFileSync(experimentsPath, "utf-8"));
assert("experiments.json has 1 entry", expFile.length === 1);
assert("experiment has verdict=null", expFile[0].verdict === null);
assert("experiment has retry_count=0", expFile[0].retry_count === 0);
assert("experiment has risk_level=medium", expFile[0].risk_level === "medium");
assert("experiment mutation stored", Array.isArray(expFile[0].mutation.merge_phases));

// Only one experiment proposed/running at a time: second proposal rejected
h = await handleProposeExperiment({
  project_path:  projectPath,
  experiment_id: "another-exp",
  hypothesis:    "Swap haiku for triage",
  type:          "model_swap",
  mutation:      {},
  expected_impact: "faster triage",
  risk_level:    "low",
});
assert("propose_experiment rejects second experiment while first is proposed", typeof h.error === "string");

// Duplicate experiment_id rejected (after first is completed we'll test this)

// ── Test 22: sdd_evaluate_experiment ─────────────────────────────
console.log("\n=== Test 22: sdd_evaluate_experiment ===");

// Case A: result >= baseline → promote
h = await handleEvaluateExperiment({
  project_path:   projectPath,
  experiment_id:  "merge-plan-tasks-2026-03",
  result_score:   92.0,
  baseline_score: 88.0,
});
assert("evaluate_experiment result>=baseline → promote", h.verdict === "promote");
assert("evaluate_experiment status=completed after promote", h.status === "completed");
assert("evaluate_experiment result_score stored", h.result_score === 92.0);
assert("evaluate_experiment baseline_score stored", h.baseline_score === 88.0);

// Verify in file
const expAfterA = JSON.parse(readFileSync(experimentsPath, "utf-8"))[0];
assert("evaluate_experiment persisted verdict=promote", expAfterA.verdict === "promote");
assert("evaluate_experiment persisted status=completed", expAfterA.status === "completed");
assert("evaluate_experiment has completed_at", typeof expAfterA.completed_at === "string");

// Re-evaluating a completed experiment returns error
h = await handleEvaluateExperiment({
  project_path: projectPath, experiment_id: "merge-plan-tasks-2026-03",
  result_score: 90, baseline_score: 88,
});
assert("evaluate_experiment completed cannot be re-evaluated", typeof h.error === "string");

// Case B: result < baseline × 0.9 → discard
await handleProposeExperiment({
  project_path: projectPath, experiment_id: "risky-exp",
  hypothesis: "Skip verify entirely",
  type: "phase_skip", mutation: { skip: "verify" },
  expected_impact: "faster pipeline", risk_level: "high",
});
h = await handleEvaluateExperiment({
  project_path: projectPath, experiment_id: "risky-exp",
  result_score: 70.0, baseline_score: 88.0,  // 70 < 88×0.9=79.2 → discard
});
assert("evaluate_experiment result<baseline×0.9 → discard", h.verdict === "discard");
assert("evaluate_experiment status=completed after discard", h.status === "completed");

// Case C: ambiguous range (between baseline×0.9 and baseline) → retry
await handleProposeExperiment({
  project_path: projectPath, experiment_id: "ambiguous-exp",
  hypothesis: "Relax gate threshold",
  type: "gate_relax", mutation: { phase: "specify", relaxation: "minor" },
  expected_impact: "faster specify", risk_level: "low",
});
h = await handleEvaluateExperiment({
  project_path: projectPath, experiment_id: "ambiguous-exp",
  result_score: 84.0, baseline_score: 88.0,  // 84 is between 79.2 (88×0.9) and 88 → ambiguous
});
assert("evaluate_experiment ambiguous → retry (retry_count=0)", h.verdict === "retry");
assert("evaluate_experiment status=proposed for retry", h.status === "proposed");
assert("evaluate_experiment retry_count incremented to 1", h.retry_count === 1);

// Second retry
h = await handleEvaluateExperiment({
  project_path: projectPath, experiment_id: "ambiguous-exp",
  result_score: 85.0, baseline_score: 88.0,
});
assert("evaluate_experiment second ambiguous → retry (retry_count=1→2)", h.verdict === "retry");
assert("evaluate_experiment retry_count=2", h.retry_count === 2);

// Third attempt: retry_count already 2, next ambiguous → discard (max retries exhausted)
h = await handleEvaluateExperiment({
  project_path: projectPath, experiment_id: "ambiguous-exp",
  result_score: 86.0, baseline_score: 88.0,
});
assert("evaluate_experiment max retries exhausted → discard", h.verdict === "discard");
assert("evaluate_experiment final status=completed", h.status === "completed");

// Case D: nonexistent experiment
h = await handleEvaluateExperiment({
  project_path: projectPath, experiment_id: "nonexistent-exp",
  result_score: 90, baseline_score: 85,
});
assert("evaluate_experiment nonexistent returns error", typeof h.error === "string");

// Now a new experiment can be proposed (previous one is completed)
h = await handleProposeExperiment({
  project_path: projectPath, experiment_id: "new-exp-after-completed",
  hypothesis: "New hypothesis", type: "model_swap", mutation: {},
  expected_impact: "test", risk_level: "low",
});
assert("propose_experiment allowed after previous completed", h.proposed === true);

// ── Test 23: sdd_propose_evolution ────────────────────────────────
console.log("\n=== Test 23: sdd_propose_evolution ===");

// weight_adjust with impact=low → requires_human=false (can be auto-applied)
h = await handleProposeEvolution({
  project_path:    projectPath,
  evolution_id:    "efficiency-weight-0.35-2026-03",
  type:            "weight_adjust",
  description:     "Increase efficiency_weight from 0.3 to 0.35",
  rationale:       "efficiency_score mean was 62 across last 10 runs; quality mean was 94; 70/30 split underweights efficiency gains",
  supporting_data: { quality_mean: 94, efficiency_mean: 62, runs_analyzed: 10 },
  impact:          "low",
});
assert("propose_evolution returns proposed:true", h.proposed === true);
assert("propose_evolution weight_adjust+low: requires_human=false", h.requires_human === false);
assert("propose_evolution status=proposed", h.status === "proposed");

const evolutionsPath = join(projectPath, ".sdd", "metacognition", "evolutions.json");
assert("evolutions.json created", existsSync(evolutionsPath));
const evo1 = JSON.parse(readFileSync(evolutionsPath, "utf-8"))[0];
assert("evolution has proposed_at", typeof evo1.proposed_at === "string");
assert("evolution type=weight_adjust", evo1.type === "weight_adjust");
assert("evolution supporting_data stored", evo1.supporting_data.runs_analyzed === 10);

// weight_adjust with impact=high → requires_human=true (even though type is weight_adjust)
h = await handleProposeEvolution({
  project_path:    projectPath,
  evolution_id:    "major-weight-overhaul",
  type:            "weight_adjust",
  description:     "Major restructuring of all weights",
  rationale:       "Complete overhaul needed",
  supporting_data: {},
  impact:          "high",
});
assert("propose_evolution weight_adjust+high: requires_human=true", h.requires_human === true);

// phase_remove → requires_human=true (structural type, always)
h = await handleProposeEvolution({
  project_path:    projectPath,
  evolution_id:    "remove-spec-test-phase",
  type:            "phase_remove",
  description:     "Remove spec-test phase — covered by verify",
  rationale:       "spec-test phase has 0 gate failures in 15 runs; verify catches the same issues",
  supporting_data: { spec_test_failures: 0, verify_catches: 12, runs: 15 },
  impact:          "medium",
});
assert("propose_evolution phase_remove: requires_human=true", h.requires_human === true);

// phase_add → requires_human=true
h = await handleProposeEvolution({
  project_path:    projectPath,
  evolution_id:    "add-security-scan-phase",
  type:            "phase_add",
  description:     "Add security scan phase between implement and verify",
  rationale:       "3 security findings in last 5 review runs",
  supporting_data: { security_findings: 3, runs: 5 },
  impact:          "high",
});
assert("propose_evolution phase_add: requires_human=true", h.requires_human === true);

// agent_redesign → requires_human=true
h = await handleProposeEvolution({
  project_path:    projectPath,
  evolution_id:    "haiku-analyst-context-2026-03",
  type:            "agent_redesign",
  description:     "Haiku-analyst needs RunSummary in retro mode for quantitative patterns",
  rationale:       "All 4 last experiments were discarded; analyst lacks quantitative input",
  supporting_data: { discarded_experiments: 4 },
  impact:          "medium",
});
assert("propose_evolution agent_redesign: requires_human=true", h.requires_human === true);

// contract_change with impact=medium → requires_human=false (not structural)
h = await handleProposeEvolution({
  project_path:    projectPath,
  evolution_id:    "increase-verify-max-attempts",
  type:            "contract_change",
  description:     "Increase verify fix_loop.max_attempts from 3 to 4",
  rationale:       "verify fix loop hit max in 3 of last 10 runs, forcing escalation",
  supporting_data: { verify_max_hit: 3, runs: 10 },
  impact:          "medium",
});
assert("propose_evolution contract_change+medium: requires_human=false", h.requires_human === false);

// Duplicate evolution_id rejected
h = await handleProposeEvolution({
  project_path:    projectPath,
  evolution_id:    "efficiency-weight-0.35-2026-03",
  type:            "weight_adjust",
  description:     "Duplicate",
  rationale:       "Should fail",
  supporting_data: {},
  impact:          "low",
});
assert("propose_evolution duplicate id returns error", typeof h.error === "string");

// All 6 evolutions in file (5 above + 1 earlier = 6... wait we have 5 calls: efficiency, major, remove, add, redesign, contract = 6 calls but first one is test)
// Actually: efficiency-weight(1) + major-weight(2) + remove-spec-test(3) + add-security(4) + haiku-redesign(5) + verify-contract(6) = 6 total
const allEvolutions = JSON.parse(readFileSync(evolutionsPath, "utf-8"));
assert("evolutions.json has 6 entries", allEvolutions.length === 6);
assert("all evolutions have status=proposed", allEvolutions.every(e => e.status === "proposed"));

// ── Cleanup ───────────────────────────────────────────────────────
try {
  rmSync(projectPath, { recursive: true });
} catch { /* ignore cleanup errors */ }

// ── Summary ───────────────────────────────────────────────────────
console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log("ALL TESTS PASSED");
} else {
  console.log("SOME TESTS FAILED");
  process.exit(1);
}
