# Changelog

## [Unreleased] - Post-Audit Fix

### Pipeline
- Added fast path detection: trivial features skip spec/plan/tasks, go directly to implementation
- Added persistent run counter: tracks completed runs across all features
- Post-pipeline is now conditional: runs 1-3 summary only, runs 4+ retro, runs 6+ full analysis
- Replaced `--pair-review` with `--opus-review` flag in review phase
- Run recording at pipeline completion (path, duration, files, score)

### Tools
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
