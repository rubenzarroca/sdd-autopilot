# Patch: Tool Factory Integration

Integrates the self-extending tool proposal system into the orchestrator pipeline.
Three new tools: `sdd_propose_tool`, `sdd_review_tool_proposal`, `sdd_generate_tool_prompt`.

---

## Insertion A: Gap Detection Protocol

**Location:** AFTER `## Signal routing` section (after the end of META_LEARNING_HINT subsection, line ~355), BEFORE `## Error handling` (line ~357).

**Rationale:** Gap detection is a signal-adjacent capability — the orchestrator detects gaps during normal signal processing and pipeline execution. Placing it here keeps all routing/detection logic together.

**Insert:**

```markdown
### Gap Detection Protocol

During pipeline execution, the orchestrator may encounter situations where no existing tool covers a needed capability. When this happens, document the gap as a structured proposal without stopping the pipeline.

**Detection triggers:**
- "I need to do X but no tool supports it" — a capability is completely missing
- "I'm using sdd_Y as a workaround for Z" — a tool is being misused because the right one doesn't exist
- "A subagent requested capability X via signal but I can't act on it" — a signal implies a capability the orchestrator lacks

**When a gap is detected:**

1. Call `mcp__sdd-autopilot__sdd_propose_tool` with all required fields:
   ```
   mcp__sdd-autopilot__sdd_propose_tool(
     project_path:           "{project_path}",
     name:                   "sdd_{descriptive_name}",
     description:            "{one-line description of what the tool does}",
     rationale:              "{why the orchestrator needs this — what it tried to do and couldn't}",
     proposed_input_schema:  { /* JSON Schema of expected inputs */ },
     proposed_output_schema: { /* JSON Schema of expected outputs */ },
     proposed_handler_logic: "{pseudocode or detailed description of handler behavior}",
     target_file:            "{handlers.ts | observability.ts | metacognition.ts | tool-factory.ts}",
     pipeline_phase:         "{phase where the gap was detected}",
     trigger_context:        "{specific situation in this run that triggered the proposal}"
   )
   ```
2. Continue the pipeline with whatever workaround is available. The proposal is async — it does NOT block execution.
3. Log the gap detection:
   ```
   sdd_log_event(project_path, feature_id, event_type="gap_detected", phase="{current_phase}", agent_id="orchestrator",
     data={ proposed_tool: "{name}", trigger: "{brief trigger description}" })
   ```

**Governance rules:**
- **Max 2 proposals per run.** If more than 2 gaps are detected, prioritize the 2 most impactful and log the rest as signals:
  ```
  sdd_append_signal(project_path, feature_id, signal={
    type: "CONTEXT_NOTE",
    source: "orchestrator",
    content: "Additional gap detected but proposal limit reached: {description}"
  })
  ```
- **Rejected proposals are never re-proposed.** Before calling `sdd_propose_tool`, check if `.sdd/proposals/tool-{name}.json` already exists. If it does and its status is "rejected", do NOT re-propose. Log and move on.
- **The orchestrator NEVER implements tools.** It can only propose. There is no path in the pipeline that allows the orchestrator to write handler code.
- **Validated proposals have a TTL of 30 days.** If not implemented by a human within 30 days of validation, they decay and are considered obsolete.
```

---

## Insertion B: Post-pipeline Proposal Review

**Location:** AFTER post-pipeline step 6 (`sdd_run_retro`, line ~480), BEFORE step 7 (haiku-analyst retro, line ~482). Insert as step 6b.

**Rationale:** Review proposals after the run completes but before the retro analysis, so the retro can reference any validated proposals as pipeline improvement signals.

**Insert:**

```markdown
6b. **Review tool proposals (conditional):**
   If any tool proposals were created during this run (check `.sdd/proposals/` for files with `status: "proposed"` and matching `run_id`):

   For each proposal:
   ```
   review_result = mcp__sdd-autopilot__sdd_review_tool_proposal(
     project_path:  "{project_path}",
     proposal_name: "{proposal.name}"
   )
   ```

   If `review_result.status == "validated"`:
   ```
   mcp__sdd-autopilot__sdd_generate_tool_prompt(
     project_path:  "{project_path}",
     proposal_name: "{proposal.name}"
   )
   ```
   Log: "Tool proposal '{name}' validated. Prompt generated at .sdd/proposals/prompt-{name}.md"

   If `review_result.status == "rejected"`:
   Log: "Tool proposal '{name}' rejected: {review_result.reason}"

   This step is optional and non-blocking. If no proposals exist, skip entirely.
```

---

## Insertion C: Run Start — Proposal Awareness

**Location:** INSIDE `### ADAPTIVE RUN START`, as Step 5 (after Apply experiment, before Log adaptive decisions).

**Note:** This insertion was already applied by the Strategy-Integrator as part of the Adaptive Run Start rewrite. Verify it is present before applying. If already present, skip.

**Insert:**

```markdown
**Step 5 -- Proposal awareness (informational):**
Read `.sdd/proposals/` directory. For each `.json` file, check if `status` is `"validated"` or `"prompt_generated"`.

If pending proposals exist, store them in a `pending_proposals` list and include an awareness note in the run context:
```
## Pending Tool Proposals
The following tools have been proposed and validated but not yet implemented:
{for each: "- {name}: {description} (proposed {proposed_at})"}
Consider whether any of these would help with the current feature.
```

If the directory does not exist or contains no validated proposals, skip this step silently.
```

---

## Insertion D: Human Debrief

**Location:** AFTER `### ADAPTIVE RUN CLOSE` Step 6 (`sdd_tick_decay`), BEFORE `### Tracking run_count`. This is the absolute last step before the orchestrator's final message to the user.

**Rationale:** Aggregate all items requiring human attention into a single, clear debrief block. The run is already complete — this is informational.

**Insert:**

```markdown
**Step 7 -- Human Debrief:**

Before showing the final completion message to the user, collect all items requiring human attention. Build the debrief from these 7 sources:

1. **Tool proposals validated this run:** Read `.sdd/proposals/` for entries with `status: "validated"` or `"prompt_generated"` and `run_id` matching the current run.
2. **Evolutions pending human approval:** Read `.sdd/metacognition/evolutions.json` for entries with `status: "proposed"` and `requires_human: true`.
3. **Critical threshold alerts:** From the `sdd_check_thresholds` response (post-pipeline step 3), filter alerts where `level: "critical"`.
4. **Anomaly flags:** From the `sdd_detect_anomaly` response (post-pipeline step 4), if `is_anomaly: true`.
5. **Golden degradation:** From the `sdd_compute_score` response (post-pipeline step 2), if `golden_comparison.status: "below_threshold"`.
6. **Memory sanitization warnings:** From `feature.signals`, filter signals with `type: "memory_sanitization_warning"`.
7. **Pending proposals from previous runs:** Read `.sdd/proposals/` for entries with `status: "validated"` or `"prompt_generated"` from previous runs (different `run_id`).

**Output format:**

Show only sections that have items. If no items in any category, show the "all clear" message.

```
──────────────────────────────────
🧑 HUMAN DEBRIEF — Items requiring your attention:

🔧 TOOL PROPOSALS ({count} new)
→ {name}: "{description}"
  Prompt ready: .sdd/proposals/prompt-{name}.md

📐 EVOLUTION PENDING APPROVAL ({count})
→ {evolution_id}: {type} {description}
  Approve: call sdd_approve_evolution with evolution_id="{id}", decision="approve"
  Reject: call sdd_approve_evolution with evolution_id="{id}", decision="reject"

⚠️ CRITICAL ALERTS ({count})
→ {phase}: {alert.message}

📊 ANOMALY DETECTED
→ {metric} z-score: {z_score} (expected ~{mean}, actual {value})

📉 GOLDEN DEGRADATION
→ Score {current_score} vs golden {golden_score} (delta: {delta})

🧹 MEMORY SANITIZATION WARNINGS ({count})
→ {signal.content}

🔧 PENDING PROPOSALS FROM PREVIOUS RUNS ({count})
→ {name}: "{description}" (proposed {proposed_at})
  Prompt: .sdd/proposals/prompt-{name}.md
──────────────────────────────────
```

If no items exist in any category:
```
🧑 HUMAN DEBRIEF: No action items. All clear.
```

The debrief is the LAST thing shown before the final completion message. It does not block the pipeline — the run is already complete.
```

---

## Governance Summary

These rules apply across all insertions:

| Rule | Enforcement |
|------|-------------|
| Max 2 proposals per run | Gap Detection Protocol (Insertion A) |
| Proposals do NOT block the pipeline | All insertions — async, non-blocking |
| Rejected proposals never re-proposed | Gap Detection Protocol check before propose |
| Validated proposals TTL 30 days | Decay check — human review via Debrief |
| Orchestrator NEVER implements tools | Hard rule — no code generation path exists |
| `.sdd/proposals/` created on-demand | `sdd_propose_tool` handler creates via `mkdir -p` |
