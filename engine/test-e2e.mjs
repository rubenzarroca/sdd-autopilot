// E2E mechanical test — verifies all components without calling the Anthropic API
// Updated for v2: new state machine, agent permissions, 9 tools, transition_state/append_signal

const projectPath = "C:/Users/rzarroca/AppData/Local/Temp/test-sdd-autopilot";

import { StateManager } from "./build/state.js";
import { buildSpecifyPrompt } from "./build/prompts/specify.js";
import { buildPlanPrompt } from "./build/prompts/plan.js";
import { buildTasksPrompt } from "./build/prompts/tasks.js";
import { buildImplementPrompt, buildImplementTaskPrompt } from "./build/prompts/implement.js";
import { buildVerifyPrompt } from "./build/prompts/verify.js";
import { buildReviewPrompt } from "./build/prompts/review.js";
import { buildFixPrompt } from "./build/prompts/fix.js";
import { TOOLS, CODE_EXECUTION_TOOL } from "./build/tools.js";
import { executeToolCall } from "./build/handlers.js";

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

// ── Test 1: State Management ────────────────────────────────────
console.log("\n=== Test 1: State Management ===");

const sm = new StateManager(projectPath);
await sm.init("test-sdd-autopilot");
const state = await sm.read();
assert("version is 2.0.0", state.version === "2.0.0");
assert("project name", state.project === "test-sdd-autopilot");
assert("no allowed_transitions in state (governance moved to code)", state.allowed_transitions === undefined);
assert("active_feature is null", state.active_feature === null);

await sm.createFeature("health-check");
let f = await sm.getFeature("health-check");
assert("feature created in draft", f.state === "draft");
assert("feature has empty tasks", Object.keys(f.tasks).length === 0);
assert("feature has empty signals", f.signals.length === 0);

let r;
r = await sm.transition("health-check", "specified", "spec-generator", "spec generated");
assert("draft → specified (spec-generator)", r.ok === true);

r = await sm.transition("health-check", "specified", "spec-generator", "re-specify");
assert("specified → specified blocked (no self-transition edge)", r.ok === false);

r = await sm.transition("health-check", "planned", "plan-generator", "plan generated");
assert("specified → planned (plan-generator)", r.ok === true);

// planned → decomposed is valid for task-decomposer but not spec-generator → UNAUTHORIZED
r = await sm.transition("health-check", "decomposed", "spec-generator", "wrong agent");
assert("planned → decomposed by spec-generator is UNAUTHORIZED (not its edge)", r.ok === false && r.code === "UNAUTHORIZED");

r = await sm.transition("health-check", "decomposed", "task-decomposer", "tasks decomposed");
assert("planned → decomposed (task-decomposer)", r.ok === true);

r = await sm.transition("health-check", "implementing", "implementation-engine", "start impl");
assert("decomposed → implementing blocked (no tasks)", r.ok === false && r.code === "PRECONDITION_FAILED");

// Add tasks
const s2 = await sm.read();
s2.features["health-check"].tasks = {
  "TASK-001": { status: "pending", title: "Create endpoint" },
  "TASK-002": { status: "pending", title: "Add tests" },
};
await sm.write(s2);

r = await sm.transition("health-check", "implementing", "implementation-engine", "start impl");
assert("decomposed → implementing (with tasks)", r.ok === true);

r = await sm.transition("health-check", "verifying", "verification-engine", "start verify");
assert("implementing → verifying blocked (tasks pending)", r.ok === false && r.code === "PRECONDITION_FAILED");

// Complete tasks
await sm.markTaskCompleted("health-check", "TASK-001");
await sm.markTaskCompleted("health-check", "TASK-002");

r = await sm.transition("health-check", "verifying", "verification-engine", "all tasks done");
assert("implementing → verifying (tasks done)", r.ok === true);
f = await sm.getFeature("health-check");
assert("verification_attempts incremented to 1", f.verification_attempts === 1);

r = await sm.transition("health-check", "fix_loop", "verification-engine", "tests failed");
assert("verifying → fix_loop (verification-engine)", r.ok === true);
f = await sm.getFeature("health-check");
assert("fix_loop_attempts incremented to 1", f.fix_loop_attempts === 1);

r = await sm.transition("health-check", "implementing", "fix-engine", "fixed bug");
assert("fix_loop → implementing (fix-engine)", r.ok === true);

// Complete tasks again so we can re-verify
const s3 = await sm.read();
s3.features["health-check"].tasks["TASK-001"].status = "completed";
s3.features["health-check"].tasks["TASK-002"].status = "completed";
await sm.write(s3);

r = await sm.transition("health-check", "verifying", "verification-engine", "re-verify");
assert("implementing → verifying (second attempt)", r.ok === true);
f = await sm.getFeature("health-check");
assert("verification_attempts incremented to 2", f.verification_attempts === 2);

r = await sm.transition("health-check", "reviewing", "verification-engine", "PASS");
assert("verifying → reviewing (PASS)", r.ok === true);
f = await sm.getFeature("health-check");
assert("review_attempts incremented to 1", f.review_attempts === 1);

r = await sm.transition("health-check", "pr_created", "adversarial-reviewer", "APPROVE");
assert("reviewing → pr_created (adversarial-reviewer APPROVE)", r.ok === true);

r = await sm.transition("health-check", "merged", "git-operator", "merged to main");
assert("pr_created → merged (git-operator)", r.ok === true);

// Terminal state — active_feature should be null
const finalState = await sm.read();
assert("active_feature null after merge", finalState.active_feature === null);

r = await sm.transition("health-check", "draft", "orchestrator", "restart");
assert("merged → draft blocked (no such edge)", r.ok === false);

// Escalation — orchestrator can always escalate from any state
await sm.createFeature("troubled-feature");
await sm.transition("troubled-feature", "specified", "spec-generator", "spec");
r = await sm.transition("troubled-feature", "escalated", "orchestrator", "hard stop");
assert("any → escalated via orchestrator (special rule)", r.ok === true);

// Signal append
const sigResult = await sm.appendSignal("health-check", "verification-engine", "CONTEXT_NOTE", { note: "clean" });
assert("appendSignal returns ok+signal", sigResult.ok === true && sigResult.signal?.id != null);

// Transition history
f = await sm.getFeature("health-check");
assert("multiple transitions recorded", f.transitions.length >= 8);

// ── Test 2: Prompts ─────────────────────────────────────────────
console.log("\n=== Test 2: Prompt Generation ===");

const taskBlock = `## TASK-001: Create health endpoint\n**Files:** src/routes/health.ts\n**Validation:** curl localhost:3000/health`;

const prompts = {
  specify:           buildSpecifyPrompt("health check endpoint", projectPath),
  plan:              buildPlanPrompt("health-check"),
  tasks:             buildTasksPrompt("health-check"),
  implement_v1:      buildImplementPrompt("health-check"),
  implement_v2_task: buildImplementTaskPrompt("health-check", taskBlock),
  verify:            buildVerifyPrompt("health-check"),
  review:            buildReviewPrompt("health-check"),
  fix:               buildFixPrompt("health-check", "[]", "verification", 1),
  fix_classify:      buildFixPrompt("health-check", "[{findings}]", "verification", 2, true),
};

for (const [name, prompt] of Object.entries(prompts)) {
  assert(
    `${name} prompt (${prompt.length} chars)`,
    prompt.length > 100 &&
      (prompt.includes("health-check") || prompt.includes("health check") || prompt.includes("health"))
  );
}

// Verify classify section is conditional
assert("fix no classify section by default", !prompts.fix.includes("FAILURE_CLASS"));
assert("fix_classify includes classify section", prompts.fix_classify.includes("FAILURE_CLASS"));

// ── Test 3: Tool Definitions ────────────────────────────────────
console.log("\n=== Test 3: Tool Definitions ===");

assert("CODE_EXECUTION_TOOL type", CODE_EXECUTION_TOOL.type === "code_execution_20260120");
assert("9 tools defined", TOOLS.length === 9);

const toolNames = TOOLS.map((t) => t.name);
assert("has read_file",        toolNames.includes("read_file"));
assert("has write_file",       toolNames.includes("write_file"));
assert("has edit_file",        toolNames.includes("edit_file"));
assert("has list_dir",         toolNames.includes("list_dir"));
assert("has read_state",       toolNames.includes("read_state"));
assert("has transition_state", toolNames.includes("transition_state"));
assert("has append_signal",    toolNames.includes("append_signal"));
assert("has run_shell",        toolNames.includes("run_shell"));
assert("has search_code",      toolNames.includes("search_code"));
assert("no write_state (replaced by transition_state)", !toolNames.includes("write_state"));

const allHaveCallers = TOOLS.every((t) =>
  t.allowed_callers?.includes("code_execution_20260120")
);
assert("all tools have allowed_callers", allHaveCallers);

// ── Test 4: Handler Execution ───────────────────────────────────
console.log("\n=== Test 4: Handlers ===");

const ctx = { projectPath };

let h;

// read_state — project was init'd in Test 1
h = await executeToolCall("read_state", {}, ctx);
assert("read_state returns version", h.data?.version === "2.0.0");
assert("read_state returns project name", h.data?.project === "test-sdd-autopilot");

// list_dir
h = await executeToolCall("list_dir", { path: "." }, ctx);
assert("list_dir returns entries", Array.isArray(h.data?.entries) && h.data.entries.length > 0);
assert("list_dir contains .sdd/", h.data?.entries.some(e => e.includes(".sdd")));

// write_file + read_file + edit_file
h = await executeToolCall("write_file", { path: "test-output.txt", content: "hello world" }, ctx);
assert("write_file succeeds", h.data?.success === true);

h = await executeToolCall("read_file", { path: "test-output.txt" }, ctx);
assert("read written file", h.data?.content === "hello world");

h = await executeToolCall("edit_file", { path: "test-output.txt", old_string: "hello", new_string: "goodbye" }, ctx);
assert("edit_file succeeds", h.data?.success === true);

h = await executeToolCall("read_file", { path: "test-output.txt" }, ctx);
assert("edit verified", h.data?.content === "goodbye world");

// edit_file error: old_string not found
h = await executeToolCall("edit_file", { path: "test-output.txt", old_string: "nonexistent", new_string: "x" }, ctx);
assert("edit_file not found returns error", typeof h.data?.error === "string");

// run_shell
h = await executeToolCall("run_shell", { command: "echo test123" }, ctx);
assert("run_shell stdout", h.data?.stdout === "test123");

// transition_state via handler
h = await executeToolCall("transition_state", {
  feature_name: "health-check",
  to_state: "draft",
  agent_id: "spec-generator",
  command: "restart",
}, ctx);
assert("transition_state unauthorized via handler returns ok:false", h.data?.ok === false);

// append_signal via handler
h = await executeToolCall("append_signal", {
  feature_name: "health-check",
  from_agent: "implementation-engine",
  signal_type: "PATTERN_DETECTED",
  payload: { pattern: "N+1 query", location: "src/routes/health.ts:42" },
}, ctx);
assert("append_signal via handler ok:true", h.data?.ok === true);

// search_code
h = await executeToolCall("search_code", { pattern: "test-sdd", path: "." }, ctx);
assert("search_code returns count", typeof h.data?.count === "number");

// unknown tool
h = await executeToolCall("unknown_tool", {}, ctx);
assert("unknown_tool rejected", typeof h.data?.error === "string");

// ── Test 5: Result Parsing ──────────────────────────────────────
console.log("\n=== Test 5: Result Parsing ===");

const verifyText =
  'Analysis...\nVERIFICATION_RESULT:\n{"status": "PASS", "findings": [], "tests_total": 5, "tests_passed": 5, "tests_failed": 0, "spec_coverage_pct": 95, "regression_clean": true, "constitution_clean": true\n}';
const verifyMatch = verifyText.match(/VERIFICATION_RESULT:\s*(\{[\s\S]*?\n\})/);
const vr = verifyMatch ? JSON.parse(verifyMatch[1]) : null;
assert("parse VERIFICATION_RESULT PASS", vr?.status === "PASS" && vr.tests_total === 5);

const failText =
  'Issues...\nVERIFICATION_RESULT:\n{"status": "FAIL", "findings": [{"category": "tests_failing", "description": "2 tests failed", "evidence": "FAIL src/test.ts"}], "tests_total": 10, "tests_passed": 8, "tests_failed": 2, "spec_coverage_pct": 70, "regression_clean": true, "constitution_clean": true\n}';
const failMatch = failText.match(/VERIFICATION_RESULT:\s*(\{[\s\S]*?\n\})/);
const vf = failMatch ? JSON.parse(failMatch[1]) : null;
assert("parse VERIFICATION_RESULT FAIL", vf?.status === "FAIL" && vf.findings.length === 1);

const specGapText =
  'Ambiguity...\nVERIFICATION_RESULT:\n{"status": "SPEC_GAP", "findings": [{"category": "spec_coverage_gap", "description": "FR-003 not defined", "evidence": "spec.md line 42"}], "tests_total": 0, "tests_passed": 0, "tests_failed": 0, "spec_coverage_pct": 60, "regression_clean": true, "constitution_clean": true\n}';
const specGapMatch = specGapText.match(/VERIFICATION_RESULT:\s*(\{[\s\S]*?\n\})/);
const sg = specGapMatch ? JSON.parse(specGapMatch[1]) : null;
assert("parse VERIFICATION_RESULT SPEC_GAP", sg?.status === "SPEC_GAP");

const reviewText =
  'Review...\nREVIEW_RESULT:\n{"decision": "APPROVE", "issues": [], "warnings": [{"category": "maintainability", "severity": "warning", "description": "Could use helper", "evidence": "line 42"}], "summary": "Clean implementation"\n}';
const reviewMatch = reviewText.match(/REVIEW_RESULT:\s*(\{[\s\S]*?\n\})/);
const rr = reviewMatch ? JSON.parse(reviewMatch[1]) : null;
assert("parse REVIEW_RESULT APPROVE", rr?.decision === "APPROVE" && rr.warnings.length === 1);

const rejectText =
  'Issues...\nREVIEW_RESULT:\n{"decision": "REQUEST_CHANGES", "issues": [{"category": "security", "severity": "blocking", "description": "SQL injection", "evidence": "line 15"}], "warnings": [], "summary": "Security issue found"\n}';
const rejectMatch = rejectText.match(/REVIEW_RESULT:\s*(\{[\s\S]*?\n\})/);
const rj = rejectMatch ? JSON.parse(rejectMatch[1]) : null;
assert("parse REVIEW_RESULT REQUEST_CHANGES", rj?.decision === "REQUEST_CHANGES" && rj.issues.length === 1);

// Fix classify parsing
const classifyText =
  'Before fix...\nFAILURE_CLASS: implementation_bug\nFAILURE_DIAGNOSIS: The handler returns 500 instead of 404 for missing resources.\n';
const classMatch = classifyText.match(/FAILURE_CLASS:\s*(\S+)/);
assert("parse FAILURE_CLASS", classMatch?.[1] === "implementation_bug");

// ── Summary ─────────────────────────────────────────────────────
console.log(`\n${"═".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log("ALL TESTS PASSED ✓");
} else {
  console.log("SOME TESTS FAILED ✗");
  process.exit(1);
}
