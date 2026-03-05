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
} from "./handlers.js";

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
