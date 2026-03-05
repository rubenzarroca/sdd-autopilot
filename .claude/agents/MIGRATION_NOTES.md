# Migration Notes: v1 Prompts -> v2 Subagent Files

## Design decisions from v1 prompts preserved in v2

### specify.ts -> spec-generator.md
- **11-section spec template**: Preserved fully. The template structure (Metadata, Context, Goals/Non-Goals, User Stories, FR, NFR, Technical Design, Data Models, API Contracts, Edge Cases, Open Questions) is the core value of the specify stage.
- **Self-review pass**: Kept as explicit step. In v1 it was "perform a SELF-REVIEW turn"; in v2 it's in the "Lo que produces" section.
- **"Depth matches complexity" rule**: Preserved in success criteria. A simple webhook needs minimal data models; a scoring engine needs all 11 sections.
- **"Do NOT ask the user anything"**: Preserved in decision heuristics. The agent makes decisions and documents them.

### plan.ts -> plan-architect.md
- **"Do NOT read source code files"**: Preserved as a decision heuristic. The plan agent reads spec, constitution, state, and directory listings only.
- **ADR generation**: Preserved as a required artifact with the same structure.
- **Self-review with 5 checks**: Preserved inline.

### tasks.ts -> task-decomposer.md
- **TASK-NNN format with full metadata**: Preserved exactly (ID, title, requirements, status, complexity, depends_on, files, description, validation).
- **Complexity S/M/L classification**: Preserved.
- **Ordering heuristic** (data structures -> business logic -> UI -> integration -> tests): Preserved.
- **"Do NOT read source code files"**: Not preserved in v2 since the task-decomposer does need to understand file structures. The v1 restriction was overly strict.

### implement.ts -> implementation-engine.md
- **Strict scope boundary**: Preserved verbatim. "Only touch files listed in the task's Files field."
- **Per-task invocation model (v2)**: Adopted. The v1 had both per-task and all-tasks modes; v2 exclusively uses per-task for cleaner context.
- **3 validation attempts**: Preserved.
- **Codebase context and memory injection**: Preserved via MCP tools (sdd_memory_read) instead of prompt parameters.

### verify.ts -> verification-engine.md
- **5-phase methodology**: Preserved exactly (Setup, Test Suite, Spec Coverage, Regression, Constitution).
- **Evidence rules**: Preserved. "VALID evidence: terminal output, exit codes, test results. INVALID evidence: the code looks correct."
- **VERIFICATION_RESULT JSON schema**: Preserved exactly.
- **Read-only constraint**: Preserved. "NEVER modify production source code."
- **False positive/negative cost framing**: Preserved in the objective.

### review.ts -> adversarial-reviewer.md
- **5-category review checklist**: Preserved (Correctness, Security, Performance, Maintainability, Side Effects).
- **"Default posture is REJECT"**: Preserved verbatim.
- **REVIEW_RESULT JSON schema**: Preserved exactly, with severity semantics (critical/major/minor).
- **"Never approve just because verification passed"**: Preserved.
- **Dropped**: "senior staff engineer with 15+ years" framing. Replaced with "AI agent whose objective is..." per migration guidelines.

### pair.ts -> opus-coach.md
- **Stage-specific adversarial lens**: Preserved (specify, implement, verify each have distinct review focus).
- **PAIR_FEEDBACK JSON schema**: Preserved exactly.
- **"Do not manufacture issues to seem thorough"**: Preserved.
- **Severity definitions**: Preserved (critical = blocks, major = quality issue, minor = learning signal).
- **Dropped**: Correction prompt is not part of opus-coach. The orchestrator handles the correction flow by re-invoking the producing agent with the feedback.

### triage.ts -> haiku-analyst.md (triage mode)
- **Complexity scale** (low/medium/high/critical): Preserved.
- **"Be fast and decisive — one round of reading"**: Preserved.
- **TRIAGE_RESULT JSON schema**: Preserved exactly.
- **Run history calibration**: Preserved as input.

### retro-immediate.ts -> haiku-analyst.md (retro mode)
- **Root cause categories**: Preserved (spec_ambiguity, pattern_error, missing_edge_case, naming_convention, missing_dependency).
- **RETRO_RESULT JSON schema**: Preserved exactly.
- **Good vs bad learning examples**: Preserved.
- **Merged with triage**: Both triage and retro are fast Haiku tasks, so they share the haiku-analyst agent file with two operating modes.

### haiku-validator.ts -> haiku-validator.md
- **VALIDATOR_RESULT JSON schema**: Preserved exactly.
- **Fail-safe default**: Preserved. "If ambiguous, treat as PASS."
- **Concrete gaps only**: Preserved.

### fix.ts -> absorbed into implementation-engine and orchestrator
- The fix-engine from v1 is NOT a separate subagent in v2. The orchestrator handles fix loops by re-invoking implementation-engine with the findings as additional context. The failure classification logic (implementation_bug / spec_gap / infra_issue) moves to the orchestrator skill.

### git-operator -> pr-creator
- Renamed to `pr-creator` to better reflect its single responsibility.
- Execution sequence preserved.
- Dropped worktree management (handled by the orchestrator).

## Notable omissions from v1 not carried to v2

1. **codebase-indexer agent**: Not in the 10-agent list. The orchestrator handles codebase indexing directly or the spec-generator reads directory structure.
2. **spec-tester agent**: Not in the 10-agent list. Spec testing is folded into the verification-engine.
3. **worktree-manager agent**: Not in the 10-agent list. Worktree management is an orchestrator concern.
4. **memory-update / memory-consolidate prompts**: Not separate agents. Memory operations are handled via MCP tools (sdd_memory_write, sdd_memory_read).
5. **retro-trends prompt**: Not a separate agent. Trend analysis across runs is deferred to a future version.
