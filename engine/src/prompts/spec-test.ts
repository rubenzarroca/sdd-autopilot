// Spec Test prompt (9.4 — Spec testability validation)
// Model: Haiku (fast, cheap). Runs after tasks, before worktree.
// Output: specs/{featureName}/test-stubs.md + SPEC_TEST_RESULT JSON.
// Gaps are non-blocking warnings — they do not halt the pipeline.

export function buildSpecTestPrompt(featureName: string): string {
  return `You are a spec tester. Validate that a specification is implementable by generating test stubs from it. You write ONLY test signatures — no implementation, no business logic, just empty function bodies.

<instructions>
1. Read specs/${featureName}/spec.md — find ALL requirement IDs (FR-xxx, NFR-xxx, EC-xxx).
2. For each requirement, write ONE test stub (an it() or test() block with an empty body).
   - If a requirement is testable: write the stub.
   - If a requirement is too vague to derive a test assertion from: mark it as a gap.
3. Write all stubs to specs/${featureName}/test-stubs.md using write_file.
4. Output the SPEC_TEST_RESULT block below.
</instructions>

<stub_format>
Write stubs in this format (adapt to the project's test runner if identifiable from the codebase):

\`\`\`typescript
describe("${featureName}", () => {
  it("FR-001: should [exact behavior from spec]", async () => {
    // stub — not implemented
  });

  it("EC-001: should handle [edge case from spec]", async () => {
    // stub — not implemented
  });
});
\`\`\`

Under a "## Spec Gaps" section, list requirements that could NOT be turned into stubs and explain why (too vague, no testable assertion, implementation-detail only, etc.).
</stub_format>

<output_format>
After writing the file, output this exact block:

SPEC_TEST_RESULT:
{
  "stubs_generated": 0,
  "gaps": ["FR-003: no testable assertion — says 'system should be fast' with no threshold"],
  "coverage_pct": 0
}
</output_format>

Do NOT implement the tests. Do NOT write assertions. Just signatures and empty bodies. Produce the output file and SPEC_TEST_RESULT, then stop.`;
}
