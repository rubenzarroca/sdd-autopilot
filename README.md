# SDD Autopilot

Zero-stop, fully autonomous **specify → plan → tasks → implement → verify → review → PR** pipeline for Claude Code. Adaptive learning built in — each run makes the next one smarter.

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

After every run: the **observability layer** records phase metrics, aggregates a RunSummary, and computes a composite pipeline score. The **metacognition layer** learns exploitation patterns, runs controlled experiments, and proposes structural evolutions — automatically.

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
│  Adaptive: 80% exploitation (apply active patterns) /           │
│            20% exploration (run experiment every 5th run)       │
│                                                                 │
│  For each phase:                                                │
│  1. sdd_get_state → sdd_get_contract → sdd_memory_read          │
│  2. Spawn subagent · sdd_emit_metrics (per phase)               │
│  3. sdd_evaluate_gate                                           │
│  4a. gate=mechanical|haiku-validator → sdd_transition (generic) │
│  4b. gate=self (verify/review) → read structured output:        │
│       VERIFICATION_RESULT.status = PASS → verifying→reviewing   │
│       REVIEW_RESULT.decision = APPROVE  → reviewing→pr_created  │
│       REVIEW_RESULT.decision = REQUEST_CHANGES → fix_review loop│
│  5. sdd_log_event                                               │
│  Post-pipeline: sdd_get_run_summary → sdd_compute_score         │
│                 haiku-analyst retro → sdd_memory_write          │
│                 sdd_tick_patterns → sdd_tick_decay (TTL prune)  │
│  Every N runs: opus-meta-reviewer → sdd_propose_evolution       │
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
│  [meta] opus-meta-reviewer ── periodic pipeline evolution    │  │
│         opus               ── proposes weight/structure      │  │
│         spawned every N runs by the orchestrator             │  │
│                                                              │  │
│  haiku-analyst (retro mode) ◄────────────────────────────────┘  │
└──────────────────────────┬──────────────────────────────────────┘
                           │  mcp__sdd-autopilot__sdd_* tools
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│             MCP SERVER  (engine/src/)  stdio transport          │
│                                                                 │
│  index.ts ── handlers.ts ── state.ts ── memory.ts               │
│              tasks.ts ──── observability.ts ── metacognition.ts │
│              utils.ts (fileExists · parseJsonl)                 │
│                                                                 │
│  ── 39 tools ──────────────────────────────── consumer ──────── │
│                                                                 │
│  CORE PIPELINE (13)                                             │
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
│                                                                 │
│  OBSERVABILITY (9)                                              │
│  sdd_emit_metrics       ◄── orchestrator (per phase)            │
│  sdd_get_run_summary    ◄── orchestrator (post-pipeline)        │
│  sdd_get_analytics      ◄── orchestrator · meta-reviewer        │
│  sdd_check_thresholds   ◄── orchestrator (loop/duration guard)  │
│  sdd_estimate_cost      ◄── orchestrator (post-pipeline)        │
│  sdd_get_live_status    ◄── orchestrator · auto-status skill    │
│  sdd_compare_runs       ◄── meta-reviewer · analyst             │
│  sdd_detect_anomaly     ◄── orchestrator (post-pipeline)        │
│  sdd_validate_metrics   ◄── orchestrator (pre-persist)          │
│                                                                 │
│  METACOGNITION (14)                                             │
│  sdd_compute_score      ◄── orchestrator (post-pipeline)        │
│  sdd_get_patterns       ◄── orchestrator (run-start)            │
│  sdd_propose_pattern    ◄── orchestrator (run-close)            │
│  sdd_promote_pattern    ◄── orchestrator (gate check)           │
│  sdd_tick_patterns      ◄── orchestrator (post-pipeline)        │
│  sdd_propose_experiment ◄── orchestrator (exploration runs)     │
│  sdd_evaluate_experiment◄── orchestrator (post-experiment run)  │
│  sdd_propose_evolution  ◄── opus-meta-reviewer                  │
│  sdd_approve_evolution  ◄── orchestrator (human gate)           │
│  sdd_abandon_experiment ◄── orchestrator (cancel without eval)  │
│  sdd_update_pattern     ◄── orchestrator (supporting_runs++)    │
│  sdd_get_strategy       ◄── orchestrator (run-start)            │
│  sdd_run_retro          ◄── haiku-analyst (post-pipeline)       │
│  sdd_phase_confidence   ◄── orchestrator (per phase)            │
│                                                                 │
│  INFRASTRUCTURE (3)                                             │
│  sdd_set_golden         ◄── orchestrator (benchmark run)        │
│  sdd_get_manifest       ◄── orchestrator (drift detection)      │
│  sdd_breadcrumb         ◄── all subagents (audit trail)         │
└──────────────────────────┬──────────────────────────────────────┘
                           │  R/W
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                  PERSISTENCE LAYER  (.sdd/)                     │
│                                                                 │
│   state.json   ◄── feature states + task list + signals         │
│   memory.md    ◄── 2-layer (project scope / user scope)         │
│   runs/        ◄── metrics.jsonl · summary.json per feature     │
│   specs/       ◄── spec.md · plan.md · tasks.md per feature     │
│   escalation/  ◄── escalation reports                           │
│   analytics/   ◄── history.jsonl (cross-run RunSummaries)       │
│   metacognition/ ◄ patterns.json · experiments.json ·          │
│                    evolutions.json · score_weights.json          │
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
│  gate=mechanical:     orchestrator evaluates + transitions      │
│  gate=haiku-validator: haiku-validator evaluates semantically   │
│  gate=self:           structured agent output drives transition  │
└─────────────────────────────────────────────────────────────────┘
```

Two hard layers. The MCP server is deterministic Node.js — no LLM, pure state. The subagents are Claude — no state, pure reasoning. The orchestrator skill wires them together.

## Observability & Metacognition

Each pipeline run feeds a learning loop that adapts future runs:

```
                      PIPELINE RUN
                           │
                           │  sdd_emit_metrics (once per phase)
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  OBSERVABILITY  (.sdd/runs/{feature}/)                       │
│                                                              │
│  metrics.jsonl ──► sdd_get_run_summary ──► summary.json      │
│                              │                               │
│                    sdd_get_analytics ──► analytics/           │
│                              │            history.jsonl       │
└──────────────────────────────┼───────────────────────────────┘
                               │  RunSummary + AnalyticsResult
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  METACOGNITION  (.sdd/metacognition/)                        │
│                                                              │
│  sdd_compute_score ─────────────────────► CompositeScore     │
│    quality_weight=0.70 · efficiency_weight=0.30              │
│    sub-scores: review_result · findings · fix_loops ·        │
│                phases_skipped · duration_trend               │
│                                                              │
│  ┌──────────────────────┐  ┌──────────────────────────────┐  │
│  │   EXPLOITATION       │  │   EXPLORATION                │  │
│  │   (80% of runs)      │  │   (every 5th run)            │  │
│  │                      │  │                              │  │
│  │  sdd_get_patterns    │  │  sdd_propose_experiment      │  │
│  │    → apply active    │  │    (one-active constraint)   │  │
│  │      patterns        │  │  sdd_evaluate_experiment     │  │
│  │                      │  │    verdict: promote /        │  │
│  │  sdd_propose_pattern │  │             discard / retry  │  │
│  │  sdd_promote_pattern │  │                              │  │
│  │    (gate: ≥5 runs,   │  │                              │  │
│  │     confidence≥0.70) │  │                              │  │
│  │  sdd_tick_patterns   │  │                              │  │
│  │    (TTL decay)       │  │                              │  │
│  └──────────────────────┘  └──────────────────────────────┘  │
│                                                              │
│  sdd_propose_evolution ──────────────────► evolutions.json   │
│    structural (phase_add/remove/agent_redesign)               │
│      → requires_human=true always                            │
│    weight_adjust / contract_change                           │
│      → auto-applicable by orchestrator                       │
└──────────────────────────────┬───────────────────────────────┘
                               │  every N runs
                               ▼
                    opus-meta-reviewer (subagent)
                    analyzes cross-run trends →
                    proposes ≤2 evolutions per review →
                    logs meta_review_complete event
```

The score formula is stable across runs. Only `score_weights.json` is adjustable — and only by ±0.05 per review cycle, with full audit trail.

Golden run benchmarks (`sdd_set_golden`) let `sdd_compute_score` compare the current run against a known-good baseline. Subagent breadcrumbs (`sdd_breadcrumb`) record decision points across the pipeline for post-run audit. Z-score anomaly detection and threshold checks catch regressions automatically.

### Memory intelligence

Memory operations include three defensive layers:

- **Provenance metadata** — every entry records agent, run_id, feature_id, and confidence
- **Prompt injection sanitization** — blocklist filter on all memory writes
- **Jaccard similarity consolidation** — deduplicates entries above similarity threshold on write
- **Extraction pattern validation** — structured filter ensures reads return well-formed data

## State machine

Transition graph enforced in code (`AGENT_PERMISSIONS` in `engine/src/state.ts`), not in `state.json`:

```
                        ┌──────────────────────────────────────────┐
                        │  escalated  ← orchestrator, any state    │
                        └──────────────────────────────────────────┘

 draft ──▶ specified ──▶ planned ──▶ decomposed ──▶ implementing ──▶ verifying ──▶ reviewing ──▶ pr_created
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
│       ├── opus-meta-reviewer.md  # Periodic pipeline evolution agent
│       ├── haiku-analyst.md
│       ├── haiku-validator.md
│       └── pr-creator.md
│
├── skills/
│   ├── auto-run/SKILL.md    # /sdd-auto:run — pipeline orchestrator
│   ├── auto-init/SKILL.md   # /sdd-auto:init
│   └── auto-status/SKILL.md # /sdd-auto:status
│
├── docs/
│   └── examples/
│       └── health-check-endpoint/  # Real pipeline run — spec · plan · tasks · ADR · run log
│
├── engine/                  # MCP server (TypeScript, stdio transport)
│   ├── src/
│   │   ├── index.ts         # Entry point — 39 sdd_* tools registered
│   │   ├── handlers.ts      # Core deterministic tool handlers
│   │   ├── state.ts         # StateManager + AGENT_PERMISSIONS governance
│   │   ├── memory.ts        # Two-layer memory (project + user scope)
│   │   ├── tasks.ts         # parseTasks() + computeWaves()
│   │   ├── observability.ts # PhaseMetrics · RunSummary · cross-run analytics
│   │   ├── metacognition.ts # Scoring · patterns · experiments · evolution
│   │   ├── types.ts         # Shared types (FindingSeverity, PhaseMetrics, …)
│   │   ├── utils.ts         # Shared utilities (fileExists, parseJsonl)
│   │   └── contracts.json   # Pipeline phase definitions (single source of truth)
│   ├── tests/
│   │   └── e2e/             # Behavioral pipeline tests (20 tests)
│   ├── test-e2e.mjs         # Mechanical tests (270+ assertions, no API calls)
│   ├── docs/
│   │   └── GAP-09-READINESS.md  # Token & cost tracking readiness doc
│   ├── scripts/
│   │   └── compute-tools-hash.mjs  # SHA-256 hash of tool definitions
│   ├── tools-manifest.json  # Tool manifest for drift detection
│   ├── package.json
│   └── tsconfig.json
```

## MCP tools

### Core pipeline (13 tools)

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

### Observability (9 tools)

| Tool | Purpose |
|------|---------|
| `sdd_emit_metrics` | Record PhaseMetrics for a completed phase (duration, fix_loops, outcome) |
| `sdd_get_run_summary` | Aggregate metrics.jsonl → RunSummary (first_pass_rate, phases_skipped, total_fix_loops) |
| `sdd_get_analytics` | Cross-run analytics: score trends, high-variance phases, avg duration by phase |
| `sdd_check_thresholds` | Detect when metrics cross thresholds (fix loops, duration ratio, first pass rate) |
| `sdd_estimate_cost` | Estimate cost in USD from token consumption |
| `sdd_get_live_status` | Query which phase is currently executing |
| `sdd_compare_runs` | Compare two pipeline runs side by side |
| `sdd_detect_anomaly` | Z-score anomaly detection vs historical distribution |
| `sdd_validate_metrics` | Validate PhaseMetrics before persisting |

### Metacognition (14 tools)

| Tool | Purpose |
|------|---------|
| `sdd_compute_score` | Compute composite pipeline score (quality_weight=0.70 · efficiency_weight=0.30) |
| `sdd_get_patterns` | Read active ExploitationPatterns matching current run context |
| `sdd_propose_pattern` | Propose a new ExploitationPattern (status=candidate) |
| `sdd_promote_pattern` | Promote candidate → active (gate: ≥5 supporting runs, confidence≥0.70) |
| `sdd_tick_patterns` | Decrement TTL on all active patterns (status→decayed at 0) |
| `sdd_propose_experiment` | Propose a controlled experiment (one-active constraint enforced) |
| `sdd_evaluate_experiment` | Set verdict on the active experiment (promote / discard / retry, max 2 retries) |
| `sdd_propose_evolution` | Propose a PipelineEvolution; structural types always require human approval |
| `sdd_approve_evolution` | Approve or reject a PipelineEvolution |
| `sdd_abandon_experiment` | Cancel an experiment without evaluating |
| `sdd_update_pattern` | Increment supporting_runs / update confidence on a pattern |
| `sdd_get_strategy` | Read active patterns + experiments + weights for run strategy |
| `sdd_run_retro` | Generate structured retro report for a completed run |
| `sdd_phase_confidence` | Assign confidence score to phase output |

### Infrastructure (3 tools)

| Tool | Purpose |
|------|---------|
| `sdd_set_golden` | Set golden run benchmark; `sdd_compute_score` compares against it |
| `sdd_get_manifest` | Get SHA-256 hash of tool definitions for version drift detection |
| `sdd_breadcrumb` | Record subagent decision breadcrumbs for audit trail |

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

Autonomously generates spec → plan → tasks → implements all tasks → verifies → reviews → opens PR. After the pipeline completes, records phase metrics, computes a composite score, and updates learned patterns.

**Flags:**
- `--skip-worktree` — Work in place, no git worktree
- `--skip-pr` — Skip PR creation (useful for testing)

### `/sdd-auto:init` — Initialize a project

```
/sdd-auto:init
```

Creates `.sdd/state.json` in your project root. Optional — `/sdd-auto:run` auto-initializes if needed. `.sdd/` is gitignored by design; it holds runtime state, not source code.

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

# Mechanical tests — all 39 tool handlers
node test-e2e.mjs
# → 270+ assertions PASS

# Behavioral pipeline tests — full lifecycle scenarios
npm run test:e2e
# → 20 tests covering pipeline end-to-end behavior
```

270+ assertions covering all 39 MCP tool handlers — core pipeline, state machine boundaries, memory (provenance, sanitization, consolidation), signal routing, gate evaluation, delta check, observability (PhaseMetrics, RunSummary, cross-run analytics, thresholds, anomaly detection), metacognition (composite scoring, exploitation patterns, experiments, pipeline evolution, golden benchmarks), and infrastructure (manifests, breadcrumbs) — all without any API calls. The 20 behavioral tests validate full pipeline lifecycle scenarios including multi-phase transitions and fix loops.

## License

MIT
