[Back to README](../README.md)

# Architecture

## Overview

Two hard layers. The MCP server is deterministic Node.js — no LLM, pure state. The subagents are Claude — no state, pure reasoning. The orchestrator skill wires them together.

## Full Architecture Diagram

```
USER (Claude Code CLI)
       |
       |  /sdd-auto:init . /sdd-auto:run "feature" . /sdd-auto:status
       v
+---------------------------------------------------------------+
|                   SKILL LAYER  (skills/)                       |
|         auto-init . auto-run (orchestrator) . auto-status      |
+----------------------------+----------------------------------+
                             |  Agent tool (spawns subagents)
                             v
+---------------------------------------------------------------+
|          ORCHESTRATOR  (skills/auto-run/SKILL.md)              |
|                                                                |
|  Adaptive: 80% exploitation (apply active patterns) /          |
|            20% exploration (run experiment every 5th run)       |
|                                                                |
|  For each phase:                                               |
|  1. sdd_get_state -> sdd_get_contract -> sdd_memory_read       |
|  2. Spawn subagent . sdd_emit_metrics (per phase)              |
|  3. sdd_evaluate_gate                                          |
|  4a. gate=mechanical|haiku-validator -> sdd_transition          |
|  4b. gate=self (verify/review) -> read structured output:      |
|       VERIFICATION_RESULT.status = PASS -> verifying->reviewing |
|       REVIEW_RESULT.decision = APPROVE  -> reviewing->pr_created|
|       REVIEW_RESULT.decision = REQUEST_CHANGES -> fix_review    |
|  5. sdd_log_event                                              |
|  Post-pipeline: sdd_get_run_summary -> sdd_compute_score       |
|                 haiku-analyst retro -> sdd_memory_write         |
|                 sdd_tick_maintenance (patterns + memory TTL)    |
|  Every N runs: opus-meta-reviewer -> sdd_propose_evolution     |
+------+--------+--------+--------+--------+--------+-----------+
       |        |        |        |        |        |
    [1]|     [2]|     [3]|     [4]|     [5]|     [6]|  [7]
+------v--------v--------v--------v--------v--------v-----------+
|              SUBAGENT LAYER  (.claude/agents/*.md)              |
|                                                                |
|  [0] haiku-triage                                              |
|      haiku (classify feature_type + complexity)                |
|                                                                |
|  [1] spec-generator --> [2] plan-architect --> [3] task-        |
|      sonnet                  sonnet               decomposer   |
|        |                       |                  sonnet        |
|        v                       v                               |
|  haiku-validator         haiku-validator                        |
|  (gate check)            (gate check)                          |
|                                                                |
|  [4] implementation-engine (per task, wave-parallel)           |
|      sonnet . Read/Write/Edit/Bash                             |
|        | self-transition: implementing->implementing           |
|        v                                                       |
|  [5] verification-engine                                       |
|      sonnet . read-only                                        |
|      produces: VERIFICATION_RESULT {status,findings,...}       |
|        | FAIL -> retry                                         |
|        | SPEC_GAP -> [1]                                       |
|        | PASS                                                  |
|        v                                                       |
|  [6] review  (orchestrator via /code-review plugin)            |
|      produces: REVIEW_RESULT {decision,findings}               |
|        | REQUEST_CHANGES -> [4]                                |
|        | APPROVE                                               |
|        v                                                       |
|  [7] pr  (orchestrator inline via /worktree-pr)                |
|                                                                |
|  [pair] opus-coach --- reviews artifacts on specify/           |
|         opus           implement/verify stages (opt-in)        |
|                                                                |
|  [meta] opus-meta-reviewer -- periodic pipeline evolution      |
|         opus               -- proposes weight/structure        |
|         spawned every N runs by the orchestrator               |
+----------------------------+----------------------------------+
                             |  mcp__sdd-autopilot__sdd_* tools
                             v
+---------------------------------------------------------------+
|             MCP SERVER  (engine/src/)  stdio transport          |
|                                                                |
|  index.ts ── TOOL_REGISTRY (single source of truth)            |
|  handlers.ts -- state.ts -- memory.ts -- verbosity.ts          |
|  observability.ts -- metacognition.ts -- tool-factory.ts       |
|  types.ts -- utils.ts                                          |
|                                                                |
|  38 tools (see docs/tools.md for full reference)               |
|  Categories: core(15) observability(6) metacognition(13) infra(4)|
|  10 read tools support verbosity param (minimal/standard/full) |
|  Metacognition gated behind run_counter >= 5                   |
|  Write-through cache with mtime check + atomic writes          |
+----------------------------+----------------------------------+
                             |  R/W
                             v
+---------------------------------------------------------------+
|                  PERSISTENCE LAYER  (.sdd/)                     |
|                                                                |
|   state.json   <-- feature states + task list + signals        |
|   memory.md    <-- 2-layer (project scope / user scope)        |
|   runs/        <-- metrics.jsonl . summary.json per feature    |
|   specs/       <-- spec.md . plan.md . tasks.md per feature    |
|   escalation/  <-- escalation reports                          |
|   analytics/   <-- history.jsonl (cross-run RunSummaries)      |
|   metacognition/ < patterns.json . experiments.json .          |
|                    evolutions.json . score_weights.json         |
+---------------------------------------------------------------+
```

## Pipeline Phases

Defined in `contracts.json` (single source of truth):

```
+---------------------------------------------------------------+
|          PIPELINE PHASES  (contracts.json)                      |
|                                                                |
|  [0] triage     haiku      -- complexity estimate, risk flag   |
|  [1] specify    sonnet     draft -> specified                  |
|  [2] plan       sonnet     specified -> planned                |
|  [3] tasks      sonnet     planned -> decomposed               |
|  [4] implement  sonnet*N   decomposed -> implementing (per task)|
|  [5] verify     sonnet     implementing -> verifying           |
|  [6] review     orchestrator  verifying -> reviewing            |
|  [7] pr         sonnet     reviewing -> pr_created             |
|                                                                |
|  gate=mechanical:     orchestrator evaluates + transitions     |
|  gate=haiku-validator: haiku-validator evaluates semantically  |
|  gate=self:           structured agent output drives transition |
+---------------------------------------------------------------+
```

## State Machine

Transition graph enforced in code (`AGENT_PERMISSIONS` in `engine/src/state.ts`), not in `state.json`:

```
                        +------------------------------------------+
                        |  escalated  <-- orchestrator, any state   |
                        +------------------------------------------+
                        +------------------------------------------+
                        |  paused  <-- orchestrator, any non-terminal|
                        |  paused --> draft (reset)                  |
                        +------------------------------------------+

 draft --> specified --> planned --> decomposed --> implementing --> verifying --> reviewing --> pr_created --> merged
                                        |               |               |
                                        v               v               v
                                     blocked          fix_loop       fix_review
                                  awaiting_input

 Terminal states: merged, escalated
 Recoverable: paused (reset to draft)
```

## File Structure

```
sdd-autopilot/
+-- .claude-plugin/
|   +-- plugin.json          # Plugin manifest + mcpServers declaration
|   +-- marketplace.json     # Distribution metadata
|
+-- .claude/
|   +-- agents/              # Native Claude Code subagents (operative)
|       +-- haiku-triage.md
|       +-- haiku-validator.md
|       +-- spec-generator.md
|       +-- plan-architect.md
|       +-- task-decomposer.md
|       +-- implementation-engine.md
|       +-- verification-engine.md
|       +-- opus-coach.md            # Opt-in pair review
|       +-- opus-meta-reviewer.md    # Periodic pipeline evolution
|
+-- skills/
|   +-- auto-run/SKILL.md    # /sdd-auto:run -- pipeline orchestrator
|   +-- auto-init/SKILL.md   # /sdd-auto:init
|   +-- auto-status/SKILL.md # /sdd-auto:status
|
+-- docs/
|   +-- architecture.md            # This file
|   +-- memory.md                  # Memory intelligence docs
|   +-- observability.md           # Observability & metacognition docs
|   +-- tools.md                   # MCP tools reference
|   +-- orchestrator/              # Runtime docs read by auto-run SKILL.md
|   +-- examples/
|       +-- health-check-endpoint/ # Real pipeline run
|
+-- engine/                  # MCP server (TypeScript, stdio transport)
|   +-- src/
|   |   +-- index.ts                # Entry point -- TOOL_REGISTRY (38 sdd_* tools)
|   |   +-- handlers.ts            # Core deterministic tool handlers (15)
|   |   +-- state.ts               # StateManager + AGENT_PERMISSIONS governance
|   |   +-- memory.ts              # Two-layer memory (project + user scope)
|   |   +-- observability.ts       # PhaseMetrics . RunSummary . cross-run analytics (6+1)
|   |   +-- metacognition.ts       # Scoring . patterns . experiments . evolution (13)
|   |   +-- tool-factory.ts        # Self-evolution: propose/review/generate tools (3)
|   |   +-- verbosity.ts           # Shared resolveVerbosity helper
|   |   +-- types.ts               # Shared types (SignalPayload union, PhaseMetrics, ...)
|   |   +-- utils.ts               # Shared utilities (fileExists, parseJsonl)
|   |   +-- contracts.json         # Pipeline phase definitions (single source of truth)
|   |   +-- tool-stratification.json  # Runtime category map (core/observability/metacognition/infra)
|   |   +-- tools-manifest.json    # SHA-256 tool manifest for drift detection
|   +-- tests/
|   |   +-- e2e/             # Behavioral pipeline tests
|   |   +-- fixtures/        # Test fixtures (sample-project)
|   +-- test-e2e.mjs         # Mechanical tests (~1500 lines, no API calls)
|   +-- scripts/
|   |   +-- compute-tools-hash.mjs  # SHA-256 hash of tool definitions
|   +-- tools-manifest.json  # Tool manifest for drift detection
|   +-- package.json
|   +-- tsconfig.json
```
