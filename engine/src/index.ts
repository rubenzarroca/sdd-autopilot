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
  handleTickMaintenance,
} from "./handlers.js";

import {
  handleEmitMetrics,
  handleGetRunSummary,
  handleGetAnalytics,
  handleCheckThresholds,
  handleEstimateCost,
  handleGetLiveStatus,
  handleCompareRuns,
  handleDetectAnomaly,
  handleValidateMetrics,
  handleGetManifest,
  handleBreadcrumb,
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
  handleApproveEvolution,
  handleAbandonExperiment,
  handleUpdatePattern,
  handleGetStrategy,
  handleRunRetro,
  handlePhaseConfidence,
  handleSetGolden,
} from "./metacognition.js";

import {
  handleProposeTool,
  handleReviewToolProposal,
  handleGenerateToolPrompt,
} from "./tool-factory.js";

// ─── Tool definitions (JSON Schema) ─────────────────────────────

export const TOOLS = [
  {
    name: "sdd_get_state",
    description:
      "Read feature state from .sdd/state.json. Returns a single feature if feature_id is specified, otherwise returns the full state.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path: { type: "string", description: "Absolute path to the project root" },
        feature_id: { type: "string", description: "Optional: specific feature to query" },
        include_run_log: { type: "boolean", description: "Optional: if true and feature_id is set, include live run status (from sdd_get_live_status)" },
      },
      required: ["project_path"],
    },
    outputSchema: {
      type: "object" as const,
      description: "Full StateJson when no feature_id, or single FeatureEntry with feature_id when specified",
      properties: {
        feature_id:     { type: "string", description: "Feature identifier (present when querying single feature)" },
        state:          { type: "string", description: "Current lifecycle state (present for single feature)" },
        version:        { type: "string", description: "State schema version (present in full state)" },
        project:        { type: "string", description: "Project name (present in full state)" },
        active_feature: { type: "string", description: "Currently active feature (present in full state)" },
        features:       { type: "object", description: "Map of feature_id to FeatureEntry (present in full state)", additionalProperties: true },
        error:          { type: "string", description: "Error message if state not found or feature missing" },
      },
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
    outputSchema: {
      type: "object" as const,
      description: "Transition result with success flag and either new_state or error details",
      properties: {
        success:   { type: "boolean", description: "Whether the transition succeeded" },
        new_state: { type: "string", description: "The new lifecycle state (on success)" },
        error: {
          type: "object",
          description: "Error details (on failure)",
          properties: {
            code:                 { type: "string", description: "Error code (UNAUTHORIZED, INVALID_TRANSITION, etc.)" },
            message:              { type: "string", description: "Human-readable error message" },
            allowed_transitions:  { type: "array", items: { type: "string" }, description: "Valid transitions from current state for this agent" },
          },
        },
      },
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
    outputSchema: {
      type: "object" as const,
      description: "StageContract for the requested phase, or error if phase not found",
      properties: {
        agent:         { type: "string", description: "Agent responsible for this phase" },
        model:         { type: "string", description: "Model to use (sonnet, opus, haiku)" },
        input:         { type: "object", description: "Required and optional inputs with max_tokens" },
        output:        { type: "object", description: "Expected artifacts and optional schema" },
        gate:          { type: "object", description: "Gate configuration (type, checks, pass_condition)" },
        execution:     { type: "string", description: "Execution mode (sequential, per_task, parallel_waves)" },
        fix_loop:      { type: "object", description: "Fix loop config (max_attempts, classify_failure, delta_check)" },
        pair_review:   { type: "object", description: "Pair review config (enabled, max_corrections)" },
        failure_modes: { type: "array", items: { type: "string" }, description: "Known failure modes" },
        next:          { type: "string", description: "Next phase in the pipeline (null if terminal)" },
        error:         { type: "string", description: "Error message if phase not found" },
      },
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
    outputSchema: {
      type: "object" as const,
      description: "Gate evaluation result with per-check details",
      properties: {
        passed: { type: "boolean", description: "Whether all mechanical checks passed and no semantic validation is needed" },
        checks: {
          type: "array",
          description: "Individual check results",
          items: {
            type: "object",
            properties: {
              name:   { type: "string", description: "Check description from contract" },
              passed: { type: "boolean", description: "Whether this check passed" },
              detail: { type: "string", description: "Explanation of result" },
            },
          },
        },
        needs_semantic_validation: {
          type: "object",
          description: "Present if a check requires LLM comprehension",
          properties: {
            check:       { type: "string" },
            description: { type: "string" },
          },
        },
        error: { type: "string", description: "Error if phase not found" },
      },
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
    outputSchema: {
      type: "object" as const,
      description: "Failure classification with category, confidence, and reasoning",
      properties: {
        category:   { type: "string", enum: ["implementation_bug", "spec_gap", "infra_issue"], description: "Classified failure category" },
        confidence: { type: "string", enum: ["high", "medium", "low"], description: "Confidence in the classification" },
        reasoning:  { type: "string", description: "Explanation of why this category was chosen" },
      },
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
    outputSchema: {
      type: "object" as const,
      description: "Delta check result: continue or abort",
      properties: {
        result:             { type: "string", enum: ["continue", "abort"], description: "Whether to continue or abort the fix loop" },
        previous_failures:  { type: "number", description: "Number of failures in the previous iteration (absent on first iteration)" },
        reason:             { type: "string", description: "Explanation of the decision" },
      },
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
    outputSchema: {
      type: "object" as const,
      description: "Confirmation that the event was logged",
      properties: {
        logged:    { type: "boolean", description: "Always true on success" },
        timestamp: { type: "string", description: "ISO8601 timestamp when the event was recorded" },
      },
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
    outputSchema: {
      type: "object" as const,
      description: "Memory section content",
      properties: {
        content: { type: "string", description: "The content of the requested section (JSON string for 'all')" },
        section: { type: "string", description: "The section that was read" },
        scope:   { type: "string", enum: ["project", "user"], description: "The memory scope" },
      },
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
        agent: { type: "string", description: "Agent name for provenance tracking" },
        run_id: { type: "string", description: "Run ID for provenance tracking" },
        feature_id: { type: "string", description: "Feature ID for provenance tracking and signal emission" },
        confidence: { type: "number", description: "Confidence level 0-1 (default 0.5)" },
      },
      required: ["project_path", "section", "content", "scope"],
    },
    outputSchema: {
      type: "object" as const,
      description: "Write confirmation",
      properties: {
        written:   { type: "boolean", description: "Whether the write succeeded" },
        timestamp: { type: "string", description: "ISO8601 timestamp of the write (on success)" },
        reason:    { type: "string", description: "Reason for failure (when written=false)" },
      },
    },
  },
  {
    name: "sdd_tick_decay",
    description:
      "@deprecated Use sdd_tick_maintenance with target='memory' instead. " +
      "Decrement TTL of learned patterns and exploration entries. Removes expired entries.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path: { type: "string", description: "Absolute path to the project root" },
      },
      required: ["project_path"],
    },
    outputSchema: {
      type: "object" as const,
      description: "Decay tick results",
      properties: {
        patterns_removed:     { type: "number", description: "Number of learned patterns that expired" },
        explorations_expired: { type: "number", description: "Number of exploration entries that expired" },
        total_removed:        { type: "number", description: "Total entries removed" },
      },
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
    outputSchema: {
      type: "object" as const,
      description: "Task update result",
      properties: {
        updated: { type: "boolean", description: "Whether the update succeeded" },
        task_id: { type: "string", description: "The task that was updated" },
        status:  { type: "string", description: "The new task status" },
        error:   { type: "string", description: "Error message if feature or task not found" },
      },
    },
  },
  {
    name: "sdd_update_feature",
    description:
      "Persist feature metadata fields (plan_path, tasks_path, worktree_path, branch, blocked_reason, " +
      "escalation_reason, awaiting_input_reason, pr_url, pr_number, skip_worktree). Use instead of writing state.json directly.",
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
            pr_url: { type: "string", description: "URL of the created pull request" },
            pr_number: { type: "number", description: "PR number for merge verification via GitHub API" },
            skip_worktree: { type: "boolean", description: "Set to true when --skip-worktree flag is used (bypasses worktree precondition gate)" },
          },
          additionalProperties: false,
        },
      },
      required: ["project_path", "feature_id", "updates"],
    },
    outputSchema: {
      type: "object" as const,
      description: "Feature update result",
      properties: {
        updated: { type: "boolean", description: "Whether the update succeeded" },
        fields:  { type: "array", items: { type: "string" }, description: "List of fields that were updated" },
        error:   { type: "string", description: "Error message if feature not found" },
      },
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
    outputSchema: {
      type: "object" as const,
      description: "Signal append confirmation",
      properties: {
        appended:  { type: "boolean", description: "Whether the signal was appended" },
        signal_id: { type: "string", description: "UUID of the appended signal" },
        in_state:  { type: "boolean", description: "Whether the signal was also written to state.json" },
      },
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
    outputSchema: {
      type: "object" as const,
      description: "CompositeScore with pipeline_score, quality/efficiency breakdown, and weights used",
      properties: {
        run_id:           { type: "string", description: "Run identifier" },
        feature_id:       { type: "string", description: "Feature identifier" },
        pipeline_score:   { type: "number", description: "Composite score 0-100 (1 decimal)" },
        quality_score:    { type: "number", description: "Quality dimension 0-100" },
        efficiency_score: { type: "number", description: "Efficiency dimension 0-100" },
        breakdown: {
          type: "object",
          description: "Individual sub-scores",
          properties: {
            review_result_score:   { type: "number" },
            first_pass_rate_score: { type: "number" },
            findings_score:        { type: "number" },
            verify_clean_score:    { type: "number" },
            fix_loops_score:       { type: "number" },
            phases_skipped_score:  { type: "number" },
            duration_trend_score:  { type: "number" },
          },
        },
        weights_used: { type: "object", description: "ScoreWeights that were applied", additionalProperties: true },
        error:        { type: "string", description: "Error if summary.json not found or run_id mismatch" },
      },
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
    outputSchema: {
      type: "object" as const,
      description: "Filtered list of ExploitationPatterns with Bayesian stats",
      properties: {
        patterns: { type: "array", description: "Matching ExploitationPattern objects (includes alpha, beta_param, posterior_variance)", items: { type: "object", additionalProperties: true } },
        count:    { type: "number", description: "Number of matching patterns" },
      },
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
        confidence:       { type: "number", description: "Ignored — new patterns always start at 0.5 (Beta(1,1) prior). Kept for backward compat." },
        supporting_runs:  { type: "number", description: "Number of runs supporting this pattern" },
        min_runs:         { type: "number", description: "Minimum supporting runs to promote (default 5)" },
        ttl:              { type: "number", description: "TTL in ticks before decay (default 20)" },
      },
      required: ["project_path", "pattern_id", "type", "condition", "action", "supporting_runs"],
    },
    outputSchema: {
      type: "object" as const,
      description: "Pattern proposal result",
      properties: {
        proposed:   { type: "boolean", description: "Whether the pattern was proposed" },
        pattern_id: { type: "string", description: "The pattern identifier" },
        status:     { type: "string", description: "Always 'candidate' for new proposals" },
        error:      { type: "string", description: "Error if pattern_id already exists" },
      },
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
    outputSchema: {
      type: "object" as const,
      description: "Pattern promotion result",
      properties: {
        promoted:   { type: "boolean", description: "Whether the pattern was promoted" },
        pattern_id: { type: "string", description: "The pattern identifier" },
        status:     { type: "string", description: "New status (active) or current status" },
        reason:     { type: "string", description: "Reason for rejection (insufficient runs/confidence, already active, decayed)" },
        bayesian_stats: {
          type: "object", description: "Bayesian Beta distribution stats",
          properties: {
            alpha:              { type: "number" },
            beta_param:         { type: "number" },
            posterior_mean:     { type: "number" },
            posterior_variance: { type: "number" },
          },
        },
        error:      { type: "string", description: "Error if pattern not found" },
      },
    },
  },
  {
    name: "sdd_tick_patterns",
    description:
      "@deprecated Use sdd_tick_maintenance with target='patterns' instead. " +
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
    outputSchema: {
      type: "object" as const,
      description: "Pattern tick result with adaptive decay details",
      properties: {
        ticked:  { type: "boolean", description: "Always true on success" },
        decayed: { type: "number", description: "Number of patterns that decayed (remaining_ttl < 1.0)" },
        details: {
          type: "array", description: "Per-pattern adaptive decay details",
          items: {
            type: "object",
            properties: {
              pattern_id:              { type: "string" },
              decay_rate:              { type: "number", description: "Lambda: ticks_since_confirmation / total_ticks_alive" },
              remaining_ttl:           { type: "number", description: "Computed remaining TTL via exponential decay" },
              ticks_since_confirmation: { type: "number" },
              status:                  { type: "string" },
            },
          },
        },
      },
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
    outputSchema: {
      type: "object" as const,
      description: "Evolution proposal result",
      properties: {
        proposed:       { type: "boolean", description: "Whether the evolution was proposed" },
        evolution_id:   { type: "string", description: "The evolution identifier" },
        requires_human: { type: "boolean", description: "Whether human approval is required" },
        status:         { type: "string", description: "Always 'proposed' for new proposals" },
        error:          { type: "string", description: "Error if evolution_id already exists" },
      },
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
    outputSchema: {
      type: "object" as const,
      description: "Experiment proposal result",
      properties: {
        proposed:      { type: "boolean", description: "Whether the experiment was proposed" },
        experiment_id: { type: "string", description: "The experiment identifier" },
        status:        { type: "string", description: "Always 'proposed' for new experiments" },
        error:         { type: "string", description: "Error if another experiment is active or id already exists" },
      },
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
    outputSchema: {
      type: "object" as const,
      description: "Experiment evaluation result with verdict",
      properties: {
        evaluated:      { type: "boolean", description: "Whether evaluation succeeded" },
        experiment_id:  { type: "string", description: "The experiment identifier" },
        verdict:        { type: "string", enum: ["promote", "discard", "retry"], description: "Evaluation verdict" },
        status:         { type: "string", description: "New experiment status (completed or proposed for retry)" },
        result_score:   { type: "number", description: "The experimental run score" },
        baseline_score: { type: "number", description: "The baseline comparison score" },
        retry_count:    { type: "number", description: "Number of retries so far" },
        error:          { type: "string", description: "Error if experiment not found or already completed" },
      },
    },
  },

  {
    name: "sdd_approve_evolution",
    description:
      "Approve or reject a proposed PipelineEvolution. " +
      "If approved and type=weight_adjust with low impact: auto-applies to score_weights.json. " +
      "Structural changes (phase_add, phase_remove, agent_redesign, contract_change) go to approved_pending for manual application. " +
      "Rejected evolutions are marked as rejected with reason.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path:  { type: "string", description: "Absolute path to the project root" },
        evolution_id:  { type: "string", description: "Evolution identifier" },
        decision:      { type: "string", enum: ["approve", "reject"], description: "Approve or reject" },
        reason:        { type: "string", description: "Optional reason for the decision" },
      },
      required: ["project_path", "evolution_id", "decision"],
    },
    outputSchema: {
      type: "object" as const,
      description: "Evolution approval/rejection result",
      properties: {
        evolution_id:    { type: "string", description: "The evolution identifier" },
        status:          { type: "string", description: "New status: approved, approved_pending, or rejected" },
        auto_applied:    { type: "boolean", description: "Whether weight changes were auto-applied (weight_adjust only)" },
        weights_updated: { type: "array", items: { type: "string" }, description: "Weight keys that were updated (if auto-applied)" },
        message:         { type: "string", description: "Additional context (e.g. requires manual application)" },
        reason:          { type: "string", description: "Rejection reason (if rejected)" },
        error:           { type: "string", description: "Error if evolution not found or wrong status" },
      },
    },
  },
  {
    name: "sdd_abandon_experiment",
    description:
      "Cancel an experiment in status proposed or running without evaluating it. " +
      "Marks it as abandoned with a reason. Frees the experiment slot for a new proposal.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path:   { type: "string", description: "Absolute path to the project root" },
        experiment_id:  { type: "string", description: "Experiment identifier" },
        reason:         { type: "string", description: "Why the experiment is being abandoned" },
      },
      required: ["project_path", "experiment_id", "reason"],
    },
    outputSchema: {
      type: "object" as const,
      description: "Experiment abandonment result",
      properties: {
        abandoned:     { type: "boolean", description: "Whether the experiment was abandoned" },
        experiment_id: { type: "string", description: "The experiment identifier" },
        reason:        { type: "string", description: "The abandonment reason" },
        error:         { type: "string", description: "Error if experiment not found or wrong status" },
      },
    },
  },
  {
    name: "sdd_update_pattern",
    description:
      "Increment supporting_runs and optionally update confidence of an ExploitationPattern. " +
      "Use after a run confirms a candidate pattern. Cannot update decayed patterns.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path: { type: "string", description: "Absolute path to the project root" },
        pattern_id:   { type: "string", description: "Pattern identifier" },
        increment:    { type: "number", description: "How much to increment supporting_runs (default: 1)" },
        confidence:   { type: "number", description: "Optional: explicit confidence override (0.0-1.0). Ignored when outcome is provided." },
        outcome:      { type: "string", enum: ["success", "failure"], description: "Outcome of the run for this pattern (default: success). Drives Bayesian alpha/beta update." },
      },
      required: ["project_path", "pattern_id"],
    },
    outputSchema: {
      type: "object" as const,
      description: "Pattern update result",
      properties: {
        updated:         { type: "boolean", description: "Whether the update succeeded" },
        pattern_id:      { type: "string", description: "The pattern identifier" },
        supporting_runs: { type: "number", description: "New supporting_runs count" },
        confidence:      { type: "number", description: "Current confidence (Bayesian posterior mean)" },
        alpha:           { type: "number", description: "Bayesian alpha (successes + 1)" },
        beta_param:      { type: "number", description: "Bayesian beta (failures + 1)" },
        status:          { type: "string", description: "Current pattern status" },
        error:           { type: "string", description: "Error if pattern not found, decayed, or invalid confidence" },
      },
    },
  },
  {
    name: "sdd_get_strategy",
    description:
      "Read active patterns, running experiments, and current score weights for a feature context. " +
      "Returns a strategy object with applicable_patterns, active_experiments, current_weights, and recommendations. " +
      "Call at pipeline start so the orchestrator can decide which phases to skip or modify.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path: { type: "string", description: "Absolute path to the project root" },
        feature_type: { type: "string", description: "Feature type (e.g. 'api', 'ui', 'refactor')" },
        complexity:   { type: "string", description: "Feature complexity: low, medium, high, critical" },
      },
      required: ["project_path", "feature_type", "complexity"],
    },
    outputSchema: {
      type: "object" as const,
      description: "Pipeline strategy for the given feature context",
      properties: {
        feature_type:        { type: "string", description: "The queried feature type" },
        complexity:          { type: "string", description: "The queried complexity" },
        applicable_patterns: { type: "array", description: "Active patterns matching this context", items: { type: "object", additionalProperties: true } },
        active_experiments:  { type: "array", description: "Experiments in proposed/running status", items: { type: "object", additionalProperties: true } },
        current_weights:     { type: "object", description: "Current ScoreWeights (null if not customized)", additionalProperties: true },
        recommendations:     { type: "array", items: { type: "string" }, description: "Actionable recommendations for the orchestrator" },
        exploration_decision: {
          type: "object", description: "Thompson Sampling exploit/explore decision",
          properties: {
            exploit_score:    { type: "number", description: "Average Thompson sample across active patterns" },
            explore_score:    { type: "number", description: "Thompson sample for proposed experiment (uniform prior)" },
            decision:         { type: "string", enum: ["exploit", "explore"], description: "Whether to exploit known patterns or explore a new experiment" },
            method:           { type: "string", description: "Always 'thompson_sampling'" },
            pattern_samples:  { type: "array", items: { type: "object", properties: { pattern_id: { type: "string" }, sample: { type: "number" } } }, description: "Per-pattern Thompson samples" },
          },
        },
      },
    },
  },
  {
    name: "sdd_run_retro",
    description:
      "Generate a structured retro report for a completed feature run. " +
      "Compares expected vs actual outcome, identifies bottleneck phases, " +
      "checks which active patterns were confirmed or contradicted, and produces actionable suggestions. " +
      "Persists retro.json in .sdd/runs/{feature_id}/.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path:     { type: "string", description: "Absolute path to the project root" },
        feature_id:       { type: "string", description: "Feature identifier" },
        expected_outcome: { type: "string", description: "Optional: what was expected ('clean_pass', 'minor_fixes', etc.)" },
      },
      required: ["project_path", "feature_id"],
    },
    outputSchema: {
      type: "object" as const,
      description: "Structured retro report",
      properties: {
        feature_id:        { type: "string", description: "Feature identifier" },
        run_id:            { type: "string", description: "Run identifier" },
        outcome:           { type: "string", description: "Run outcome (pr_created, escalated, aborted)" },
        expected_vs_actual: {
          type: "object",
          description: "Expected vs actual outcome comparison (null if no expected_outcome given)",
          properties: {
            expected: { type: "string" },
            actual:   { type: "string" },
            match:    { type: "boolean" },
          },
        },
        pipeline_score:    { type: "number", description: "Composite pipeline score (null if not computed)" },
        total_duration_ms: { type: "number", description: "Total run duration in milliseconds" },
        total_fix_loops:   { type: "number", description: "Total fix loops across all phases" },
        first_pass_rate:   { type: "number", description: "First-pass rate percentage (0-100)" },
        phase_breakdown:   { type: "array", description: "Per-phase breakdown", items: { type: "object", additionalProperties: true } },
        bottlenecks:       { type: "array", description: "Phases identified as bottlenecks", items: { type: "object", additionalProperties: true } },
        patterns_confirmed:    { type: "array", items: { type: "string" }, description: "Active patterns confirmed by this run" },
        patterns_contradicted: { type: "array", items: { type: "string" }, description: "Active patterns contradicted by this run" },
        suggestions:       { type: "array", items: { type: "string" }, description: "Actionable suggestions" },
        generated_at:      { type: "string", description: "ISO8601 timestamp when retro was generated" },
        error:             { type: "string", description: "Error if summary.json not found" },
      },
    },
  },
  {
    name: "sdd_phase_confidence",
    description:
      "Assign a confidence score (0.0-1.0) to the output of a specific pipeline phase. " +
      "Persists to .sdd/runs/{feature_id}/phase_confidence.json. " +
      "Upserts: calling again for the same feature+phase replaces the previous entry.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path: { type: "string", description: "Absolute path to the project root" },
        feature_id:   { type: "string", description: "Feature identifier" },
        phase:        { type: "string", description: "Phase name (e.g. 'specify', 'plan', 'verify')" },
        confidence:   { type: "number", description: "Confidence score between 0.0 and 1.0" },
        reasoning:    { type: "string", description: "Why this confidence level" },
        factors:      { type: "object", description: "Optional: influencing factors (e.g. {spec_clarity: 0.8, test_coverage: 0.6})", additionalProperties: { type: "number" } },
      },
      required: ["project_path", "feature_id", "phase", "confidence", "reasoning"],
    },
    outputSchema: {
      type: "object" as const,
      description: "Phase confidence persistence result",
      properties: {
        persisted:  { type: "boolean", description: "Whether the entry was persisted" },
        feature_id: { type: "string", description: "Feature identifier" },
        phase:      { type: "string", description: "Phase name" },
        confidence: { type: "number", description: "The assigned confidence score" },
        reasoning:  { type: "string", description: "The reasoning provided" },
        factors:    { type: "object", description: "Influencing factors (null if not provided)", additionalProperties: { type: "number" } },
        updated_at: { type: "string", description: "ISO8601 timestamp" },
        error:      { type: "string", description: "Error if confidence out of range" },
      },
    },
  },
  {
    name: "sdd_set_golden",
    description:
      "Set the golden run benchmark from a completed feature's summary. " +
      "Copies summary.json to .sdd/analytics/golden.json. " +
      "sdd_compute_score will compare future runs against this golden baseline.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path: { type: "string", description: "Absolute path to the project root" },
        feature_id: { type: "string", description: "Optional: feature to use as golden. Defaults to last completed run." },
      },
      required: ["project_path"],
    },
    outputSchema: {
      type: "object" as const,
      description: "Golden run benchmark result",
      properties: {
        set:            { type: "boolean", description: "Whether the golden benchmark was set" },
        golden_run_id:  { type: "string", description: "The run_id of the golden benchmark" },
        golden_score:   { type: "number", description: "The pipeline_score of the golden run" },
        golden_path:    { type: "string", description: "Path to the golden.json file" },
        error:          { type: "string", description: "Error if summary not found" },
      },
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
    outputSchema: {
      type: "object" as const,
      description: "Metrics emission confirmation",
      properties: {
        emitted: { type: "boolean", description: "Always true on success" },
        run_id:  { type: "string", description: "The run_id from the emitted metrics" },
        phase:   { type: "string", description: "The phase from the emitted metrics" },
      },
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
    outputSchema: {
      type: "object" as const,
      description: "RunSummary (fresh computation) or {summaries, runs_analyzed} (historical query)",
      properties: {
        run_id:            { type: "string", description: "Run identifier (fresh mode)" },
        feature_id:        { type: "string", description: "Feature identifier" },
        feature_type:      { type: "string", description: "Feature type" },
        complexity:        { type: "string", description: "Feature complexity" },
        outcome:           { type: "string", description: "Run outcome: pr_created, escalated, aborted" },
        total_duration_ms: { type: "number", description: "Total duration in milliseconds" },
        total_tokens:      { type: "number", description: "Total tokens consumed (null if not available)" },
        phases_executed:   { type: "array", items: { type: "string" }, description: "Phases that were executed" },
        phases_skipped:    { type: "array", items: { type: "string" }, description: "Phases that were skipped" },
        total_fix_loops:   { type: "number", description: "Total fix loops across all phases" },
        first_pass_rate:   { type: "number", description: "First-pass rate percentage (0-100)" },
        pipeline_score:    { type: "number", description: "Composite score (null until computed)" },
        avg_confidence:    { type: "number", description: "Average phase confidence 0-1 (null if no confidence data)" },
        phase_metrics:     { type: "array", description: "Per-phase PhaseMetrics", items: { type: "object", additionalProperties: true } },
        summaries:         { type: "array", description: "Historical summaries (last_n_runs mode)", items: { type: "object", additionalProperties: true } },
        runs_analyzed:     { type: "number", description: "Count of returned summaries (last_n_runs mode)" },
        error:             { type: "string", description: "Error if no metrics found" },
      },
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
        ema_alpha:    { type: "number", description: "Optional: EMA smoothing factor (0-1). Default 0.3. Higher = more reactive, lower = smoother." },
      },
      required: ["project_path"],
    },
    outputSchema: {
      type: "object" as const,
      description: "Cross-run analytics results",
      properties: {
        filter:                         { type: "object", description: "Applied filters", additionalProperties: true },
        runs_analyzed:                  { type: "number", description: "Number of runs included in analysis" },
        avg_duration_by_phase:          { type: "object", description: "Average duration per phase in ms", additionalProperties: { type: "number" } },
        avg_fix_loops_by_feature_type:  { type: "object", description: "Average fix loops per feature type", additionalProperties: { type: "number" } },
        first_pass_rate_history:        { type: "number", description: "Overall average first-pass rate" },
        high_variance_phases:           { type: "array", items: { type: "string" }, description: "Phases with high duration variance" },
        trends: {
          type: "object",
          description: "EMA-based trend analysis per metric (null if < 4 runs). Each metric has current_ema, derivative, direction, and raw_ema array.",
          properties: {
            pipeline_score:    { type: "object", description: "EMA trend for pipeline_score (null if insufficient data)", additionalProperties: true },
            first_pass_rate:   { type: "object", description: "EMA trend for first_pass_rate", additionalProperties: true },
            total_duration_ms: { type: "object", description: "EMA trend for total_duration_ms", additionalProperties: true },
            avg_confidence:    { type: "object", description: "EMA trend for avg_confidence (null if no data)", additionalProperties: true },
          },
        },
      },
    },
  },
  {
    name: "sdd_check_thresholds",
    description:
      "@deprecated Threshold alerts are now included in sdd_get_run_summary response. " +
      "Detect when metrics cross thresholds and emit warnings/criticals. " +
      "Checks per-phase fix_loops and duration ratio vs historical average, " +
      "plus run-level first_pass_rate and total_duration. " +
      "Critical if value is 2x the threshold, warning if just crossed. " +
      "Uses >= 3 historical runs for ratio checks; absolute thresholds always apply.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path: { type: "string", description: "Absolute path to the project root" },
        feature_id:   { type: "string", description: "Feature identifier" },
        thresholds: {
          type: "object",
          description: "Optional: override default thresholds",
          properties: {
            max_fix_loops_per_phase:    { type: "number", description: "Default: 3" },
            max_duration_ratio:         { type: "number", description: "Ratio vs historical avg. Default: 2.0" },
            min_first_pass_rate:        { type: "number", description: "Minimum %. Default: 50" },
            max_total_duration_minutes: { type: "number", description: "Default: 60" },
          },
        },
      },
      required: ["project_path", "feature_id"],
    },
    outputSchema: {
      type: "object" as const,
      description: "Threshold check results with alerts",
      properties: {
        alerts: {
          type: "array",
          description: "Threshold violations",
          items: {
            type: "object",
            properties: {
              level:         { type: "string", enum: ["warning", "critical"] },
              metric:        { type: "string", description: "Metric name that crossed threshold" },
              phase:         { type: "string", description: "Phase name (for per-phase checks)" },
              current_value: { type: "number", description: "Current metric value" },
              threshold:     { type: "number", description: "Threshold that was crossed" },
              message:       { type: "string", description: "Human-readable alert message" },
            },
          },
        },
        checked_at: { type: "string", description: "ISO8601 timestamp of the check" },
        error:      { type: "string", description: "Error if no metrics found" },
      },
    },
  },
  {
    name: "sdd_estimate_cost",
    description:
      "Estimate cost in USD from tokens consumed in a pipeline run. " +
      "Reads metrics.jsonl for the feature (or last run from history if no feature_id). " +
      "Applies model-specific pricing (opus/sonnet/haiku). " +
      "Returns total_cost_usd, per-phase breakdown, and model breakdown.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path: { type: "string", description: "Absolute path to the project root" },
        feature_id:   { type: "string", description: "Optional: feature to estimate cost for. Default: last run from history" },
        pricing: {
          type: "object",
          description: "Optional: override default pricing ($ per 1M tokens)",
          additionalProperties: {
            type: "object",
            properties: {
              input:  { type: "number" },
              output: { type: "number" },
            },
          },
        },
      },
      required: ["project_path"],
    },
    outputSchema: {
      type: "object" as const,
      description: "Cost estimation breakdown",
      properties: {
        total_cost_usd: { type: "number", description: "Total estimated cost in USD" },
        phases: {
          type: "array",
          description: "Per-phase cost breakdown",
          items: {
            type: "object",
            properties: {
              phase:      { type: "string" },
              model:      { type: "string" },
              tokens_in:  { type: "number" },
              tokens_out: { type: "number" },
              cost_usd:   { type: "number" },
            },
          },
        },
        model_breakdown: { type: "object", description: "Cost per model", additionalProperties: { type: "number" } },
        error:           { type: "string", description: "Error if no metrics or history found" },
      },
    },
  },
  {
    name: "sdd_get_live_status",
    description:
      "@deprecated Use sdd_get_state with include_run_log=true instead. " +
      "Query what phase is currently executing for a feature. " +
      "Reads run.log for phase_start/phase_end events and metrics.jsonl for completed phases. " +
      "Returns status (running/idle), current_phase, elapsed_seconds, and last_completed_phase.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path: { type: "string", description: "Absolute path to the project root" },
        feature_id:   { type: "string", description: "Feature identifier" },
      },
      required: ["project_path", "feature_id"],
    },
    outputSchema: {
      type: "object" as const,
      description: "Live execution status for the feature",
      properties: {
        status:               { type: "string", enum: ["running", "idle"], description: "Whether a phase is currently executing" },
        feature_state:        { type: "string", description: "Current feature lifecycle state" },
        current_phase:        { type: "string", description: "Phase currently executing (null if idle)" },
        started_at:           { type: "string", description: "ISO8601 timestamp when current phase started" },
        elapsed_seconds:      { type: "number", description: "Seconds elapsed since phase started" },
        last_completed_phase: { type: "string", description: "Most recently completed phase (null if none)" },
        last_completed_at:    { type: "string", description: "ISO8601 timestamp of last completion" },
        error:                { type: "string", description: "Error if feature not found" },
      },
    },
  },
  {
    name: "sdd_compare_runs",
    description:
      "Compare two pipeline runs side by side. " +
      "Diffs duration, fix_loops, first_pass_rate, pipeline_score, and total_tokens. " +
      "Also diffs per-phase duration and fix_loops for phases present in both runs. " +
      "Determines the better run by pipeline_score.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path: { type: "string", description: "Absolute path to the project root" },
        run_id_a:     { type: "string", description: "First run ID (or feature_id)" },
        run_id_b:     { type: "string", description: "Second run ID (or feature_id)" },
      },
      required: ["project_path", "run_id_a", "run_id_b"],
    },
    outputSchema: {
      type: "object" as const,
      description: "Side-by-side run comparison",
      properties: {
        run_a: {
          type: "object",
          description: "Summary of run A",
          properties: {
            id:             { type: "string" },
            feature_id:     { type: "string" },
            outcome:        { type: "string" },
            pipeline_score: { type: "number" },
          },
        },
        run_b: {
          type: "object",
          description: "Summary of run B",
          properties: {
            id:             { type: "string" },
            feature_id:     { type: "string" },
            outcome:        { type: "string" },
            pipeline_score: { type: "number" },
          },
        },
        diffs: { type: "object", description: "Per-metric diffs with a, b, diff, diff_pct", additionalProperties: true },
        phase_diffs: {
          type: "array",
          description: "Per-phase metric diffs",
          items: {
            type: "object",
            properties: {
              phase:  { type: "string" },
              metric: { type: "string" },
              a:      { type: "number" },
              b:      { type: "number" },
              diff:   { type: "number" },
            },
          },
        },
        better_run: { type: "string", description: "Run ID of the better run (or 'tied')" },
        error:      { type: "string", description: "Error if a run is not found" },
      },
    },
  },
  {
    name: "sdd_detect_anomaly",
    description:
      "Detect if a run is anomalous compared to the historical distribution. " +
      "Computes z-scores for total_duration, total_fix_loops, first_pass_rate, and pipeline_score. " +
      "Marks as anomaly if |z-score| > sensitivity (default 2.0). " +
      "Requires >= 5 historical runs for statistical analysis.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path: { type: "string", description: "Absolute path to the project root" },
        feature_id:   { type: "string", description: "Feature identifier to check" },
        sensitivity:  { type: "number", description: "Number of standard deviations for anomaly detection (default: 2.0)" },
      },
      required: ["project_path", "feature_id"],
    },
    outputSchema: {
      type: "object" as const,
      description: "Anomaly detection result",
      properties: {
        is_anomaly:  { type: "boolean", description: "Whether any metric is anomalous" },
        status:      { type: "string", enum: ["analyzed", "insufficient_data"], description: "Analysis status" },
        sensitivity: { type: "number", description: "The sensitivity threshold used" },
        anomalies: {
          type: "array",
          description: "Metrics flagged as anomalous",
          items: {
            type: "object",
            properties: {
              metric:  { type: "string" },
              value:   { type: "number" },
              mean:    { type: "number" },
              stddev:  { type: "number" },
              z_score: { type: "number" },
            },
          },
        },
        run_percentile: { type: "number", description: "Percentile rank vs historical runs (0-100)" },
        message:        { type: "string", description: "Status message (for insufficient_data)" },
        error:          { type: "string", description: "Error if summary.json not found" },
      },
    },
  },
  {
    name: "sdd_validate_metrics",
    description:
      "@deprecated Validation is now built into sdd_emit_metrics (returns validation_errors on failure). " +
      "Validate a PhaseMetrics object before persisting with sdd_emit_metrics. " +
      "Checks required fields (run_id, feature_id, phase, agent, model, timestamps, duration, gate_result, gate_attempts, findings_count, fix_loop_count), " +
      "validates types, ISO timestamps, non-negative numbers, gate_result enum, and warns about unknown fields.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path: { type: "string", description: "Absolute path to the project root" },
        metrics: {
          type: "object",
          description: "The PhaseMetrics object to validate",
          additionalProperties: true,
        },
      },
      required: ["project_path", "metrics"],
    },
    outputSchema: {
      type: "object" as const,
      description: "Validation result with errors and warnings",
      properties: {
        valid: { type: "boolean", description: "Whether the metrics object passed all required validations" },
        errors: {
          type: "array",
          description: "Validation errors (missing/invalid fields)",
          items: {
            type: "object",
            properties: {
              field:   { type: "string", description: "Field name" },
              message: { type: "string", description: "Error description" },
            },
          },
        },
        warnings: {
          type: "array",
          description: "Non-blocking warnings (unknown fields)",
          items: {
            type: "object",
            properties: {
              field:   { type: "string", description: "Field name" },
              message: { type: "string", description: "Warning description" },
            },
          },
        },
      },
    },
  },

  // ─── GAP-05: Tool Definition Versioning ─────────────────────────────
  {
    name: "sdd_get_manifest",
    description: "Get the tools manifest: SHA-256 hash of all tool definitions, tool count, and server version. Use to detect tool definition drift between environments.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path: { type: "string", description: "Not used — manifest is server-side. Included for consistency." },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        tools_hash: { type: "string", description: "SHA-256 hash of the serialized TOOLS array" },
        tools_count: { type: "number", description: "Number of registered tools" },
        version: { type: "string", description: "Server version from package.json" },
        computed_at: { type: "string", description: "ISO timestamp when manifest was last computed" },
      },
      description: "Tools manifest with hash, count, version, and computation timestamp",
    },
  },

  // ─── GAP-07: Subagent Breadcrumbs ───────────────────────────────────
  {
    name: "sdd_breadcrumb",
    description: "@deprecated Use sdd_log_event with event_type='decision' and data={decision, reasoning, alternatives_considered} instead. " +
      "Record a subagent decision breadcrumb. Appends to .sdd/analytics/breadcrumbs.jsonl. Use when a subagent makes an architectural decision or chooses between alternatives.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path: { type: "string", description: "Absolute path to the project root" },
        feature_id: { type: "string", description: "Feature identifier" },
        phase: { type: "string", description: "Pipeline phase where decision was made" },
        agent: { type: "string", description: "Agent that made the decision" },
        decision: { type: "string", description: "What was decided" },
        reasoning: { type: "string", description: "Why this decision was made" },
        alternatives_considered: {
          type: "array",
          items: { type: "string" },
          description: "Other options that were considered",
        },
      },
      required: ["project_path", "feature_id", "phase", "agent", "decision", "reasoning"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        recorded: { type: "boolean", description: "Whether the breadcrumb was recorded" },
        breadcrumb: { type: "object", description: "The persisted breadcrumb object" },
      },
      description: "Confirmation with the recorded breadcrumb",
    },
  },

  // ─── Fusion: sdd_tick_maintenance ──────────────────────────────────
  {
    name: "sdd_tick_maintenance",
    description:
      "Unified maintenance tick: decays memory TTLs (learned patterns + explorations) AND metacognition pattern TTLs in one call. " +
      "Replaces calling sdd_tick_decay + sdd_tick_patterns separately. " +
      "Use target='all' (default) for both, 'patterns' for metacognition only, 'memory' for memory decay only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path: { type: "string", description: "Absolute path to the project root" },
        target: {
          type: "string",
          enum: ["all", "patterns", "memory"],
          description: "What to tick: 'all' (default), 'patterns' (metacognition only), 'memory' (learned patterns + explorations only)",
        },
      },
      required: ["project_path"],
    },
    outputSchema: {
      type: "object" as const,
      description: "Combined maintenance tick results",
      properties: {
        patterns: { type: "object", description: "Result from sdd_tick_patterns (null if target=memory)", additionalProperties: true },
        memory:   { type: "object", description: "Result from sdd_tick_decay (null if target=patterns)", additionalProperties: true },
        target:   { type: "string", description: "The target that was ticked" },
      },
    },
  },

  // ─── Tool Factory (Self-Evolution) ────────────────────────────────
  {
    name: "sdd_propose_tool",
    description:
      "Propose a new tool when the orchestrator detects a capability gap during pipeline execution",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path:           { type: "string", description: "Absolute path to the project root" },
        name:                   { type: "string", description: "Tool name (must match /^sdd_[a-z_]+$/)" },
        description:            { type: "string", description: "What the tool does" },
        rationale:              { type: "string", description: "Why this tool is needed" },
        proposed_input_schema:  { type: "object", description: "JSON Schema for the tool input" },
        proposed_output_schema: { type: "object", description: "JSON Schema for the tool output" },
        proposed_handler_logic: { type: "string", description: "Pseudocode or description of handler logic" },
        target_file:            { type: "string", description: "File where the handler should be implemented" },
        pipeline_phase:         { type: "string", description: "Pipeline phase where this tool is used" },
        trigger_context:        { type: "string", description: "What triggered the need for this tool" },
      },
      required: ["project_path", "name", "description", "rationale", "proposed_input_schema", "proposed_output_schema", "proposed_handler_logic", "target_file", "pipeline_phase", "trigger_context"],
    },
    outputSchema: {
      type: "object" as const,
      description: "Proposal creation result",
      properties: {
        success:       { type: "boolean", description: "Whether the proposal was created" },
        proposal_path: { type: "string", description: "Path to the proposal JSON file" },
        status:        { type: "string", description: "Proposal status (proposed)" },
        error:         { type: "string", description: "Error message if creation failed" },
      },
    },
  },
  {
    name: "sdd_review_tool_proposal",
    description:
      "Review a tool proposal against existing tools to detect overlap and validate uniqueness",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path:        { type: "string", description: "Absolute path to the project root" },
        proposal_name:       { type: "string", description: "Name of the proposal to review (without sdd_ prefix or file extension)" },
        reviewer_assessment: { type: "string", description: "Optional reviewer notes" },
      },
      required: ["project_path", "proposal_name"],
    },
    outputSchema: {
      type: "object" as const,
      description: "Review result with overlap analysis",
      properties: {
        status:           { type: "string", description: "validated or rejected" },
        reason:           { type: "string", description: "Rejection reason if rejected" },
        overlapping_tools: { type: "array", items: { type: "string" }, description: "Tools that overlap" },
        overlap_scores:   { type: "array", description: "Overlap scores per tool", items: { type: "object", additionalProperties: true } },
        error:            { type: "string", description: "Error message if review failed" },
      },
    },
  },
  {
    name: "sdd_generate_tool_prompt",
    description:
      "Generate a ready-to-use Claude Code prompt from a validated tool proposal",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_path:  { type: "string", description: "Absolute path to the project root" },
        proposal_name: { type: "string", description: "Name of the validated proposal" },
      },
      required: ["project_path", "proposal_name"],
    },
    outputSchema: {
      type: "object" as const,
      description: "Prompt generation result",
      properties: {
        success:     { type: "boolean", description: "Whether the prompt was generated" },
        prompt_path: { type: "string", description: "Path to the generated prompt markdown file" },
        error:       { type: "string", description: "Error message if generation failed" },
      },
    },
  },
];

// ─── Tool dispatcher ─────────────────────────────────────────────

type HandlerFn = (params: any) => Promise<unknown>;

export const HANDLER_MAP: Record<string, HandlerFn> = {
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
  sdd_get_analytics:       handleGetAnalytics,
  sdd_check_thresholds:    handleCheckThresholds,
  sdd_estimate_cost:       handleEstimateCost,
  sdd_get_live_status:     handleGetLiveStatus,
  sdd_compare_runs:        handleCompareRuns,
  sdd_detect_anomaly:      handleDetectAnomaly,
  sdd_validate_metrics:    handleValidateMetrics,
  sdd_get_manifest:        handleGetManifest,
  sdd_breadcrumb:          handleBreadcrumb,
  // Metacognition Layer (Phase 2+)
  sdd_compute_score:        handleComputeScore,
  sdd_get_patterns:         handleGetPatterns,
  sdd_propose_pattern:      handleProposePattern,
  sdd_promote_pattern:      handlePromotePattern,
  sdd_tick_patterns:        handleTickPatterns,
  sdd_propose_experiment:   handleProposeExperiment,
  sdd_evaluate_experiment:  handleEvaluateExperiment,
  sdd_propose_evolution:    handleProposeEvolution,
  sdd_approve_evolution:    handleApproveEvolution,
  sdd_abandon_experiment:   handleAbandonExperiment,
  sdd_update_pattern:       handleUpdatePattern,
  sdd_get_strategy:         handleGetStrategy,
  sdd_run_retro:            handleRunRetro,
  sdd_phase_confidence:     handlePhaseConfidence,
  sdd_set_golden:           handleSetGolden,
  // Fusion tools
  sdd_tick_maintenance:        handleTickMaintenance,
  // Tool Factory (Self-Evolution)
  sdd_propose_tool:          handleProposeTool,
  sdd_review_tool_proposal:  handleReviewToolProposal,
  sdd_generate_tool_prompt:  handleGenerateToolPrompt,
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

if (!process.env.SDD_SKIP_MAIN) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
