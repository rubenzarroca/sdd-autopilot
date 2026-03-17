# DX Output Protocol — Completion Report Template

**Referenced from:** `skills/auto-run/SKILL.md` § DX Output Protocol

## Completion Report (MANDATORY after pipeline)

After the PR phase (step 8/8) and all post-pipeline steps finish, output this full completion report. The one-liner `✓ 8/8 [pr]` is the phase progress line — the completion report is a SEPARATE block that comes AFTER it. If you omit this table, the run is considered incomplete.

```
---
✅ Pipeline Complete: {feature_id}

┌───────────┬──────────┬──────────────────────────────────────────────────────────┐
│   Phase   │ Duration │                          Result                          │
├───────────┼──────────┼──────────────────────────────────────────────────────────┤
│ Triage    │ {dur}    │ {mode} mode, {complexity} complexity, {feature_type}     │
│ Specify   │ {dur}    │ {N} FRs, {N} NFRs, {N} ECs, {N} CMs                     │
│ Plan      │ {dur}    │ {N} ADs, {N} files, {N}-step sequence                   │
│ Tasks     │ {dur}    │ {N} tasks, {N} waves                                     │
│ Implement │ {dur}    │ {N}/{N} tasks, {N} files changed, {N} insertions         │
│ Verify    │ {dur}    │ {PASS|FAIL} {fix loop detail if any}                     │
│ Review    │ {dur}    │ {N} blocking, {N} minor {false positive note if any}     │
│ PR        │ {dur}    │ {pr_url}                                                 │
└───────────┴──────────┴──────────────────────────────────────────────────────────┘

Fix loops: {N} verify ({detail}) + {N} review ({detail})
Review loops: {N}
Total pipeline time: ~{total_duration}

Score: {pipeline_score}/100 | First-pass: {first_pass_rate}%
PR: {pr_url}
```

## Rules for this table

- Omit rows for phases that were skipped (e.g., Express mode skips Specify/Plan/Tasks).
- Duration is human-readable (e.g., `10s`, `1m 45s`, `6m 28s`).
- Result column is a one-line summary — specific to the phase, not generic.
- Fix loops line: if zero, show `0`. If nonzero, include parenthetical detail of what was fixed.
- Score and Golden lines: populate from `sdd_compute_score` response. If insufficient data, show `Golden: not enough data ({N}/{window} runs)`.
- Also consult `docs/orchestrator/post-pipeline.md` § Completion report format for token/tool/confidence columns if you have that data available — append them as extra columns.
