---
name: sdd-auto:status
description: >
  Show the current SDD Autopilot state for a project. Lists features, their states, task progress,
  and verification/review attempt counts. Use when the user says "sdd status", "autopilot status",
  "what's the feature state", or runs /sdd-auto:status.
argument-hint: "[project-path]"
user-invokable: true
---

# /sdd-auto:status — Show SDD Autopilot status

Display the current state of all features in the project.

## What to do

1. Determine the project path from `$ARGUMENTS` or use the current working directory.

2. Read `.sdd/state.json`. If it doesn't exist, report: "No SDD state found. Run `/sdd-auto:init` first."

3. Display a summary:

```
SDD Autopilot Status — {project name}
Initialized: {date}
Active feature: {name or "none"}

Features:
  {feature-name}:
    State: {state}
    Tasks: {completed}/{total}
    Verification attempts: {n}
    Review attempts: {n}
    Spec: {spec_path}
    Branch: {branch or "n/a"}
```

4. If there's an active feature, show its transition history.

5. If no features exist, report: "No features yet. Run `/sdd-auto:run \"feature description\"` to start."

$ARGUMENTS
