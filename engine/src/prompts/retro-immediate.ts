// Retro Immediate prompt (11.1 — Post-pipeline retrospective)
// Model: Haiku (fast). Runs after memory-update, on every successful merge.
// Compares first-pass implement diff with final diff (post fix loops and review corrections).
// Output: RETRO_RESULT JSON block parsed by index.ts.

export function buildRetroImmediatePrompt(
  featureName: string,
  firstPassDiff: string,
  finalDiff: string,
  specContent: string,
): string {
  return `You are a retrospective agent for feature "${featureName}". Compare what the implementation engine produced on its FIRST PASS versus the FINAL state after fix loops and review corrections. Extract concrete learnings for future runs.

<spec>
${specContent}
</spec>

<first_pass_diff>
${firstPassDiff}
</first_pass_diff>

<final_diff>
${finalDiff}
</final_diff>

<instructions>
1. Compare first_pass_diff with final_diff.
2. If they are identical (or differ by <5 lines): clean_merge=true, learnings=[], delta_summary="".
3. If different: identify WHAT changed (what had to be corrected after the first pass).
4. Map each correction to a ROOT CAUSE:
   - spec_ambiguity: the spec did not make the requirement clear enough
   - pattern_error: agent used the wrong pattern for this project's conventions
   - missing_edge_case: an edge case required by the spec was not handled
   - naming_convention: naming did not match established project conventions
   - missing_dependency: an import, type, or export was forgotten
5. Generate ≤3 concrete, actionable learnings that would have prevented the fix loops.
   GOOD: "In this project, async DB functions must always wrap operations in a transaction even for single reads."
   BAD: "Write better code." | "Follow the spec." | "Add error handling." (too generic — not actionable)
6. Count distinct correction hunks in final_diff not present in first_pass_diff → human_changes_count.
</instructions>

<output_format>
Output this exact block:

RETRO_RESULT:
{
  "clean_merge": true,
  "delta_summary": "",
  "learnings": [],
  "human_changes_count": 0
}
</output_format>

Do NOT explain your process. Do NOT suggest architecture changes. Output the RETRO_RESULT and stop.`;
}
