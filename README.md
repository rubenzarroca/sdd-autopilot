# SDD Autopilot

Zero-stop, fully autonomous **specify -> plan -> tasks -> implement -> verify -> review -> PR** pipeline for Claude Code. Adaptive learning built in — each run makes the next one smarter.

Give it a feature description. Get back a reviewed PR.

## Pipeline

```
Feature description -> Triage -> Specify -> Plan -> Tasks -> Implement -> Verify -> Review -> PR
                       haiku     sonnet     sonnet  sonnet   sonnet       sonnet    plugin   inline
```

Sonnet handles the bulk work. Haiku runs triage. Review uses the `/code-review` plugin. PR creation runs inline in the orchestrator. Each phase is a dedicated native Claude Code subagent — no direct API calls.

## Highlights

- **Fully autonomous** — no human intervention from feature description to reviewed PR
- **Adaptive learning** — observability layer records metrics; metacognition layer learns patterns across runs (80% exploitation / 20% exploration)
- **37 MCP tools** — deterministic Node.js handlers for state, memory, gates, metrics, scoring, patterns, experiments, and evolution
- **No API key needed** — Claude Code handles all model invocations through its native agent system
- **Quality gates** — `/code-review` plugin review, delta checks on fix loops, z-score anomaly detection, optional Opus pair review (`--pair-review`)

## Installation

### From Claude Code marketplace

Search for `sdd-autopilot` in the Claude Code plugin marketplace and install. The MCP server starts automatically.

### From source

```bash
git clone https://github.com/rubenzarroca/sdd-autopilot.git \
  ~/.claude/plugins/local/sdd-autopilot

cd ~/.claude/plugins/local/sdd-autopilot/engine
npm install && npm run build
```

## Usage

### `/sdd-auto:run` — Run the full pipeline

```
/sdd-auto:run health-check "Add a health check endpoint that returns server status and uptime"
```

First argument is the spec name (becomes `specs/health-check/`), second is a one-sentence brief. Both are optional — the pipeline prompts for missing arguments and stays backwards compatible with `/sdd-auto:run "description"`.

Autonomously generates spec, plan, tasks, implements, verifies, reviews, and opens a PR. After the pipeline completes, records phase metrics, computes a composite score, and updates learned patterns.

**Flags:** `--skip-worktree` (work in place), `--skip-pr` (skip PR creation)

### `/sdd-auto:init` — Initialize a project

```
/sdd-auto:init
```

Creates `.sdd/state.json` in your project root. Optional — `/sdd-auto:run` auto-initializes if needed.

### `/sdd-auto:status` — Check pipeline progress

```
/sdd-auto:status
```

Shows feature states, task progress, verification/review attempt counts, active signals, and a Spec TL;DR (scope, key decisions, out of scope, risks) extracted from the generated spec.

## Requirements

- Claude Code with plugin support
- Node.js 18+ (for the MCP server)
- `git` and `gh` (GitHub CLI) for branch push + PR creation

## Testing

```bash
cd engine
npm run build

# Mechanical tests — all tool handlers (303+ assertions)
node test-e2e.mjs

# Behavioral pipeline tests — full lifecycle scenarios (23 tests)
npm run test:e2e
```

## Documentation

- [Architecture](docs/architecture.md) — full architecture diagram, pipeline phases, state machine, file structure
- [MCP Tools Reference](docs/tools.md) — all 37 tools across 4 categories
- [Observability & Metacognition](docs/observability.md) — scoring, patterns, experiments, evolution
- [Memory Intelligence](docs/memory.md) — two-layer model, provenance, sanitization, consolidation
- [Example Run](docs/examples/health-check-endpoint/) — real pipeline output (spec, plan, tasks, ADR, run log)

## License

MIT
