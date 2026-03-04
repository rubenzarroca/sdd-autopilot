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
  "features": {},
  "allowed_transitions": {
    "drafting": ["specified"],
    "specified": ["planned"],
    "planned": ["tasked"],
    "tasked": ["implementing"],
    "implementing": ["verifying"],
    "verifying": ["reviewing", "implementing"],
    "reviewing": ["completed", "implementing"],
    "completed": []
  }
}
```

4. Report success: "Project initialized for SDD Autopilot at {path}. Run `/sdd-auto:run \"feature description\"` to start."

## Notes

- The project name is derived from the directory name.
- No constitution.md or PRD is required — the autopilot works without them but produces better specs when they exist.
- If the user also has the original sdd-plugin, both can coexist. The state.json format is compatible (autopilot adds verifying/reviewing states).

$ARGUMENTS
