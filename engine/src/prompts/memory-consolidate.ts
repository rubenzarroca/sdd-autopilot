// Memory Consolidate prompt (10.4 — Periodic garbage collection)
// Model: Opus (high quality, runs rarely — every 10 runs per project).
// Input: current Learned Patterns + Run History sections.
// Output: CONSOLIDATION_RESULT JSON with cleaned patterns + cross-project candidates.

export function buildMemoryConsolidatePrompt(
  projectName: string,
  learnedPatterns: string,
  runHistory: string,
): string {
  return `You are a memory consolidation agent for project "${projectName}". Your job is to clean up accumulated patterns, remove noise, and identify learnings that transcend this project.

<learned_patterns>
${learnedPatterns}
</learned_patterns>

<run_history>
${runHistory}
</run_history>

<instructions>
1. Review all PATTERN-NNN entries.
2. MERGE patterns that convey the same information in different words (keep the clearest version).
3. REMOVE patterns that are:
   - Too generic to be actionable ("follow existing style", "write tests")
   - Contradicted by a newer pattern (keep the newer one)
   - Specific to a one-time situation unlikely to recur
4. PROMOTE patterns to cross_project_candidates if they apply to any TypeScript/Node.js project (not just this one).
5. Output the consolidated set and promoted candidates.
</instructions>

<output_format>
CONSOLIDATION_RESULT:
{
  "consolidated_patterns": [
    "cleaned pattern 1",
    "cleaned pattern 2"
  ],
  "cross_project_candidates": [
    "pattern that applies beyond this project"
  ],
  "removed_count": 0,
  "merged_count": 0
}
</output_format>

Be conservative — only remove or merge when clearly warranted. When in doubt, keep the pattern. Output the JSON block only.`;
}
