# SDD Autopilot

Zero-stop, fully autonomous **specify → plan → tasks → implement → verify → review → PR** pipeline for Claude Code.

Give it a feature description. Get back a reviewed PR.

## How it works

```
Feature description
       │
       ▼
┌─────────────┐
│   TRIAGE    │ Haiku — complexity + risk pre-check
├─────────────┤
│   SPECIFY   │ Sonnet — spec.md with requirements and edge cases
│             │ ✦ opus-coach pair review
├─────────────┤
│    PLAN     │ Sonnet — technical plan + ADR
├─────────────┤
│    TASKS    │ Sonnet — atomic task list with DAG dependencies
├─────────────┤
│  IMPLEMENT  │ Sonnet — executes tasks in parallel waves
│             │ ✦ opus-coach pair review per task
├─────────────┤
│   VERIFY    │ Sonnet — tests, spec coverage, regression check
│             │ ↻ fix loop (up to 3 attempts, with delta check)
│             │ ✦ opus-coach pair review
├─────────────┤
│   REVIEW    │ Opus — adversarial review, defaults to REJECT
│             │ ↻ fix loop (up to 2 attempts)
├─────────────┤
│     PR      │ Sonnet — branch push + gh pr create
└─────────────┘
       │
       ▼
  Reviewed PR
```

Sonnet handles the bulk work. Opus acts as the adversarial quality gate. Haiku runs triage and post-pipeline retrospectives. Each phase is a dedicated native Claude Code subagent — no direct API calls.

## Architecture

```
USER (Claude Code CLI)
       │
       │  /sdd-auto:init · /sdd-auto:run "feature" · /sdd-auto:status
       ▼
┌─────────────────────────────────────────────────────────────────┐
│                   SKILL LAYER  (skills/)                        │
│         auto-init · auto-run (orchestrator) · auto-status       │
└──────────────────────────┬──────────────────────────────────────┘
                           │  Agent tool (spawns subagents)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│          ORCHESTRATOR  (skills/auto-run/SKILL.md)               │
│                                                                 │
│  For each phase:                                                │
│  1. sdd_get_state → sdd_get_contract → sdd_memory_read          │
│  2. Spawn subagent                                              │
│  3. sdd_evaluate_gate                                           │
│  4a. gate=mechanical|haiku-validator → sdd_transition (generic) │
│  4b. gate=self (verify/review) → read structured output:        │
│       VERIFICATION_RESULT.status = PASS → verifying→reviewing   │
│       REVIEW_RESULT.decision = APPROVE  → reviewing→pr_created  │
│       REVIEW_RESULT.decision = REQUEST_CHANGES → fix_review loop│
│  5. sdd_log_event                                               │
│  Post-pipeline: haiku-analyst retro → sdd_memory_write          │
│                 → sdd_tick_decay (TTL prune)                     │
└──────┬────────┬────────┬────────┬────────┬────────┬────────────┘
       │        │        │        │        │        │
    [1]│     [2]│     [3]│     [4]│     [5]│     [6]│  [7]
┌──────▼────────▼────────▼────────▼────────▼────────▼────────────┐
│              SUBAGENT LAYER  (.claude/agents/*.md)              │
│                                                                 │
│  [0] haiku-analyst ──────────────────────────────────────────┐  │
│      (triage + retro)                                        │  │
│                                                              │  │
│  [1] spec-generator ──► [2] plan-architect ──► [3] task-     │  │
│      sonnet                  sonnet               decomposer │  │
│        │                       │                  sonnet     │  │
│        ▼                       ▼                             │  │
│  haiku-validator         haiku-validator                     │  │
│  (gate check)            (gate check)                        │  │
│                                                              │  │
│  [4] implementation-engine (per task, wave-parallel)         │  │
│      sonnet · Read/Write/Edit/Bash                           │  │
│        │ self-transition: implementing→implementing           │  │
│        ▼                                                     │  │
│  [5] verification-engine ──────────────────────────────────┐ │  │
│      sonnet · read-only                                     │ │  │
│      produces: VERIFICATION_RESULT {status,findings,…}      │ │  │
│        │ FAIL ──────────────────────────────────────────────┘ │  │
│        │ SPEC_GAP ──────────────────────────────────────────►[1] │
│        │ PASS                                                 │  │
│        ▼                                                     │  │
│  [6] adversarial-reviewer                                    │  │
│      opus · read-only                                        │  │
│      produces: REVIEW_RESULT {decision,findings}             │  │
│        │ REQUEST_CHANGES ─────────────────────────────────►[4]  │
│        │ APPROVE                                              │  │
│        ▼                                                        │
│  [7] pr-creator                                              │  │
│      sonnet · Bash (git + gh cli)                            │  │
│                                                              │  │
│  [pair] opus-coach ─── reviews artifacts on specify/         │  │
│         opus           implement/verify stages               │  │
│                                                              │  │
│  haiku-analyst (retro mode) ◄────────────────────────────────┘  │
└──────────────────────────┬──────────────────────────────────────┘
                           │  mcp__sdd-autopilot__sdd_* tools
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│             MCP SERVER  (engine/src/)  stdio transport          │
│                                                                 │
│  index.ts ── handlers.ts ── state.ts ── memory.ts               │
│              tasks.ts ──── observability.ts                     │
│                                                                 │
│  ── 13 tools ──────────────────────────────── consumer ──────── │
│  sdd_get_state          ◄── all agents                          │
│  sdd_transition         ◄── orchestrator · impl-engine          │
│  sdd_get_contract       ◄── orchestrator                        │
│  sdd_evaluate_gate      ◄── orchestrator                        │
│  sdd_classify_failure   ◄── orchestrator (fix loops)            │
│  sdd_delta_check        ◄── orchestrator (fix loops)            │
│  sdd_log_event          ◄── orchestrator · haiku-analyst        │
│  sdd_memory_read        ◄── spec/plan/impl/verif/analyst        │
│  sdd_memory_write       ◄── haiku-analyst (retro)               │
│  sdd_tick_decay         ◄── orchestrator (post-pipeline)        │
│  sdd_append_signal      ◄── plan/impl/verif/adv-reviewer        │
│  sdd_update_task        ◄── impl-engine                         │
│  sdd_update_feature     ◄── orchestrator                        │
└──────────────────────────┬──────────────────────────────────────┘
                           │  R/W
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                  PERSISTENCE LAYER  (.sdd/)                     │
│                                                                 │
│   state.json   ◄── feature states + task list + signals         │
│   memory.md    ◄── 2-layer (project scope / user scope)         │
│   runs/        ◄── audit trail (sdd_log_event output)           │
│   specs/       ◄── spec.md · plan.md · tasks.md per feature     │
│   escalation/  ◄── escalation reports                           │
└─────────────────────────────────────────────────────────────────┘


┌─────────────────────────────────────────────────────────────────┐
│          PIPELINE PHASES  (contracts.json)                      │
│                                                                 │
│  [0] triage     haiku      — complexity estimate, risk flag     │
│  [1] specify    sonnet     draft → specified                    │
│  [2] plan       sonnet     specified → planned                  │
│  [3] tasks      sonnet     planned → decomposed                 │
│  [4] implement  sonnet×N   decomposed → implementing (per task) │
│  [5] verify     sonnet     implementing → verifying             │
│  [6] review     opus       verifying → reviewing                │
│  [7] pr         sonnet     reviewing → pr_created               │
│                                                                 │
│  gate=mechanical: orchestrator evalúa + transiciona             │
│  gate=haiku-validator: haiku-validator evalúa semánticamente     │
│  gate=self: structured output del agente determina transición    │
└─────────────────────────────────────────────────────────────────┘
```

Two hard layers. The MCP server is deterministic Node.js — no LLM, pure state. The subagents are Claude — no state, pure reasoning. The orchestrator skill wires them together.

## State machine

Transition graph enforced in code (`AGENT_PERMISSIONS` in `engine/src/state.ts`), not in `state.json`:

```
                        ┌──────────────────────────────────────────┐
                        │  escalated  ← orchestrator, any state    │
                        └──────────────────────────────────────────┘

 draft ──▶ specified ──▶ planned ──▶ decomposed ──▶ implementing ──▶ verifying ──▶ reviewing ──▶ pr_created ──▶ merged
                                          │               │               │
                                          ▼               ▼               ▼
                                       blocked          fix_loop       fix_review
                                    awaiting_input
```

## File structure

```
sdd-autopilot/
├── .claude-plugin/
│   ├── plugin.json          # Plugin manifest + mcpServers declaration
│   └── marketplace.json     # Distribution metadata
│
├── .claude/
│   └── agents/              # Native Claude Code subagents (operative)
│       ├── spec-generator.md
│       ├── plan-architect.md
│       ├── task-decomposer.md
│       ├── implementation-engine.md
│       ├── verification-engine.md
│       ├── adversarial-reviewer.md
│       ├── opus-coach.md
│       ├── haiku-analyst.md
│       ├── haiku-validator.md
│       └── pr-creator.md
│
├── skills/
│   ├── auto-run/SKILL.md    # /sdd-auto:run — pipeline orchestrator
│   ├── auto-init/SKILL.md   # /sdd-auto:init
│   └── auto-status/SKILL.md # /sdd-auto:status
│
└── engine/                  # MCP server (TypeScript, stdio transport)
    ├── src/
    │   ├── index.ts         # Entry point — 13 sdd_* tools registered
    │   ├── handlers.ts      # Deterministic tool handlers
    │   ├── state.ts         # StateManager + AGENT_PERMISSIONS governance
    │   ├── memory.ts        # Two-layer memory (project + user scope)
    │   ├── tasks.ts         # parseTasks() + computeWaves()
    │   ├── observability.ts # RunLogger
    │   ├── types.ts         # Shared types
    │   └── contracts.json   # Pipeline phase definitions (single source of truth)
    ├── test-e2e.mjs         # Mechanical tests (105 assertions, no API calls)
    ├── package.json
    └── tsconfig.json
```

## MCP tools

| Tool | Purpose |
|------|---------|
| `sdd_get_state` | Read current feature state and signals |
| `sdd_transition` | Move a feature between states (enforces AGENT_PERMISSIONS) |
| `sdd_get_contract` | Read phase definition from contracts.json |
| `sdd_evaluate_gate` | Mechanical gate checks (file exists, section non-empty, etc.) |
| `sdd_classify_failure` | Classify error as implementation_bug / spec_gap / infra_issue |
| `sdd_delta_check` | Detect regression in fix loop (abort if failures increase) |
| `sdd_log_event` | Append structured event to `.sdd/runs/{feature}/run.log` |
| `sdd_memory_read` | Read project or user memory by section |
| `sdd_memory_write` | Write to project or user memory |
| `sdd_tick_decay` | Decrement TTLs on learned patterns and exploration entries |
| `sdd_append_signal` | Emit a signal (dual-write: state.json + signals.jsonl) |
| `sdd_update_task` | Mark a task as pending / in-progress / completed |
| `sdd_update_feature` | Persist feature metadata: branch, worktree_path, plan_path, tasks_path, etc. |

## Installation

### From Claude Code marketplace

Search for `sdd-autopilot` in the Claude Code plugin marketplace and install. The MCP server starts automatically — no configuration needed.

### From source

```bash
git clone https://github.com/rubenzarroca/sdd-autopilot.git \
  ~/.claude/plugins/local/sdd-autopilot

cd ~/.claude/plugins/local/sdd-autopilot/engine
npm install
npm run build
```

No `ANTHROPIC_API_KEY` needed. Claude Code handles all model invocations through its native agent system.

## Usage

### `/sdd-auto:run` — Run the full pipeline

```
/sdd-auto:run "Add a health check endpoint that returns server status and uptime"
```

Autonomously generates spec → plan → tasks → implements all tasks → verifies → reviews → opens PR.

**Flags:**
- `--skip-worktree` — Work in place, no git worktree
- `--skip-pr` — Skip PR creation (useful for testing)

### `/sdd-auto:init` — Initialize a project

```
/sdd-auto:init
```

Creates `.sdd/state.json`. Optional — `/sdd-auto:run` auto-initializes if needed.

### `/sdd-auto:status` — Check pipeline progress

```
/sdd-auto:status
```

Shows feature states, task progress, verification/review attempt counts, active signals.

## Requirements

- Claude Code with plugin support
- Node.js 18+ (for the MCP server)
- `git` and `gh` (GitHub CLI) for branch push + PR creation

## Testing

```bash
cd engine
npm run build
node test-e2e.mjs
# → 105/105 PASS
```

105 assertions covering all 13 MCP tool handlers, the complete happy-path pipeline (draft → pr_created), state machine boundaries, memory, signal routing, gate evaluation, delta check, and observability — all without any API calls.

## License

MIT
