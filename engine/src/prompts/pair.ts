// Pair programming prompts — Opus-as-coach pattern (section 7)
// Opus reviews Sonnet's artifact adversarially. Only Sonnet modifies artifacts.
// Applied selectively to: specify, implement, verify (not plan, tasks, or review).
//
// Sequence per phase:
//   1. Sonnet produces artifact
//   2. Opus runs buildPairCoachPrompt → PAIR_FEEDBACK block
//   3. If overall=NEEDS_CORRECTION: Sonnet runs buildPairCorrectionPrompt → applies critical fixes
//   4. If overall=PASS (or after correction): advance to next stage

export type PairStage = "specify" | "implement" | "verify";

// ─── Opus coaching prompt ─────────────────────────────────────────
// Adversarial lens varies by stage. Opus never writes code or edits files.

export function buildPairCoachPrompt(stage: PairStage, artifact: string, featureName: string): string {
  const lens: Record<PairStage, string> = {
    specify: `Find ambiguities, contradictions, missing edge cases, scope creep, and untestable requirements.
Focus on: requirements without testable assertions, implicit assumptions the spec does not authorize,
conflicting constraints, missing error and boundary cases, and gaps that would cause spec_gap failures downstream.`,

    implement: `Find side effects, convention violations, unnecessary imports or changes, scope violations,
and missing error handling. Focus on: code that works but violates the spec's intent, imports not listed in
task scope, changes to files outside the task's scope, security implications of the approach, and state
mutations the spec does not authorize.`,

    verify: `Find important test cases that are missing. Focus on: edge cases mentioned in the spec but not
tested, error paths that are exercised but not asserted, security requirements without coverage, and tests
that verify implementation details rather than the specified behavior (brittle tests that will break on
valid refactors).`,
  };

  return `You are a senior Opus reviewer coaching a Sonnet implementation agent. Your role is advisory only — you never modify artifacts directly.

<context>
Feature: ${featureName}
Stage: ${stage}
</context>

<review_lens>
${lens[stage]}
</review_lens>

<artifact>
${artifact}
</artifact>

<instructions>
Review the artifact above with the adversarial lens for this stage. Be rigorous and specific.

For each issue, classify severity:
- critical: will cause downstream failures OR violates a hard constraint — Sonnet MUST fix this
- major: significant quality issue — Sonnet should address if possible, does not block advancement
- minor: low-impact note — logged as learning signal, does not block advancement

Output your review as a structured block. This MUST be the last thing you output.

PAIR_FEEDBACK: {
  "overall": "PASS" | "NEEDS_CORRECTION",
  "findings": [
    {
      "severity": "critical" | "major" | "minor",
      "description": "what is wrong — be specific, not generic",
      "location": "where in the artifact (section name, file:line, or requirement ID)",
      "suggestion": "what Sonnet should do — describe the change, do not write code"
    }
  ]
}

Rules:
- overall = "PASS" if zero critical findings (even if major/minor findings exist)
- overall = "NEEDS_CORRECTION" if one or more critical findings
- If the artifact is genuinely good, output PASS with empty findings — do not manufacture issues to seem thorough
- Vague findings like "improve error handling" are not actionable — be specific about what is wrong and where
</instructions>`;
}

// ─── Sonnet correction prompt ─────────────────────────────────────
// Sonnet reads Opus feedback and applies ONLY critical fixes.
// Major/minor findings are logged but do not trigger corrections.

export function buildPairCorrectionPrompt(
  stage: PairStage,
  feedbackJson: string,
  featureName: string,
): string {
  const scope: Record<PairStage, string> = {
    specify: `specs/${featureName}/spec.md — update the spec to resolve the findings`,
    implement: `the implementation files identified in the findings — make targeted fixes only`,
    verify: `the test files identified in the findings — add or update the described test cases`,
  };

  return `You are an implementation agent applying feedback from a senior Opus reviewer.

<context>
Feature: ${featureName}
Stage: ${stage}
Target: ${scope[stage]}
</context>

<feedback>
${feedbackJson}
</feedback>

<instructions>
Apply ONLY the critical findings from the feedback above.
Major and minor findings are already logged — do not address them now.

For each critical finding:
1. Read the file or section referenced in "location"
2. Apply the minimal change that resolves the finding
3. Do not refactor, add comments, or change anything outside the finding's exact scope

After applying all critical fixes:
- Re-read the updated section to verify the change is correct
- For spec stage: ensure all requirements remain testable assertions
- For implement stage: confirm no additional files were touched
- For verify stage: ensure new tests actually test the described behavior (not just satisfy coverage)

Output a brief confirmation:

PAIR_CORRECTIONS:
- Finding: {description} → Applied: {what was changed}
- (one line per critical finding)
</instructions>`;
}
