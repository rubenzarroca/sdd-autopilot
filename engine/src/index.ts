#!/usr/bin/env node

// SDD Autopilot MCP Server — stdio transport
// Exposes 11 sdd_* tools for Claude Code to use natively.
// No LLM calls — purely deterministic pipeline governance.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  handleGetState,
  handleTransition,
  handleGetContract,
  handleEvaluateGate,
  handleClassifyFailure,
  handleDeltaCheck,
  handleLogEvent,
  handleMemoryRead,
  handleMemoryWrite,
  handleTickDecay,
  handleAppendSignal,
  handleUpdateTask,
  handleUpdateFeature,
} from "./handlers.js";

import {
  handleEmitMetrics,
  handleGetRunSummary,
  handleGetAnalytics,
} from "./observability.js";

import {
  handleComputeScore,
  handleGetPatterns,
  handleProposePattern,
  handlePromotePattern,
  handleTickPatterns,
  handleProposeExperiment,
  handleEvaluateExperiment,
  handleProposeEvolution,
} from "./metacognition.js";

// ─── Tool definitions (JSON Schema) ─────────────────────────────

const TOOLS = [
  {
    name: "sdd_get_state",
    description:
      "Read feature state from .sdd/state.json. Returns a single feature if feature_id is specified, otherwise returns the full state.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path: { type: "string", description: "Absolute path to the project root" },
        feature_id: { type: "string", description: "Optional: specific feature to query" },
      },
      required: ["project_path"],
    },
  },
  {
    name: "sdd_transition",
    description:
      "Transition a feature to a new lifecycle state. Enforces AGENT_PERMISSIONS governance. " +
      "Returns {success, new_state} on success, or {success:false, error:{code, message, allowed_transitions}} on failure.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path: { type: "string", description: "Absolute path to the project root" },
        feature_id: { type: "string", description: "Feature identifier" },
        from_state: { type: "string", description: "Expected current state (for safety)" },
        to_state: {
          type: "string",
          enum: [
            "draft", "specified", "planned", "decomposed",
            "implementing", "blocked", "fix_loop", "fix_review",
            "awaiting_input", "verifying", "reviewing",
            "pr_created", "merged", "escalated",
          ],
          description: "Target state",
        },
        agent_id: {
          type: "string",
          enum: [
            "spec-generator", "plan-architect", "task-decomposer",
            "implementation-engine", "verification-engine",
            "adversarial-reviewer", "pr-creator", "haiku-validator", "orchestrator",
          ],
          description: "Calling agent identity",
        },
        metadata: { type: "object", description: "Optional transition metadata" },
      },
      required: ["project_path", "feature_id", "from_state", "to_state", "agent_id"],
    },
  },
  {
    name: "sdd_get_contract",
    description:
      "Get the full contract for a pipeline phase from contracts.json. " +
      "Returns inputs, outputs, gate, execution, fix_loop, pair_review, failure_modes, next.",
    inputSchema: {
      type: "object" as const,
      properties: {
        phase_id: { type: "string", description: "Phase identifier (e.g. 'specify', 'plan', 'verify')" },
      },
      required: ["phase_id"],
    },
  },
  {
    name: "sdd_evaluate_gate",
    description:
      "Evaluate gate conditions for a phase. Performs mechanical checks (file exists, section non-empty, JSON valid). " +
      "Returns needs_semantic_validation for checks requiring LLM comprehension.",
    inputSchema: {
      type: "object" as const,
      properties: {
        phase_id: { type: "string", description: "Phase to evaluate gate for" },
        project_path: { type: "string", description: "Absolute path to the project root" },
        feature_id: { type: "string", description: "Feature identifier" },
        artifacts: {
          type: "object",
          description: "Map of artifact name to file path (relative to project_path)",
          additionalProperties: { type: "string" },
        },
      },
      required: ["phase_id", "project_path", "feature_id", "artifacts"],
    },
  },
  {
    name: "sdd_classify_failure",
    description:
      "Classify a failure as implementation_bug, spec_gap, or infra_issue using string heuristics. No LLM involved.",
    inputSchema: {
      type: "object" as const,
      properties: {
        phase_id: { type: "string", description: "Phase where failure occurred" },
        error_message: { type: "string", description: "Error message or output to classify" },
        affected_files: {
          type: "array",
          items: { type: "string" },
          description: "Files affected by the failure",
        },
        test_output: { type: "string", description: "Full test output if available" },
      },
      required: ["phase_id", "error_message"],
    },
  },
  {
    name: "sdd_delta_check",
    description:
      "Compare current failure count against previous iteration. Returns 'abort' if regression detected (more failures than before).",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path: { type: "string", description: "Absolute path to the project root" },
        feature_id: { type: "string", description: "Feature identifier" },
        phase_id: { type: "string", description: "Phase in fix loop" },
        current_failures: { type: "number", description: "Number of current failures" },
        current_failure_details: {
          type: "array",
          items: { type: "string" },
          description: "Optional failure detail strings",
        },
      },
      required: ["project_path", "feature_id", "phase_id", "current_failures"],
    },
  },
  {
    name: "sdd_log_event",
    description:
      "Append an event to .sdd/runs/{feature_id}/run.log as JSON lines. Append-only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path: { type: "string", description: "Absolute path to the project root" },
        feature_id: { type: "string", description: "Feature identifier" },
        event_type: { type: "string", description: "Event type (e.g. 'phase_start', 'phase_end', 'error')" },
        phase: { type: "string", description: "Phase name" },
        agent_id: { type: "string", description: "Agent that produced the event" },
        data: { type: "object", description: "Arbitrary event data" },
      },
      required: ["project_path", "feature_id", "event_type"],
    },
  },
  {
    name: "sdd_memory_read",
    description:
      "Read a section from SDD memory. Project memory is at .sdd/memory.md, user memory at ~/.claude/sdd-autopilot/user-memory.md.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path: { type: "string", description: "Absolute path to the project root" },
        section: {
          type: "string",
          enum: ["project_conventions", "learned_patterns", "run_history", "all"],
          description: "Which section to read",
        },
        scope: {
          type: "string",
          enum: ["project", "user"],
          description: "Memory scope (default: project)",
        },
      },
      required: ["project_path", "section"],
    },
  },
  {
    name: "sdd_memory_write",
    description:
      "Append content to a section of SDD memory. Supports TTL for learned patterns.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path: { type: "string", description: "Absolute path to the project root" },
        section: { type: "string", description: "Target section name" },
        content: { type: "string", description: "Content to append" },
        scope: {
          type: "string",
          enum: ["project", "user"],
          description: "Memory scope",
        },
        ttl: { type: "number", description: "Optional TTL in runs (for learned_patterns decay)" },
      },
      required: ["project_path", "section", "content", "scope"],
    },
  },
  {
    name: "sdd_tick_decay",
    description:
      "Decrement TTL of learned patterns and exploration entries. Removes expired entries.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path: { type: "string", description: "Absolute path to the project root" },
      },
      required: ["project_path"],
    },
  },
  {
    name: "sdd_update_task",
    description:
      "Update the status of a task within a feature. Use status='completed' to mark a task done " +
      "(required before transitioning to 'verifying'). Also supports 'pending' and 'in_progress'.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path: { type: "string", description: "Absolute path to the project root" },
        feature_id: { type: "string", description: "Feature identifier" },
        task_id: { type: "string", description: "Task identifier (e.g. TASK-001)" },
        status: {
          type: "string",
          enum: ["pending", "in-progress", "completed"],
          description: "New task status",
        },
      },
      required: ["project_path", "feature_id", "task_id", "status"],
    },
  },
  {
    name: "sdd_update_feature",
    description:
      "Persist feature metadata fields (plan_path, tasks_path, worktree_path, branch, blocked_reason, " +
      "escalation_reason, awaiting_input_reason). Use instead of writing state.json directly.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path: { type: "string", description: "Absolute path to the project root" },
        feature_id: { type: "string", description: "Feature identifier" },
        updates: {
          type: "object",
          description: "Fields to update (only provide the ones you want to change)",
          properties: {
            plan_path: { type: "string" },
            tasks_path: { type: "string" },
            worktree_path: { type: "string" },
            branch: { type: "string" },
            blocked_reason: { type: "string" },
            escalation_reason: { type: "string" },
            awaiting_input_reason: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      required: ["project_path", "feature_id", "updates"],
    },
  },
  {
    name: "sdd_append_signal",
    description:
      "Append a typed signal to .sdd/runs/{feature_id}/signals.jsonl. Append-only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path: { type: "string", description: "Absolute path to the project root" },
        feature_id: { type: "string", description: "Feature identifier" },
        from_agent: { type: "string", description: "Agent emitting the signal" },
        signal_type: { type: "string", description: "Signal category" },
        message: { type: "string", description: "Signal message" },
        severity: { type: "string", description: "Severity level (default: info)" },
      },
      required: ["project_path", "feature_id", "from_agent", "signal_type", "message"],
    },
  },

  // ─── Metacognition Layer (Phase 2+) ──────────────────────────────
  {
    name: "sdd_compute_score",
    description:
      "Compute the composite pipeline_score for a completed run. " +
      "Reads summary.json and analytics/history.jsonl, applies weighted formula (quality 70% / efficiency 30%), " +
      "persists pipeline_score back into summary.json. " +
      "Loads score weights from .sdd/metacognition/score_weights.json if present, otherwise uses defaults. " +
      "Call after sdd_get_run_summary and after patching review_decision in summary.json.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path: { type: "string", description: "Absolute path to the project root" },
        feature_id:   { type: "string", description: "Feature identifier" },
        run_id:       { type: "string", description: "Optional: validate that summary.json matches this run_id" },
      },
      required: ["project_path", "feature_id"],
    },
  },

  {
    name: "sdd_get_patterns",
    description:
      "Read ExploitationPatterns from .sdd/metacognition/patterns.json. " +
      "Filter by status (default: 'active') and optionally by feature_type and complexity to get only applicable patterns. " +
      "Call at pipeline start to determine if any active patterns apply to this run.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path:  { type: "string" },
        status:        { type: "string", enum: ["candidate", "active", "decayed", "all"], description: "Default: active" },
        feature_type:  { type: "string", description: "Optional: match patterns whose condition includes this feature_type" },
        complexity:    { type: "string", description: "Optional: match patterns whose condition includes this complexity" },
      },
      required: ["project_path"],
    },
  },
  {
    name: "sdd_propose_pattern",
    description:
      "Propose a new ExploitationPattern (status=candidate). " +
      "Called by haiku-analyst after retro when it identifies a recurring optimization opportunity. " +
      "A candidate will not be applied until promoted to active (requires supporting_runs >= min_runs AND confidence >= 0.7).",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path:     { type: "string" },
        pattern_id:       { type: "string", description: "Unique slug, e.g. 'skip-plan-api-low'" },
        type:             { type: "string", enum: ["skip_phase", "reorder", "model_swap", "prompt_tuning", "gate_adjust"] },
        condition:        { type: "string", description: "Match expression, e.g. 'feature_type=api AND complexity=low'" },
        action:           { type: "string", description: "What to do, e.g. 'skip phase=plan'" },
        confidence:       { type: "number", description: "0–1 confidence level" },
        supporting_runs:  { type: "number", description: "Number of runs supporting this pattern" },
        min_runs:         { type: "number", description: "Minimum supporting runs to promote (default 5)" },
        ttl:              { type: "number", description: "TTL in ticks before decay (default 20)" },
      },
      required: ["project_path", "pattern_id", "type", "condition", "action", "confidence", "supporting_runs"],
    },
  },
  {
    name: "sdd_promote_pattern",
    description:
      "Promote a candidate ExploitationPattern to active status. " +
      "Requires supporting_runs >= min_runs AND confidence >= 0.7. " +
      "Active patterns are applied by the orchestrator at pipeline start.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path: { type: "string" },
        pattern_id:   { type: "string" },
      },
      required: ["project_path", "pattern_id"],
    },
  },
  {
    name: "sdd_tick_patterns",
    description:
      "Decrement TTL of all active and candidate ExploitationPatterns by 1. " +
      "Patterns that reach TTL=0 are marked as decayed. " +
      "Call once per pipeline run at post-pipeline (same time as sdd_tick_decay).",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path: { type: "string" },
      },
      required: ["project_path"],
    },
  },

  {
    name: "sdd_propose_evolution",
    description:
      "Propose a PipelineEvolution — a structural or configuration change to the pipeline itself. " +
      "Called by the opus-meta-reviewer agent every N runs. " +
      "phase_add, phase_remove, agent_redesign always set requires_human=true (governance). " +
      "weight_adjust with impact=low can be applied automatically. " +
      "status starts as 'proposed'; human or automated approval sets it to 'approved'.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path:    { type: "string" },
        evolution_id:    { type: "string", description: "Unique slug, e.g. 'adjust-weights-efficiency-2026-03'" },
        type:            { type: "string", enum: ["weight_adjust", "phase_add", "phase_remove", "agent_redesign", "contract_change"] },
        description:     { type: "string" },
        rationale:       { type: "string", description: "Based on data, not opinion" },
        supporting_data: { type: "object", description: "Metrics/trends that justify this change" },
        impact:          { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["project_path", "evolution_id", "type", "description", "rationale", "supporting_data", "impact"],
    },
  },
  {
    name: "sdd_propose_experiment",
    description:
      "Propose a new Experiment (status=proposed). Only one experiment can be proposed or running at a time. " +
      "Called by haiku-analyst in creative mode after retro. " +
      "The mutation field describes the concrete pipeline change to apply when the experiment runs. " +
      "High-risk experiments must be approved by the user before the orchestrator applies them.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path:    { type: "string" },
        experiment_id:   { type: "string", description: "Unique slug, e.g. 'merge-plan-tasks-2026-03'" },
        hypothesis:      { type: "string", description: "What you expect to happen, e.g. 'merging plan+tasks will reduce duration 20%'" },
        type:            { type: "string", enum: ["phase_merge", "phase_skip", "model_swap", "parallel_expand", "gate_relax", "prompt_variant", "new_phase"] },
        mutation:        { type: "object", description: "Concrete change to apply, e.g. {merge_phases: ['plan','tasks']}" },
        expected_impact: { type: "string", description: "Expected outcome, e.g. 'duration -20%, quality neutral'" },
        risk_level:      { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["project_path", "experiment_id", "hypothesis", "type", "mutation", "expected_impact", "risk_level"],
    },
  },
  {
    name: "sdd_evaluate_experiment",
    description:
      "Evaluate a completed experiment run. Compares result_score vs baseline_score and writes a verdict. " +
      "result >= baseline → promote; result < baseline×0.9 → discard; ambiguous → retry (max 2 retries). " +
      "Call at post-pipeline when the current run had an experiment in status=running.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path:    { type: "string" },
        experiment_id:   { type: "string" },
        result_score:    { type: "number", description: "pipeline_score of the experimental run" },
        baseline_score:  { type: "number", description: "Mean pipeline_score of recent non-experimental runs (same feature_type)" },
      },
      required: ["project_path", "experiment_id", "result_score", "baseline_score"],
    },
  },

  // ─── Observability Layer (Phase 1) ────────────────────────────────
  {
    name: "sdd_emit_metrics",
    description:
      "Persist PhaseMetrics for a completed pipeline phase to .sdd/runs/{feature}/metrics.jsonl (append-only). " +
      "Call after each phase completes, before the next phase starts. " +
      "tokens_in and tokens_out are null when the Agent tool does not expose usage natively.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path: { type: "string", description: "Absolute path to the project root" },
        metrics: {
          type: "object",
          description: "PhaseMetrics object for the completed phase",
          properties: {
            run_id:            { type: "string" },
            feature_id:        { type: "string" },
            phase:             { type: "string" },
            agent:             { type: "string" },
            model:             { type: "string" },
            started_at:        { type: "string", description: "ISO8601 timestamp" },
            completed_at:      { type: "string", description: "ISO8601 timestamp" },
            duration_ms:       { type: "number" },
            tokens_in:         { type: ["number", "null"] },
            tokens_out:        { type: ["number", "null"] },
            tool_calls_count:  { type: "number" },
            gate_result:       { type: "string", enum: ["pass", "fail", "skip"] },
            gate_attempts:     { type: "number" },
            findings_count:    { type: "number" },
            findings_severity: { type: "array", items: { type: "string" } },
            fix_loop_count:    { type: "number" },
            delta_direction:   { type: ["string", "null"] },
            feature_type:      { type: ["string", "null"] },
            complexity:        { type: ["string", "null"] },
          },
          required: [
            "run_id", "feature_id", "phase", "agent", "model",
            "started_at", "completed_at", "duration_ms",
            "gate_result", "gate_attempts",
            "findings_count", "findings_severity",
            "fix_loop_count",
          ],
        },
      },
      required: ["project_path", "metrics"],
    },
  },
  {
    name: "sdd_get_run_summary",
    description:
      "Aggregate PhaseMetrics into a RunSummary for a feature run. " +
      "Persists to .sdd/runs/{feature}/summary.json and appends to .sdd/analytics/history.jsonl. " +
      "Pass last_n_runs to retrieve N most recent historical summaries instead of computing fresh.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path: { type: "string", description: "Absolute path to the project root" },
        feature_id:   { type: "string", description: "Feature identifier" },
        run_id:       { type: "string", description: "Optional: filter to a specific run_id" },
        last_n_runs:  { type: "number", description: "Optional: return last N historical summaries from analytics/history.jsonl" },
      },
      required: ["project_path", "feature_id"],
    },
  },
  {
    name: "sdd_get_analytics",
    description:
      "Cross-run analytics query over .sdd/analytics/history.jsonl. " +
      "Returns avg durations by phase, avg fix loops by feature type, first-pass rate history, " +
      "high-variance phases (optimization candidates), and trend directions (improving/regressing/stable). " +
      "Requires >= 4 runs for trend computation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path: { type: "string", description: "Absolute path to the project root" },
        feature_type: { type: "string", description: "Optional: filter by feature type (e.g. 'api', 'ui', 'refactor')" },
        complexity:   { type: "string", description: "Optional: filter by complexity (low|medium|high|critical)" },
        date_from:    { type: "string", description: "Optional: ISO8601 start date filter (inclusive)" },
        date_to:      { type: "string", description: "Optional: ISO8601 end date filter (inclusive)" },
      },
      required: ["project_path"],
    },
  },
];

// ─── Tool dispatcher ─────────────────────────────────────────────

type HandlerFn = (params: any) => Promise<unknown>;

const HANDLER_MAP: Record<string, HandlerFn> = {
  sdd_get_state: handleGetState,
  sdd_transition: handleTransition,
  sdd_get_contract: handleGetContract,
  sdd_evaluate_gate: handleEvaluateGate,
  sdd_classify_failure: handleClassifyFailure,
  sdd_delta_check: handleDeltaCheck,
  sdd_log_event: handleLogEvent,
  sdd_memory_read: handleMemoryRead,
  sdd_memory_write: handleMemoryWrite,
  sdd_tick_decay: handleTickDecay,
  sdd_append_signal: handleAppendSignal,
  sdd_update_task: handleUpdateTask,
  sdd_update_feature: handleUpdateFeature,
  // Observability Layer (Phase 1)
  sdd_emit_metrics:    handleEmitMetrics,
  sdd_get_run_summary: handleGetRunSummary,
  sdd_get_analytics:   handleGetAnalytics,
  // Metacognition Layer (Phase 2+)
  sdd_compute_score:        handleComputeScore,
  sdd_get_patterns:         handleGetPatterns,
  sdd_propose_pattern:      handleProposePattern,
  sdd_promote_pattern:      handlePromotePattern,
  sdd_tick_patterns:        handleTickPatterns,
  sdd_propose_experiment:   handleProposeExperiment,
  sdd_evaluate_experiment:  handleEvaluateExperiment,
  sdd_propose_evolution:    handleProposeEvolution,
};

// ─── Server setup ────────────────────────────────────────────────

const server = new Server(
  { name: "sdd-autopilot", version: "2.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = HANDLER_MAP[name];

  if (!handler) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: "${name}"` }) }],
      isError: true,
    };
  }

  try {
    const result = await handler(args ?? {});
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
      isError: true,
    };
  }
});

// ─── Start ───────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
