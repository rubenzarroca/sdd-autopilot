# Signal Routing Reference

During the pipeline, agents may emit signals via `sdd_append_signal`. The orchestrator routes each signal based on its type. Signals are read at each phase boundary — before launching the next subagent, call `sdd_get_state` with `feature_id` and read `feature.signals`.

## Signal processing protocol

At the start of each phase (after reading current feature state):

1. Read `feature.signals` from the `sdd_get_state` response.
2. Filter signals that have not yet been processed. Track processed signal indices in a local `processed_signals` set (initialized empty at pipeline start).
3. For each unprocessed signal, route based on `signal.type`:

## ATTENTION_REQUIRED

**Mechanism:** Inject into the next subagent context.

1. Read the signal `content` field.
2. Prepend to the next Agent tool prompt under a `## Attention Signals` header:
   ```
   ## Attention Signals
   The following issues were flagged by a previous agent and require your attention:
   - [{signal.source}]: {signal.content}
   ```
3. Mark signal as processed.

## PATTERN_DETECTED

**Mechanism:** Store in project memory and inject into agents of the same type.

1. Call MEM_WRITE with section `"patterns"`, content `"Pattern detected by {signal.source}: {signal.content}"`.
2. For subsequent phases, check if the next subagent is of the same type as `signal.source`. If so, inject into the Agent tool prompt under `## Detected Patterns`.
3. Mark signal as processed after memory write.

## DEPENDENCY_WARNING

**Mechanism:** Inject into plan-architect (if re-planning) and implementation-engine.

1. Accumulate all DEPENDENCY_WARNING signals into a `dependency_warnings` list.
2. When launching `plan-architect` or `implementation-engine`: include in prompt under `## Dependency Warnings`.
3. Mark signals as processed after the last implementation-engine task completes.

## CONTEXT_NOTE

**Mechanism:** Inject into the immediately downstream agent only.

1. Read the signal `content` field.
2. Inject into the NEXT subagent prompt under `## Context Notes`.
3. Mark signal as processed after that single injection. Do NOT propagate to further downstream agents.

## META_LEARNING_HINT

**Mechanism:** Buffer until post-pipeline; process in batch.

1. Do NOT inject into any subagent context during the pipeline.
2. Accumulate all META_LEARNING_HINT signals into a `meta_learning_buffer` list (initialized empty at pipeline start).
3. After PR creation (post-pipeline step 8): write each hint to memory via MEM_WRITE with section `"learnings"`.
4. Feed the full buffer as context to the inline retro analysis.
5. Mark all META_LEARNING_HINT signals as processed after the retro completes.

## Gap Detection Protocol

During pipeline execution, the orchestrator may encounter situations where no existing tool covers a needed capability.

**Detection triggers:**
- "I need to do X but no tool supports it"
- "I'm using sdd_Y as a workaround for Z"
- "A subagent requested capability X via signal but I can't act on it"

**When a gap is detected:**

1. Call `sdd_propose_tool` with: name, description, rationale, proposed_input_schema, proposed_output_schema, proposed_handler_logic, target_file, pipeline_phase, trigger_context.
2. Continue the pipeline with whatever workaround is available. The proposal is async — it does NOT block execution.
3. LOG with `event_type="gap_detected"`.

**Governance rules:**
- Max 2 proposals per run. If more detected, log extras as CONTEXT_NOTE signals.
- Rejected proposals are never re-proposed. Check `.sdd/proposals/tool-{name}.json` status before proposing.
- The orchestrator NEVER implements tools — it can only propose.
- Validated proposals have a TTL of 30 days.
