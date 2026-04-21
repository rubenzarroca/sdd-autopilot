# Changelog

## [Unreleased] - Opus Routing for plan-architect (complexity high/critical)

### Agents
- **New**: `.claude/agents/plan-architect-opus.md` — variant of `plan-architect` with `model: opus` + `effort: xhigh`. Literal copy of the original prompt; only frontmatter differs.

### Pipeline
- **Model routing by complexity** in `/sdd-auto:run` plan phase:
  - `trivial | low | medium` → `plan-architect` (sonnet + high, default)
  - `high | critical` → `plan-architect-opus` (opus + xhigh)
- Cost-optimized: Opus 4.7 + xhigh (~5x per plan) reserved for features with enough architectural leverage to amortize the premium.
- Orchestrator continues to pass `agent_id: "plan-architect"` to `sdd_transition` for both variants (shared semantic role; `AGENT_PERMISSIONS` in state.ts unchanged).

### Docs
- `skills/auto-run/SKILL.md`: added "Model routing (by complexity)" section; updated State→Agent delegation table, Token ratio table, Phase sequence table, and Brief injection to reference the variant.

## [Unreleased] - Headless Mode + MCP Connection Fix

### Critical Fix
- **plugin.json**: use `${CLAUDE_PLUGIN_ROOT}` for MCP server path — fixes server not connecting when cwd != plugin dir
- **engine/package.json**: add `postinstall` script — auto-builds after `npm install`, no manual build step needed

### Pipeline
- Added `--headless` flag for external orchestrators (CI, autonomous agents)
- Headless mode: no PR, no push, no human prompts, exit code 0/1 contract
- TLDR summary on last line of stdout for machine parsing
- New state transition: `reviewing -> merged` (direct, skips `pr_created` in headless)
- Preflight check now hard-stops with `exit 1` if MCP server not connected (prevents silent failures)
- Headless errors (`escalated`, `awaiting_input`) explicitly exit with code 1

### MCP Server
- Reads `SDD_MODE` environment variable at startup (`interactive` | `headless`)
- `sdd_get_state` now includes `sdd_mode` in response for orchestrator awareness
- Added `SddMode` type to shared types

## [Unreleased] - Post-Audit Fix

### Pipeline
- Added fast path detection: trivial features skip spec/plan/tasks, go directly to implementation
- Added persistent run counter: tracks completed runs across all features
- Post-pipeline is now conditional: runs 1-3 summary only, runs 4+ retro, runs 6+ full analysis
- Replaced `--pair-review` with `--opus-review` flag in review phase
- Run recording at pipeline completion (path, duration, files, score)

### Tools
- `sdd_update_task` is now upsert: creates task if it doesn't exist (fixes task registration gap — no separate register tool needed)
- Unified TOOLS array and HANDLER_MAP into single TOOL_REGISTRY
- Added tool stratification: core (14), observability (6), metacognition (13), infra (4)
- Metacognition tools gated behind run_counter >= 5 (self-enforced + orchestrator filter)
- Created tool-stratification.json as runtime + documentation artifact
- Extracted shared resolveVerbosity to engine/src/verbosity.ts

### State Machine
- StateManager mtime check: detects external modifications, reloads from disk
- Atomic writes: temp-file + rename pattern prevents race conditions
- Added `paused` state: recoverable from any non-terminal state
- Added `resetFeature`: clears state to draft with audit trail
- Signal array bounds: hard cap at 200, auto-prune oldest 50
- Memory pruning: TTL enforcement (7 days), max entries (100)
- Defensive JSON parsing: explicit errors instead of silent fallback
- Run counter + run history in project state (bounded to 20 entries)

### DX
- [To be filled by Agent D — gate error messages, signal types]

### Docs
- Modularized SKILL.md: reduced from ~487 to <=400 lines, extracted reference material
- Created docs/orchestrator/dx-output.md (completion report template)
- Created docs/orchestrator/task-batching.md (batch eligibility and execution)
- Created docs/orchestrator/routing-table.json (state -> agent -> context mapping)
- Rewrote README for 30-second comprehension
- Created docs/NON-GOALS.md
- Created CHANGELOG
