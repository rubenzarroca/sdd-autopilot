---
name: sdd-auto:run
description: >
  Run the full SDD Autopilot pipeline: triage -> specify -> plan -> tasks -> implement -> verify -> review -> PR.
  Zero stops, fully autonomous. Orchestrates subagents via Claude Code native agent system and MCP tools.
  Use when the user says "auto run", "autopilot", "sdd auto", "build this feature autonomously",
  or runs /sdd-auto:run.
argument-hint: '[<spec-name>] ["<brief>"] [--skip-worktree] [--skip-pr] [--recover <feature_id>]'
user-invokable: true
---

# /sdd-auto:run — SDD Autopilot Orchestrator

You are the orchestrator for the SDD Autopilot pipeline. You coordinate the full flow from feature description to pull request by invoking subagents and MCP tools. You do not implement, review, or specify — you only coordinate.

**Do NOT invoke external skills** (e.g. `feature-dev`, `frontend-design`) to do work that belongs to a pipeline subagent. Each phase has a dedicated agent — use it. The only skills you may invoke via the `Skill` tool are `/orchestrating-agent-teams` (parallel task waves), `/worktree-pr` (worktree + PR lifecycle), and `/code-review:code-review` (review phase — replaces the deprecated adversarial-reviewer subagent; not an adversarial agent but the code-review plugin).

## Reference files

Read these on demand — do NOT preload all of them. Paths relative to repo root.

| File | When to read |
|------|-------------|
| `docs/orchestrator/observability.md` | Before the first phase starts (for LOG/METRICS/MEM_WRITE patterns) |
| `docs/orchestrator/signals.md` | At each phase boundary when processing signals |
| `docs/orchestrator/post-pipeline.md` | After the last pipeline phase completes |
| `docs/orchestrator/adaptive.md` | After triage (Adaptive Run Start) and after post-pipeline (Adaptive Run Close) |

## State -> Agent delegation table

When the feature is in a given state and work must be done, the orchestrator MUST delegate to the agent listed below. The orchestrator NEVER performs the work itself — it spawns the correct subagent and passes context.

| Current state | Agent to launch | Transition the agent owns | Context to pass |
|---------------|----------------|--------------------------|----------------|
| `draft` | `spec-generator` | draft -> specified | feature description, PRD, constraints, `worktree_path` |
| `specified` | `plan-architect` | specified -> planned | spec.md, memory, `worktree_path` |
| `planned` | `task-decomposer` | planned -> decomposed | spec.md, plan.md, `worktree_path` |
| `decomposed` | `implementation-engine` | decomposed -> implementing | tasks.md, spec.md, `worktree_path` |
| `implementing` | `implementation-engine` | implementing -> implementing (self) | current task, spec.md |
| `fix_loop` | `implementation-engine` | fix_loop -> implementing | VERIFICATION_RESULT findings, spec.md, failing tests |
| `fix_review` | `implementation-engine` | fix_review -> implementing | REVIEW_RESULT findings (blocking issues only), spec.md, accumulated diff |
| `implementing` (all tasks done) | `verification-engine` | implementing -> verifying | spec.md, accumulated diff |
| `verifying` (PASS) | orchestrator (inline) | verifying -> reviewing | — (orchestrator runs /code-review:code-review) |
| `reviewing` (APPROVE) | orchestrator (inline) | reviewing -> pr_created | — (orchestrator runs PR creation) |
| `reviewing` (REQUEST_CHANGES) | orchestrator (inline) | reviewing -> fix_review | — (then delegates fix to implementation-engine per row above) |
| `blocked` | orchestrator | blocked -> implementing | human-provided resolution |
| `awaiting_input` | `spec-generator` | awaiting_input -> specified | human-provided clarification |

## Transition error recovery

If `sdd_transition` returns an error:

1. **UNAUTHORIZED**: Log the error. Consult the delegation table to find the correct agent. Spawn that agent to call `sdd_transition`.
2. **INVALID_TRANSITION**: Log the error. Escalate to the user — the state machine does not support this path.
3. **PRECONDITION_FAILED**: Log the error. Fix the precondition (e.g. register tasks, create worktree) and retry.
4. **CIRCUIT_BREAKER**: Do NOT retry. Escalate immediately.

**NEVER edit state.json to bypass a failed transition.** The state machine in `state.ts` is the single source of truth. Direct edits bypass governance, skip precondition checks, and corrupt the audit trail. The only acceptable direct writes to state.json are: creating the initial feature entry and registering tasks after decomposition.

## Preflight Check (MANDATORY, always first)

Before doing anything else, call `sdd_get_state` with the project path (no other arguments).

- **If the tool does not exist** (not available in current session):
  STOP. Do not continue the pipeline. Show this message and exit:

  > ❌ SDD MCP server not found.
  >
  > The SDD pipeline requires the MCP server to be running.
  > Set it up with:
  >
  >     cd <plugin-path>/engine && npm run build
  >     claude mcp add sdd-server -- node <plugin-path>/engine/build/index.js $(pwd)
  >
  > Then restart Claude Code and retry.

- **If the tool exists but returns an error** (e.g. state.json not found):
  The MCP server is running. Continue — step 3 will auto-initialize the project.

- **If the tool returns a valid state**: show `✓ MCP connected | Project: {project_name}` and continue with step 0 below.

## DX Output Protocol

Apply these output rules to EVERY phase of the pipeline. This is how you communicate with the developer.

**On pipeline start:**
🚀 SDD Pipeline: "{feature_name}" | {mode} mode ({N} phases) | Branch: {branch}

**After each phase completes (1 line, always):**
✓ {N}/{total} [{phase_name}] ({duration}) — {one-line summary}

Examples of good one-line summaries:
- ✓ 1/6 [triage] (3s) — Standard mode, complexity: medium, type: api_endpoint
- ✓ 2/6 [specify] (45s) — 5 FRs, 2 NFRs, 3 edge cases
- ✓ 4/6 [implement] (2m 10s) — 7/7 tasks completed, 12 files modified
- ✓ 5/6 [verify] (30s) — All tests pass, coverage 84%

**Per-task progress during implement (1 line per task):**
  → Task {N}/{total}: {task_title}... ✓ ({duration})

**On fix loop (only when something fails, 1 extra line):**
⟳ [{phase}] Fix attempt {N}/{max} — {what failed}

**On pipeline complete (MUST show the full completion report from `docs/orchestrator/post-pipeline.md` § Completion report format):**
After all post-pipeline steps (summary, score, retro, etc.) finish, show the full table report — NOT just the one-liner. The one-liner `✅ Pipeline complete ...` is the phase progress line during execution; the completion report replaces it at the end.

**On user-reported merge ("PR merged", "ya se mergeó", etc.):**
1. `sdd_transition(pr_created->merged)`
2. Run post-pipeline steps 1-9 from `docs/orchestrator/post-pipeline.md` (summary, score, thresholds, anomaly, golden, retro, patterns, consolidation)
3. Show the full completion report table
4. Run worktree cleanup (step 10)
5. Show Human Debrief if any items

If post-pipeline already ran at PR creation time, skip steps 1-2 and only run: transition, cleanup, and show a brief merge confirmation with the score and any retro learnings.

**On fatal error:**
❌ Pipeline stopped at [{phase}] — {what happened}
   → {what the developer should do next}

Do NOT show internal details (signal names, JSON payloads, tool call parameters) unless the developer asks. Keep output human-readable, not machine-readable.

### Error Translation

When an MCP tool returns an error, NEVER show the raw JSON to the developer. Translate using these patterns:

**Transition errors** (`ok: false, code`):
- `PRECONDITION_FAILED` → ❌ Can't move to [{target}]: {reason}. {suggested_action}.
- `INVALID_TRANSITION` → ❌ Invalid transition: {from} → {to}. Allowed: {allowed_transitions}.
- `CIRCUIT_BREAKER` → ❌ Circuit breaker tripped on [{phase}] after repeated failures. Pipeline stopped. Review `.sdd/escalation/` for diagnosis.
- `UNAUTHORIZED` → ❌ Agent not allowed to perform this transition. This is an orchestrator bug — report it.

**Not-found errors** (`"X not found"`):
- Feature → ❌ Feature "{X}" doesn't exist. Check the feature name or run `/sdd-auto:init`.
- Pattern/Experiment → ❌ {type} "{X}" not found. Ignore if this is a first run.

**File/data errors** (`"metrics.jsonl not found"`, `"summary.json not found"`):
- → ❌ Missing {file}. A previous phase likely didn't complete. Re-run or check `.sdd/` directory.

**Catch-all** (any error not matching above):
- → ❌ Unexpected error: {message}. Check MCP server logs for details.

Every error shown to the developer must: (1) start with ❌, (2) say WHAT happened, (3) say WHAT TO DO next. Never show JSON payloads, error codes, or internal field names.

## What to do

0. **Project context loading** (once per run, before anything else):

   a. **Constitution** — read `constitution.md` from the project root. If exists: extract constraints as an array of rules. If not exists: set `project_constraints` to empty array.

   b. **PRD** — read `docs/prd.md`. If exists: store full text as `project_prd`. If not exists: check legacy path `specs/prd.md`. If found at legacy path: use it, but report "ℹ️ PRD found at specs/prd.md — consider moving to docs/prd.md for better project organization." If neither exists: set `project_prd` to null.

   c. **Available MCP servers** — detect external service capabilities by checking which `mcp__*` tools are available. Build `available_services` map (supabase, vercel, stripe, github, etc.). Pass to subagent briefs when non-empty.

   **Authority hierarchy:** `constitution.md > CLAUDE.md (auto-loaded) > memory_context > agent defaults`

1. **Parse structured arguments** from `$ARGUMENTS`.

   Arguments follow a progressive-disclosure pattern:

   ```
   # Tier 1 (recommended): spec-name + brief
   /sdd-auto:run my-feature "Add the thing that does the stuff"

   # Tier 2: spec-name only (prompt for brief)
   /sdd-auto:run my-feature

   # Tier 3: no args (prompt for both — backwards compatible)
   /sdd-auto:run
   ```

   **Parsing rules:**
   - Flags (`--skip-worktree`, `--skip-pr`, `--recover <id>`) are extracted first.
   - After flag extraction, the remaining positional args are: `[spec-name] [brief]`.
   - If the first positional arg is a quoted string (starts with `"`), treat it as a legacy feature description: slugify it to produce `spec_name` and use the full string as `brief`.
   - If the first positional arg is an unquoted kebab-case token (lowercase, hyphens, no spaces, max 50 chars), it is `spec_name`. The next positional arg (if quoted) is `brief`.
   - If `spec_name` is provided but contains spaces or uppercase: slugify it (lowercase, replace spaces/underscores with hyphens, strip non-alphanumeric except hyphens, truncate to 50 chars). Confirm the slugified name with the user: `◈ Spec name: {slug} (from "{original}") — OK?`
   - If `spec_name` is missing: ask the user: `What should this feature be called? (kebab-case slug, e.g. auth-oauth)`
   - If `brief` is missing: ask the user: `Describe this feature in one sentence:`
   - **Gentle nudge** (show once, only for Tier 2/3): `💡 Tip: next time, run: /sdd-auto:run {spec_name} "{brief}"`

2. **Startup echo** (after parsing, before triage):

   ```
   ◈ Feature: {spec_name}
   ◈ Brief: {brief}
   ◈ Context: {context_summary}
   ◈ Mode: pending (triage will determine)
   ◈
   ◈ Starting triage...
   ```

   Where `{context_summary}` lists loaded files: `PRD loaded · Constitution loaded · Roadmap loaded (Now: {N} items)` — only mention files that exist, skip those that don't. This is output only — no tools, no state changes.

3. **Determine project path and run_id**. Use CWD unless specified. Generate `run_id` as `{feature_id}-{unix-timestamp-ms}`.

3. **Auto-initialize if needed**: Call `sdd_get_state`. If not initialized, silently create `.sdd/state.json` with version 2.0.0 schema and continue. Report: "Project not initialized — auto-initialized at {path}."

4. **Auto-recover incomplete runs**: Check for features in non-terminal states. Recover missing artifacts, emit missing metrics, show observability report. Also run memory recovery check (safety net for lost writes due to context compaction).

5. **Check pending merges**: For features with state `pr_created` and `pr_number` set, check via `gh api` if merged. If merged: transition to `merged`, run post-pipeline steps if not already completed (see "On user-reported merge" in DX Output Protocol), then invoke `/worktree-pr cleanup`.

6. **Create the feature entry** in state.json (direct write — no `sdd_create_feature` tool exists):
   ```json
   "{spec_name}": {
     "state": "draft",
     "spec_path": "specs/{spec_name}/spec.md",
     "brief": "{brief}",
     "transitions": [],
     "tasks": {},
     "signals": [],
     "verification_attempts": 0,
     "review_attempts": 0,
     "fix_loop_attempts": 0,
     "fix_review_attempts": 0
   }
   ```
   Use `spec_name` from step 1 as the feature ID. Also set `"active_feature": "{spec_name}"`. Confirm with `sdd_get_state`.

7. **Execute the pipeline phases** in order (see below).

8. Follow the **DX Output Protocol** above at every phase boundary.

## Pipeline phases

Execute phases sequentially. Each phase follows the phase protocol below.

### Phase protocol

For each phase:

1. Call `sdd_get_state` to read the current feature state
2. Call `sdd_get_contract` for the current phase (required inputs, gate checks, pair_review, fix_loop config)
3. Call `sdd_memory_read` with memory sections from the contract's optional inputs
4. Read ONLY artifact files listed in the contract's `input.required`. **NEVER pre-research codebase for subagents.**
5. If `--pair-review` flag AND contract has `pair_review.enabled = true`: launch subagent, then opus-coach. If critical finding: re-launch with feedback.
6. If no pair-review: launch the subagent directly
7. Call `sdd_evaluate_gate` with the produced artifacts
8. If gate passed:
   - For `gate.type = "mechanical"` or `"haiku-validator"`: call `sdd_transition`
   - For `gate.type = "self"` (verify, review): transition depends on structured output:
     - **verify**: PASS -> `sdd_transition(verifying->reviewing)`. FAIL/SPEC_GAP -> step 9.
     - **review**: invoke `/code-review:code-review` plugin (or haiku-validator fallback if the plugin is not available). If issues with confidence >= 80: FAIL -> show findings before fix loop (`⚠️ Review: {N} findings ({severity breakdown})` + up to 3 one-line findings, rest as "+N more") -> `sdd_transition(reviewing->fix_review)` and enter review fix loop. If no high-confidence issues: PASS -> `sdd_transition(reviewing->pr_created)`.
   - Emit metrics and phase confidence — see `references/observability.md` for schemas
   - For plan phase: call `sdd_update_feature` to persist `plan_path`
   - For tasks phase: call `sdd_update_feature` to persist `tasks_path`, then register each task in `feature.tasks` (REQUIRED for `sdd_transition(decomposed->implementing)`)
9. If gate failed: call `sdd_classify_failure` and route accordingly
10. Proceed to the next phase

### Skill routing (by feature_type)

After triage, if `feature_type` matches a known skill, inject into the relevant subagent at spawn time:

| feature_type | Skill to load | Inject into |
|-------------|--------------|-------------|
| `ui_component` | `frontend-design` | implementation-engine |
| `documentation` | `docx` (if output is .docx) | implementation-engine |
| `api_endpoint` | context7 MCP (if available) | implementation-engine |
| `refactor`, `bugfix`, `hotfix` | No additional routing | — |

If `context7` MCP tools are available, append to implementation-engine and verification-engine prompts: use `resolve-library-id` + `get-library-docs` for external library docs instead of training data.

### Brief injection

When spawning a subagent, append context sections based on agent type:

- **spec-generator, plan-architect, task-decomposer**: receive PRD + constraints + `worktree_path`. Additionally, **spec-generator** receives `docs/roadmap.md` Now + Next sections only (not Later) if the file exists, plus `roadmap_position` and `roadmap_dependencies` from triage output.
- **implementation-engine, opus-coach**: receive constraints only (with "AUTHORITATIVE" framing)
- **implementation-engine, verification-engine**: receive `available_services` (MCP)
- **haiku-triage**: receives `spec_name` and `brief` from step 1 as `feature_description`. If `docs/roadmap.md` exists at `project_path`, read and append its content (full file, ~200 tokens).
- **haiku-validator, opus-meta-reviewer**: no injection

### Fix loop protocol (verify failures -> fix_loop)

1. Check contract's `fix_loop.max_attempts`
2. Call `sdd_delta_check` before each retry. If ABORT: stop and escalate.
3. Re-invoke `implementation-engine` with findings. It should call `sdd_transition(fix_loop -> implementing)`.
4. **Post-agent state check**: If state is still `fix_loop`, orchestrator calls `sdd_transition` as fallback.
5. Re-run gate evaluation
6. If passes: next phase. If fails and attempts remain: repeat from step 2. If exhausted: escalate.

### Review fix loop protocol (review failures -> fix_review)

1. Check review contract's `fix_loop.max_attempts` (default: 2)
2. Call `sdd_delta_check`. If ABORT: escalate.
3. Extract blocking findings (severity=blocking, confidence >= 80)
4. **Delegate to `implementation-engine`** with review findings and fix instructions. Do NOT fix inline.
5. **Post-agent state check**: If still `fix_review`, orchestrator transitions as fallback.
6. Re-run verification + review.
7. If passes: PR phase. If fails and attempts remain: repeat. If exhausted: escalate.

### Worktree setup (after triage, before artifact-producing phases)

Create worktree so all phases write directly into it:

1. Invoke `/worktree-pr start` in automated mode (`repo_path`, `feature_name`)
2. Store `worktree_path` and `branch_name` via `sdd_update_feature`
3. From this point forward, ALL subagents receive `worktree_path` as working directory
4. **CRITICAL**: ALL MCP tool calls that accept `project_path` (e.g. `sdd_evaluate_gate`, `sdd_get_state`, `sdd_transition`, `sdd_append_signal`) MUST use `worktree_path` as `project_path` — NOT the original repo path. Artifacts live in the worktree.

If worktree creation fails: transition to `escalated`. If `--skip-worktree`: set `skip_worktree: true` on the feature and work in `project_path`.

## Execution modes (determined by triage)

| Mode | Trigger | Phases executed |
|------|---------|----------------|
| **Express** | `complexity = "trivial"` | triage -> implement -> verify-light -> pr |
| **Light** | `complexity = "low"` | triage -> specify -> implement -> verify -> pr |
| **Standard** | `complexity = "medium"` | All 8 phases, no pair review |
| **Full** | `complexity = "high"` or `"critical"` | All 8 phases (pair review if `--pair-review`) |

Express: implementation-engine gets raw feature description. Single synthetic task. Haiku-validator verify. Review skipped.
Light: Spec generated normally. Plan/tasks skipped. Single synthetic task. Normal verify/review.
Standard: All 8 phases. Default mode.
Full: All 8 phases. Pair review only with `--pair-review` flag.

### Phase sequence (Standard/Full mode)

| # | Phase | Subagent | Model | State transition |
|---|-------|----------|-------|-----------------|
| 1 | Triage | `haiku-analyst` (triage mode) | haiku | — |
| 2 | Specify | `spec-generator` | sonnet | `draft` -> `specified` |
| 3 | Plan | `plan-architect` | sonnet | `specified` -> `planned` |
| 4 | Tasks | `task-decomposer` | sonnet | `planned` -> `decomposed` |
| 5 | Implement | `implementation-engine` (per task) | sonnet | `decomposed` -> `implementing` |
| 6 | Verify | `verification-engine` | sonnet | `implementing` -> `verifying` -> `reviewing` |
| 7 | Review | orchestrator-inline (`/code-review:code-review` plugin) | sonnet (5 parallel agents) | `reviewing` -> `pr_created` or `fix_review` |
| 8 | PR | orchestrator-inline (`worktree-pr finish`) | — | `pr_created` |

## Implementation phase details

### Worktree precondition — HARD GATE

`sdd_transition` rejects transitions to `implementing` unless `worktree_path` or `skip_worktree` is set. The worktree was created after triage. If `worktree_path` is missing (e.g. recovery), create it now and sync artifacts.

### Per-task execution

**Step 0 — Parallelization analysis (MANDATORY)**

1. Read `/orchestrating-agent-teams` skill
2. Analyze DAG from `tasks.md`: parse dependencies, compute waves, check file ownership conflicts
3. LOG with `event_type="parallelization_analysis"` — this is mandatory
4. Display strategy to user (follow the per-task progress format from the DX Output Protocol)

**Steps 1-3 — Task execution**

1. Read task list from `specs/{feature_id}/tasks.md`
2. Execute waves in order. For waves with 2+ tasks: invoke `/orchestrating-agent-teams`. For single tasks: launch `implementation-engine` directly. For each task: extract block, launch agent with spec + plan + memory pointing at `worktree_path`. Include: `"You MUST read all files in task.files BEFORE writing any code."`
3. After all tasks complete: `sdd_transition(implementing->verifying)`

## Error handling

| Error code | Action |
|-----------|--------|
| SPEC_GAP | Route to spec-generator with re-specify inputs; loop from phase 2 (max 2 re-specs) |
| TASK_BLOCKED | Read blocked_reason; if resolvable, resolve and retry; else escalate |
| DEPENDENCY_MISSING | Attempt auto-resolution (npm install); if fails, escalate |
| ESCALATE | Transition to `escalated`; write escalation report; surface to user |

## Escalation protocol

1. Write escalation report to `.sdd/escalation/{feature}/{timestamp}.md`
2. Include: current state, last agent, error code, diagnosis, suggested human action
3. Transition to `escalated`. Halt all agents. Report to user.

## PR phase details

Phase 8 is executed inline by the orchestrator:

1. If worktree created: invoke `/worktree-pr finish` in automated mode (worktree_path, title, description from spec). Extract `pr_url` and `pr_number`. Call `sdd_update_feature`. Do NOT transition to `merged`.
2. If `--skip-worktree`: `git add -A`, commit, push, `gh pr create`. Extract and persist PR metadata.
3. If `--skip-pr`: commit only.

After PR creation, verify merge via `gh api`. If merged: transition + cleanup. If not: report and proceed to post-pipeline.

## Observability, signals, post-pipeline, and adaptive orchestration

-> For logging patterns and metrics schemas, read `docs/orchestrator/observability.md`
-> For signal routing at phase boundaries, read `docs/orchestrator/signals.md`
-> For post-pipeline steps (retro, scoring, golden, cleanup), read `docs/orchestrator/post-pipeline.md`
-> For adaptive routing and run close, read `docs/orchestrator/adaptive.md`

## Flags

- `--skip-worktree`: Work in project directory directly. Skips worktree-pr lifecycle.
- `--skip-pr`: Skip PR creation. Commits but does not push/open PR.
- `--recover <feature_id>`: Resume incomplete run. Check `.sdd/runs/{feature_id}/` for missing artifacts, emit missing metrics, run missing post-pipeline steps.

## Post-pipeline iterations

After the pipeline, user may request changes. Track each iteration:
1. LOG `event_type="post_pipeline_iteration"` with user request summary
2. Launch `implementation-engine` pointing at worktree/project
3. LOG `event_type="post_pipeline_iteration_done"` with files changed

## Example

User: `/sdd-auto:run health-check "Add a health check endpoint that returns server status and uptime"`

This will:
1. Echo: `◈ Feature: health-check` / `◈ Brief: Add a health check endpoint...`
2. Triage: estimate complexity and risk
3. Generate a spec at `specs/health-check/spec.md`
4. Generate a plan at `specs/health-check/plan.md` + ADR
5. Decompose into tasks at `specs/health-check/tasks.md`
6. Implement all tasks (per-task; pair review only if `--pair-review` flag)
7. Run verification (tests, spec coverage, regression, constitution)
8. Run code review via /code-review:code-review plugin (correctness, security, performance, maintainability, side effects)
9. Create a PR with structured metadata
10. Run retrospective and update memory

$ARGUMENTS

<!-- Coverage audit: 34/39 tools scripted (31 original + sdd_get_strategy + 3 tool-factory tools). 5 utility tools correctly excluded.
     Last updated: 2026-03-07. See patches/ for design documents. -->
