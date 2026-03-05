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

This plugin is built on two layers:

**MCP server** (`engine/`) — a deterministic Node.js stdio server exposing 11 `sdd_*` tools. No LLM calls. Pure state management, gate evaluation, memory, signals, and observability.

**Claude Code subagents** (`.claude/agents/`) — 10 native subagents invoked by the orchestrator skill. Each has a defined model, tool access, and mission. The orchestrator (`/sdd-auto:run`) coordinates them via MCP tools and the `Agent` tool.

```
sdd-autopilot/
├── .claude-plugin/
│   ├── plugin.json          # Plugin manifest + mcpServers declaration
│   └── marketplace.json     # Distribution metadata
├── .claude/
│   └── agents/              # Native Claude Code subagents
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
├── skills/
│   ├── auto-run/SKILL.md    # /sdd-auto:run — orchestrator
│   ├── auto-init/SKILL.md   # /sdd-auto:init
│   └── auto-status/SKILL.md # /sdd-auto:status
└── engine/                  # MCP server (TypeScript)
    ├── src/
    │   ├── index.ts         # MCP server entry (stdio transport, 11 tools)
    │   ├── handlers.ts      # Deterministic tool handlers
    │   ├── state.ts         # StateManager + AGENT_PERMISSIONS governance
    │   ├── memory.ts        # Two-layer memory (project + user)
    │   ├── types.ts         # Shared types
    │   └── contracts.json   # Pipeline phase definitions (single source of truth)
    ├── test-e2e.mjs         # Mechanical tests (92 assertions, no API calls)
    ├── package.json
    └── tsconfig.json
```

### MCP tools

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

### State machine

Transition graph enforced in code (`AGENT_PERMISSIONS` in `engine/src/state.ts`), not in `state.json`:

```
draft → specified → planned → decomposed → implementing → verifying → reviewing → pr_created → merged
                                                ↕               ↕            ↕
                                           fix_loop       awaiting_input  fix_review
                                           blocked
                                           escalated  ← orchestrator can reach from any state
```

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
# → 92/92 PASS
```

92 assertions covering all 11 MCP tool handlers, state machine boundaries, memory, signal routing, gate evaluation, delta check, and observability — all without any API calls.

## License

MIT
