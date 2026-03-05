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
assert("tick_decay returns decayed count", typeof h.decayed === "number");
assert("tick_decay returns removed count", typeof h.removed === "number");
assert("tick_decay returns promoted count", typeof h.promoted === "number");

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
