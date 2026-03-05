// Memory Update prompt (10.2 — Learned Patterns extraction)
// Model: Haiku (fast, cheap). Runs after each successful pipeline run.
// Input: final git diff + spec. Output: LEARNED_PATTERNS JSON.
// Patterns are appended to project memory (Learned Patterns section).

export function buildMemoryUpdatePrompt(
  featureName: string,
  diff: string,
  specContent: string,
): string {
  return `You are a memory agent. Extract reusable implementation patterns from a completed feature. Your output will be stored in project memory and used to guide future implementations.

<feature>${featureName}</feature>

<spec>
${specContent.slice(0, 2000)}
</spec>

<diff>
${diff.slice(0, 4000)}
</diff>

<instructions>
Extract UP TO 5 patterns that are genuinely reusable for future features in this codebase. Focus on:
- HOW things are done (registration patterns, error handling, async patterns)
- WHERE things belong (which file/module handles what)
- WHEN to use certain approaches (conditions, tradeoffs specific to this project)

GOOD patterns are specific and actionable:
  "Auth middleware is registered in src/middleware/index.ts and applied per-router via app.use()"
  "Integration tests use createTestApp() factory from test/helpers.ts — never instantiate directly"
  "Errors always wrap in AppError with a code string before bubbling to the global handler"

BAD patterns are generic or just describe what was done:
  "Added auth middleware to protect routes"
  "Tests were written"
  "Follow existing code style"

If the diff is too small or the feature is isolated (e.g., a config change), return an empty array.
</instructions>

<output_format>
LEARNED_PATTERNS:
{
  "patterns": [
    "specific actionable pattern 1",
    "specific actionable pattern 2"
  ]
}
</output_format>

Do NOT explain your reasoning. Just the JSON block.`;
}
