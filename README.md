# SDD Autopilot

A Claude Code plugin that takes a one-sentence feature description and autonomously produces a reviewed pull request. It breaks the feature into a spec, plan, tasks, implementation, verification, and code review — each handled by a dedicated AI agent — so you get structured, repeatable feature development without managing the process yourself.

## Why

Claude Code is great for ad-hoc coding tasks, but building a complete feature — with a spec, architecture decisions, task breakdown, implementation, tests, and review — requires you to drive every step. SDD Autopilot automates that entire ceremony. You describe what you want, it handles the how, and you review the PR.

## Quick Start

```bash
# Install from Claude Code marketplace
# Search for "sdd-autopilot" and install

# Or from source:
git clone https://github.com/rubenzarroca/sdd-autopilot.git ~/.claude/plugins/local/sdd-autopilot
cd ~/.claude/plugins/local/sdd-autopilot/engine && npm install && npm run build

# Run a feature:
/sdd-auto:run health-check "Add a health check endpoint that returns server status"
```

## How It Works

- **Triage** classifies your feature by complexity and picks the right execution mode (Express, Light, Standard, or Full)
- **Spec/Plan/Tasks** phases generate structured artifacts that each subsequent phase builds on
- **Implementation** runs one agent per task, with automatic parallelization for independent tasks
- **Verification + Review** catch issues before the PR — with automated fix loops if something fails
- **Adaptive learning** records metrics from every run and uses them to improve future runs

For the full architecture, see [docs/architecture.md](docs/architecture.md).

## Commands

| Command | Description |
|---------|-------------|
| `/sdd-auto:run [name] ["brief"]` | Run the full pipeline: triage through PR |
| `/sdd-auto:init` | Initialize a project (creates `.sdd/state.json`, scaffolds docs) |
| `/sdd-auto:status` | Show feature states, task progress, and score history |

## Configuration

The pipeline selects an execution mode automatically based on feature complexity:

| Mode | When | What runs |
|------|------|-----------|
| Express | Trivial changes | triage -> implement -> PR |
| Light | Low complexity | triage -> specify -> implement -> verify -> PR |
| Standard | Medium complexity | All 8 phases |
| Full | High/critical | All 8 phases + optional Opus review (`--opus-review`) |

## Requirements

- Claude Code CLI with plugin support
- Node.js 18+
- `git` and `gh` (GitHub CLI) for PR creation

## Links

- [Architecture](docs/architecture.md) — pipeline phases, state machine, file structure
- [Tools Reference](docs/tools.md) — all 38 MCP tools across 4 categories
- [Observability & Metacognition](docs/observability.md) — learning loop, analytics, anomaly detection
- [Memory Intelligence](docs/memory.md) — two-layer memory model
- [Changelog](CHANGELOG.md)

## License

MIT
