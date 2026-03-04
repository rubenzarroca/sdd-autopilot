// E2E mechanical test — verifies all components without calling the Anthropic API

const projectPath = "C:/Users/rzarroca/AppData/Local/Temp/test-sdd-autopilot";

import { StateManager } from "./build/state.js";
import { buildSpecifyPrompt } from "./build/prompts/specify.js";
import { buildPlanPrompt } from "./build/prompts/plan.js";
import { buildTasksPrompt } from "./build/prompts/tasks.js";
import { buildImplementPrompt } from "./build/prompts/implement.js";
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
assert("8 transition states", Object.keys(state.allowed_transitions).length === 8);

await sm.createFeature("health-check");
let f = await sm.getFeature("health-check");
assert("feature created in drafting", f.state === "drafting");

let r;
r = await sm.transition("health-check", "specified", "test");
assert("drafting → specified", r.ok === true);

r = await sm.transition("health-check", "planned", "test");
assert("specified → planned", r.ok === true);

r = await sm.transition("health-check", "tasked", "test");
assert("planned → tasked", r.ok === true);

r = await sm.transition("health-check", "implementing", "test");
assert("implementing blocked (no tasks)", r.ok === false);

// Add a task
const s2 = await sm.read();
s2.features["health-check"].tasks = {
  "TASK-001": { status: "pending", title: "Create endpoint" },
};
await sm.write(s2);

r = await sm.transition("health-check", "implementing", "test");
assert("tasked → implementing (with task)", r.ok === true);

r = await sm.transition("health-check", "verifying", "test");
assert("verifying blocked (task pending)", r.ok === false);

await sm.markTaskCompleted("health-check", "TASK-001");
r = await sm.transition("health-check", "verifying", "test");
assert("implementing → verifying (task done)", r.ok === true);

r = await sm.transition("health-check", "reviewing", "test");
assert("verifying → reviewing", r.ok === true);

r = await sm.transition("health-check", "completed", "test");
assert("reviewing → completed", r.ok === true);

r = await sm.transition("health-check", "drafting", "test");
assert("completed → drafting blocked", r.ok === false);

const inc = await sm.incrementAttempt("health-check", "verification");
assert("incrementAttempt returns 1", inc === 1);

// Verify transition history (drafting→specified→planned→tasked→implementing→verifying→reviewing→completed = 7)
f = await sm.getFeature("health-check");
assert(`${f.transitions.length} transitions recorded`, f.transitions.length >= 6);

// ── Test 2: Prompts ─────────────────────────────────────────────
console.log("\n=== Test 2: Prompt Generation ===");

const prompts = {
  specify: buildSpecifyPrompt("health check", projectPath),
  plan: buildPlanPrompt("health-check"),
  tasks: buildTasksPrompt("health-check"),
  implement: buildImplementPrompt("health-check"),
  verify: buildVerifyPrompt("health-check"),
  review: buildReviewPrompt("health-check"),
  fix: buildFixPrompt("health-check", "[]", "verification", 1),
};

for (const [name, prompt] of Object.entries(prompts)) {
  assert(
    `${name} prompt (${prompt.length} chars)`,
    prompt.length > 100 &&
      (prompt.includes("health-check") || prompt.includes("health check"))
  );
}

// ── Test 3: Tool Definitions ────────────────────────────────────
console.log("\n=== Test 3: Tool Definitions ===");

assert("CODE_EXECUTION_TOOL type", CODE_EXECUTION_TOOL.type === "code_execution_20260120");
assert("8 tools defined", TOOLS.length === 8);

const toolNames = TOOLS.map((t) => t.name);
assert("has read_file", toolNames.includes("read_file"));
assert("has write_file", toolNames.includes("write_file"));
assert("has edit_file", toolNames.includes("edit_file"));
assert("has list_dir", toolNames.includes("list_dir"));
assert("has read_state", toolNames.includes("read_state"));
assert("has write_state", toolNames.includes("write_state"));
assert("has run_shell", toolNames.includes("run_shell"));
assert("has search_code", toolNames.includes("search_code"));

const allHaveCallers = TOOLS.every((t) =>
  t.allowed_callers?.includes("code_execution_20260120")
);
assert("all tools have allowed_callers", allHaveCallers);

// ── Test 4: Handler Execution ───────────────────────────────────
console.log("\n=== Test 4: Handlers ===");

const ctx = { projectPath };

let h;
h = await executeToolCall("read_file", { path: "package.json" }, ctx);
assert("read_file package.json", typeof h.data?.content === "string" && h.data.content.includes("test-sdd-autopilot"));

h = await executeToolCall("list_dir", { path: "." }, ctx);
assert("list_dir returns entries", Array.isArray(h.data?.entries) && h.data.entries.length > 0);

h = await executeToolCall("write_file", { path: "test-output.txt", content: "hello world" }, ctx);
assert("write_file succeeds", h.data?.success === true);

h = await executeToolCall("read_file", { path: "test-output.txt" }, ctx);
assert("read written file", h.data?.content === "hello world");

h = await executeToolCall("edit_file", { path: "test-output.txt", old_string: "hello", new_string: "goodbye" }, ctx);
assert("edit_file succeeds", h.data?.success === true);

h = await executeToolCall("read_file", { path: "test-output.txt" }, ctx);
assert("edit verified", h.data?.content === "goodbye world");

h = await executeToolCall("run_shell", { command: "echo test123" }, ctx);
assert("run_shell", h.data?.stdout === "test123");

h = await executeToolCall("read_state", {}, ctx);
assert("read_state returns version", h.data?.version === "2.0.0");

h = await executeToolCall("search_code", { pattern: "test-sdd", path: "." }, ctx);
assert("search_code", typeof h.data?.count === "number");

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

// ── Summary ─────────────────────────────────────────────────────
console.log(`\n${"═".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log("ALL TESTS PASSED ✓");
} else {
  console.log("SOME TESTS FAILED ✗");
  process.exit(1);
}
