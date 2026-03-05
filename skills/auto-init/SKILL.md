---
name: sdd-auto:init
description: >
  Initialize a project for SDD Autopilot. Creates .sdd/state.json with the autopilot state machine.
  Use when the user says "init sdd", "setup autopilot", "initialize project for sdd", or runs /sdd-auto:init.
argument-hint: "[project-path]"
user-invokable: true
---

# /sdd-auto:init — Initialize project for SDD Autopilot

Create the minimal SDD state file for a project.

## What to do

1. Determine the project path from `$ARGUMENTS` or use the current working directory.

2. Check if `.sdd/state.json` already exists. If it does, report the current state and ask if the user wants to reinitialize.

3. Create `.sdd/state.json`:

```json
{
  "version": "2.0.0",
  "project": "{project-name}",
  "initialized_at": "{ISO timestamp}",
  "active_feature": null,
  "features": {}
}
```

Do NOT add `allowed_transitions`. The transition graph lives in the MCP server (`AGENT_PERMISSIONS` in engine/src/state.ts), not in state.json.

4. Report success: "Project initialized for SDD Autopilot at {path}. Run `/sdd-auto:run \"feature description\"` to start."

## Notes

- The project name is derived from the directory name.
- No constitution.md or PRD is required — the autopilot works without them but produces better specs when they exist.
- Feature states used by v2: `draft`, `specified`, `planned`, `decomposed`, `implementing`, `verifying`, `reviewing`, `pr_created`, `merged`, `fix_loop`, `fix_review`, `awaiting_input`, `blocked`, `escalated`.

$ARGUMENTS
