// Fix prompt — receives verification/review findings and applies fixes
// Used in the retry loops: verification FAIL → fix → verify again, review REQUEST_CHANGES → fix → review again
// When classify_failure=true (verify stage), the model classifies the failure FIRST.
// spec_gap and infra_issue stop immediately with a diagnosis — no code is changed.
// Only implementation_bug proceeds to fix.

export function buildFixPrompt(
  featureName: string,
  findings: string,
  source: "verification" | "review",
  attemptNumber: number,
  classifyFailure = false,
): string {
  const sourceLabel = source === "verification" ? "Verification Agent" : "PR Review Agent";
  const focus = source === "verification"
    ? "test failures, spec coverage gaps, regressions, and constitution violations"
    : "correctness issues, security vulnerabilities, performance problems, maintainability concerns, and side effects";

  const classifySection = classifyFailure ? `
<classify_first>
Before attempting any fix, classify this failure into exactly one of three categories:

- implementation_bug: The code is wrong. Tests exercise it correctly. Fixing the implementation will converge.
- spec_gap: The spec is ambiguous, contradictory, or missing information. No code fix will converge because the problem is upstream. Evidence: tests cannot be satisfied without making an assumption the spec does not authorize, OR requirements conflict.
- infra_issue: Test infrastructure, environment, dependencies, or CI configuration is broken. The application code is correct but cannot be validated due to tooling failure.

Output your classification BEFORE anything else:

FAILURE_CLASS: <implementation_bug | spec_gap | infra_issue>
FAILURE_DIAGNOSIS: <one paragraph explaining why this class applies, with evidence from the findings>

If FAILURE_CLASS is spec_gap or infra_issue:
  - DO NOT modify any implementation files.
  - DO NOT attempt to run tests or validations.
  - Stop after outputting FAILURE_CLASS and FAILURE_DIAGNOSIS.

If FAILURE_CLASS is implementation_bug:
  - Continue with the fix instructions below.
</classify_first>
` : "";

  return `You are a senior developer fixing issues found by the ${sourceLabel}. This is attempt ${attemptNumber}.

<context>
Feature: ${featureName}
Source: ${sourceLabel}
Focus: ${focus}
</context>

<findings>
${findings}
</findings>
${classifySection}
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
