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

3. Display a summary. The header line for the active/completed feature depends on state:

   - If `state == "merged"` or `state == "escalated"`: show `Completed feature: {name} ✓` (or `✗` for escalated)
   - If `state == "pr_created"`: show `Awaiting merge: {name} (PR #{pr_number})`
   - Otherwise (any intermediate state): show `Active feature: {name}`
   - If no features or all features are in terminal states with no active_feature: show `Active feature: none`

```
SDD Autopilot Status — {project name}
Initialized: {date}
{feature header line from above}

Features:
  {feature-name}:
    State: {state}
    Tasks: {completed}/{total}
    Verification attempts: {n}
    Review attempts: {n}
    Spec: {spec_path}
    Branch: {branch or "n/a"}
    PR: {pr_url or "n/a"}
```

4. If the feature has a spec file (`spec_path` from state.json), read it and extract a TL;DR section. Append it after the feature block:

```
📋 Spec TL;DR:
- Scope: {3-5 lines summarizing what the spec covers — extract from functional requirements and feature description}
- Key decisions: {up to 3 main technical decisions — extract from NFRs, constraints, or architecture notes in the spec}
- Out of scope: {what was explicitly excluded — extract from "Out of scope" or "Non-goals" section if present, otherwise "Not specified"}
- Risk: {primary risk identified — extract from risks/edge cases section if present, otherwise "None identified"}
```

   **Extraction rules:**
   - Read the spec file at `spec_path`. If the file doesn't exist or is unreadable, skip the TL;DR entirely.
   - Extract from actual spec content only — never invent or infer information not present in the spec.
   - For "Scope": summarize the functional requirements (FRs) into 3-5 concise bullet points.
   - For "Key decisions": look for NFRs, constraints, technology choices, or architecture decisions. Max 3.
   - For "Out of scope": look for sections titled "Out of scope", "Non-goals", "Exclusions", or similar. If none found, write "Not specified in spec".
   - For "Risk": look for sections titled "Risks", "Edge cases", "Open questions", or similar. Pick the highest-impact one. If none found, write "None identified".

5. If there's an active feature or a feature awaiting merge, show its transition history.

6. If no features exist, report: "No features yet. Run `/sdd-auto:run \"feature description\"` to start."

$ARGUMENTS
