# SDD Autopilot

Zero-stop, fully autonomous **specify → plan → tasks → implement → verify → review → PR** pipeline for Claude Code.

Give it a feature description. Get back a reviewed PR.

## How it works

```
Feature description
       │
       ▼
┌─────────────┐
│   SPECIFY   │ Sonnet 4.6 — generates spec.md from description
├─────────────┤
│    PLAN     │ Sonnet 4.6 — technical plan + ADR
├─────────────┤
│    TASKS    │ Sonnet 4.6 — atomic task decomposition
├─────────────┤
│  IMPLEMENT  │ Sonnet 4.6 — executes all tasks in order
├─────────────┤
│   VERIFY    │ Sonnet 4.6 — tests, spec coverage, regression
│             │ ↻ fix loop (up to 3 attempts)
├─────────────┤
│   REVIEW    │ Opus 4.6 — adversarial code review
│             │ ↻ fix loop (up to 2 attempts)
├─────────────┤
│     PR      │ git worktree → commit → push → gh pr create
└─────────────┘
       │
       ▼
  Reviewed PR
```

Sonnet handles the bulk work (planning, implementation, verification). Opus acts as the final quality gate — adversarial reviewer that defaults to REJECT.

## Installation

### From source (local plugin)

```bash
# Clone into Claude Code plugins directory
git clone https://github.com/rubenzarroca/sdd-autopilot.git \
  ~/.claude/plugins/local/sdd-autopilot

# Build the engine
cd ~/.claude/plugins/local/sdd-autopilot/engine
npm install
npm run build
```

### Environment

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

The engine calls the Anthropic API directly via PTC (Programmatic Tool Calling). The SDK reads `ANTHROPIC_API_KEY` from the environment automatically.

## Usage

### `/sdd-auto:run` — Run the full pipeline

```
/sdd-auto:run "Add a health check endpoint that returns server status and uptime"
```

This will autonomously:
1. Generate a spec at `specs/health-check-endpoint/spec.md`
2. Create a technical plan and ADR
3. Decompose into atomic tasks
4. Create a git worktree + branch `feat/health-check-endpoint`
5. Implement all tasks
6. Verify (tests pass, spec coverage >= 80%, no regressions)
7. Adversarial review (correctness, security, performance, maintainability, side effects)
8. Create a PR with the spec as body

**Flags:**
- `--skip-worktree` — Work in place (no git worktree)
- `--skip-pr` — Skip PR creation

### `/sdd-auto:init` — Initialize a project

```
/sdd-auto:init
```

Creates `.sdd/state.json` with the autopilot state machine. Optional — `/sdd-auto:run` auto-initializes if needed.

### `/sdd-auto:status` — Check progress

```
/sdd-auto:status
```

Shows feature states, task progress, verification/review attempt counts.

## Architecture

```
sdd-autopilot/
├── .claude-plugin/
│   ├── plugin.json          # Plugin manifest
│   └── marketplace.json     # Distribution metadata
├── skills/
│   ├── auto-run/SKILL.md    # /sdd-auto:run skill
│   ├── auto-init/SKILL.md   # /sdd-auto:init skill
│   └── auto-status/SKILL.md # /sdd-auto:status skill
└── engine/                  # PTC pipeline engine (TypeScript)
    ├── src/
    │   ├── index.ts         # CLI entry + pipeline orchestrator
    │   ├── phase.ts         # PTC agentic loop runner
    │   ├── types.ts         # Shared types, models, pricing
    │   ├── state.ts         # .sdd/state.json state machine
    │   ├── git.ts           # Worktree + PR operations
    │   ├── tools.ts         # PTC tool definitions (9 tools)
    │   ├── handlers.ts      # Tool execution handlers
    │   └── prompts/         # Phase-specific system prompts
    │       ├── specify.ts
    │       ├── plan.ts
    │       ├── tasks.ts
    │       ├── implement.ts
    │       ├── verify.ts
    │       ├── review.ts
    │       └── fix.ts
    ├── test-e2e.mjs         # Mechanical tests (no API calls)
    ├── package.json
    └── tsconfig.json
```

The engine is a **single Node.js process** that runs sequential PTC agentic loops — one per phase. No multi-agent coordination. Each phase gets its own system prompt, model, and tool set.

## Cost estimation

Per feature (typical):

| Model | Role | Est. cost |
|-------|------|-----------|
| Sonnet 4.6 | Specify + Plan + Tasks + Implement + Verify + Fix | ~$1.41 |
| Opus 4.6 | Review + Fix review | ~$2.63 |
| **Total** | | **~$4.04** |

Pricing: Sonnet ($3/$15 per 1M in/out) · Opus ($15/$75 per 1M in/out)

## Requirements

- Node.js 18+
- `git` and `gh` (GitHub CLI) for worktree + PR creation
- `ANTHROPIC_API_KEY` environment variable

## Testing

```bash
cd engine
npm run build
node test-e2e.mjs
```

Runs 36 assertions covering state management, prompt generation, tool definitions, handler execution, and result parsing — all without calling the Anthropic API.

## License

MIT
