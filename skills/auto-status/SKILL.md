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

6. **Score & Golden baseline** — If `.sdd/analytics/history.jsonl` exists, read it and show the golden baseline section after the feature block (after the Spec TL;DR if present):

   Read all entries from `history.jsonl`. For each entry with a non-null `pipeline_score`, collect `{ feature_id, pipeline_score, complexity }`.

   **Complexity multipliers**: `trivial=0.6, low=0.8, medium=1.0, high=1.2, critical=1.4`

   - If fewer than 3 scored runs exist:
     ```
     📊 Score History ({N} runs — not enough for baseline, need 3+):
       {feature_id}: {pipeline_score}/100 ({complexity})
       ...
     ```

   - If 3+ scored runs exist, compute the golden baseline as a complexity-weighted moving average of the last 5 runs (or all if fewer than 5):
     - `golden = Σ(score_i × multiplier_i) / Σ(multiplier_i)`
     - Trend: compare weighted avg of first half vs second half of the window. >5% improvement → "improving ↑", >5% drop → "degrading ↓", otherwise "stable →"
     ```
     📊 Score & Golden Baseline:
       Last run: {feature_id} — {pipeline_score}/100 ({complexity})
       Golden (weighted avg, {N} runs): {golden_score}
       Delta: {delta} | Trend: {trend}
       ─────────────
       Recent runs:
         {feature_id}: {score}/100 ({complexity}, weighted: {score × mult})
         ...
     ```

   If `history.jsonl` doesn't exist, skip this section entirely.

7. If no features exist, report: "No features yet. Run `/sdd-auto:run \"feature description\"` to start."

## Error handling

- If `state.json` does not exist or fails to parse as valid JSON: report "No SDD state found — file is missing or invalid. Run `/sdd-auto:init` first." and stop.
- If `state.json` exists but has an unexpected schema (missing `features` key, wrong `version`): report "SDD state found but format is invalid (version: {version or 'unknown'}). Re-initialize with `/sdd-auto:init`."
- If a feature's `spec_path` points to a file that does not exist on disk: skip the Spec TL;DR for that feature silently (already covered in step 4).
- If `history.jsonl` exists but contains malformed JSON lines: skip those lines and compute from valid entries only. Report: "Warning: {N} malformed entries in history.jsonl were skipped."

$ARGUMENTS
