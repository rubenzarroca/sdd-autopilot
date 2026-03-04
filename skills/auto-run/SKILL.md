---
name: sdd-auto:run
description: >
  Run the full SDD Autopilot pipeline: specify → plan → tasks → implement → verify → review → PR.
  Zero stops, fully autonomous. Invokes the PTC engine as a subprocess.
  Use when the user says "auto run", "autopilot", "sdd auto", "build this feature autonomously",
  or runs /sdd-auto:run.
argument-hint: '"<feature description>" [--skip-worktree] [--skip-pr]'
user-invokable: true
---

# /sdd-auto:run — Full autonomous SDD pipeline

You are launching the SDD Autopilot pipeline. This runs the complete specify → plan → tasks → implement → verify → review → PR flow without stopping for user input.

## What to do

1. Parse the feature description from `$ARGUMENTS`. If empty, ask the user what feature they want to build.

2. Determine the project path. Use the current working directory unless the user specified a different path.

3. Run the autopilot engine:

```bash
cd ~/.claude/plugins/local/sdd-autopilot/engine && node build/index.js "$FEATURE_DESCRIPTION" --project "$PROJECT_PATH" $EXTRA_FLAGS
```

Where:
- `$FEATURE_DESCRIPTION` is the user's feature description (in quotes)
- `$PROJECT_PATH` is the absolute path to the project
- `$EXTRA_FLAGS` includes `--skip-worktree` or `--skip-pr` if the user requested them

4. Stream the output to the user. The engine prints progress for each phase.

5. When the pipeline completes:
   - If successful: report the PR URL and a summary of what was built
   - If failed (escalation): report which phase failed and what the findings were

## Flags

- `--skip-worktree`: Work directly in the project directory instead of creating a git worktree
- `--skip-pr`: Skip the PR creation step (useful for testing)

## Prerequisites

The engine must be built first. If `~/.claude/plugins/local/sdd-autopilot/engine/build/index.js` doesn't exist:

```bash
cd ~/.claude/plugins/local/sdd-autopilot/engine && npm install && npm run build
```

The `ANTHROPIC_API_KEY` environment variable must be set for the PTC engine to call the Anthropic API.

## Example

User: `/sdd-auto:run "Add a health check endpoint that returns server status and uptime"`

This will:
1. Generate a spec at `specs/health-check-endpoint/spec.md`
2. Generate a plan at `specs/health-check-endpoint/plan.md`
3. Decompose into tasks at `specs/health-check-endpoint/tasks.md`
4. Create a worktree and branch `feat/health-check-endpoint`
5. Implement all tasks
6. Run verification (Sonnet — tests, spec coverage, regression)
7. Run adversarial review (Opus — correctness, security, performance, maintainability, side effects)
8. Create a PR with the spec as body

$ARGUMENTS
