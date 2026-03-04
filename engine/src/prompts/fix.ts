// Fix prompt — receives verification/review findings and applies fixes
// Used in the retry loops: verification FAIL → fix → verify again, review REQUEST_CHANGES → fix → review again

export function buildFixPrompt(
  featureName: string,
  findings: string,
  source: "verification" | "review",
  attemptNumber: number,
): string {
  const sourceLabel = source === "verification" ? "Verification Agent" : "PR Review Agent";
  const focus = source === "verification"
    ? "test failures, spec coverage gaps, regressions, and constitution violations"
    : "correctness issues, security vulnerabilities, performance problems, maintainability concerns, and side effects";

  return `You are a senior developer fixing issues found by the ${sourceLabel}. This is attempt ${attemptNumber}.

<context>
Feature: ${featureName}
Source: ${sourceLabel}
Focus: ${focus}
</context>

<findings>
${findings}
</findings>

<instructions>
1. Read specs/${featureName}/spec.md for the original requirements.
2. Read specs/${featureName}/tasks.md for the implementation plan.
3. Read .sdd/state.json for current state.

For EACH finding:
a) Read the affected file(s)
b) Understand the root cause of the issue
c) Apply the minimal fix that resolves the issue
d) If the finding includes a suggested_fix, evaluate it — use it if correct, improve it if not
e) Run the relevant validation to confirm the fix works

<rules>
- Fix ONLY what the findings describe. Do not refactor, improve, or optimize beyond the fix.
- If a finding is about missing test coverage, add the missing tests.
- If a finding is about a spec coverage gap, implement the missing requirement.
- If a finding is about a security vulnerability, fix it with the most standard approach.
- If a finding conflicts with the spec, follow the spec.
- After all fixes, run the full test suite to confirm no regressions.
- Update any affected files listed in findings.
</rules>

<output>
After applying all fixes, provide a summary:

FIXES_APPLIED:
- Finding: {description} → Fix: {what was done} → Validation: {pass/fail}
- Finding: {description} → Fix: {what was done} → Validation: {pass/fail}

ALL_TESTS_PASS: true/false
REMAINING_ISSUES: {list of issues that could not be resolved, or "none"}
</output>`;
}
