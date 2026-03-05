// PTC Tool definitions — allowed_callers enables Programmatic Tool Calling
// These tools are given to Claude so it can interact with the filesystem,
// shell, and state during each phase.

import type Anthropic from "@anthropic-ai/sdk";

export const CODE_EXECUTION_TOOL = {
  type: "code_execution_20260120",
} as unknown as Anthropic.Messages.Tool;

export const TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: "read_file",
    description: "Read a file from the project. Returns the file content as a string.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Absolute or project-relative path to the file",
        },
      },
      required: ["path"],
    },
    allowed_callers: ["code_execution_20260120"],
  } as any,
  {
    name: "write_file",
    description: "Write or create a file in the project. Creates parent directories if needed.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Absolute or project-relative path to the file",
        },
        content: {
          type: "string",
          description: "The full content to write to the file",
        },
      },
      required: ["path", "content"],
    },
    allowed_callers: ["code_execution_20260120"],
  } as any,
  {
    name: "edit_file",
    description:
      "Edit a section of a file by replacing old_string with new_string. " +
      "The old_string must be unique in the file.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Path to the file to edit",
        },
        old_string: {
          type: "string",
          description: "The exact text to find and replace",
        },
        new_string: {
          type: "string",
          description: "The replacement text",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
    allowed_callers: ["code_execution_20260120"],
  } as any,
  {
    name: "list_dir",
    description: "List directory contents. Returns file and subdirectory names.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Path to the directory to list",
        },
        recursive: {
          type: "boolean",
          description: "If true, list recursively (default: false)",
        },
      },
      required: ["path"],
    },
    allowed_callers: ["code_execution_20260120"],
  } as any,
  {
    name: "read_state",
    description: "Read the .sdd/state.json file. Returns the parsed state object.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
    allowed_callers: ["code_execution_20260120"],
  } as any,
  {
    name: "transition_state",
    description:
      "Transition the active feature to a new lifecycle state. " +
      "Only transitions authorized for your agent_id are permitted — unauthorized attempts return {ok:false,code:'UNAUTHORIZED'}. " +
      "Error codes are control signals: UNAUTHORIZED|INVALID_TRANSITION|PRECONDITION_FAILED|FEATURE_NOT_FOUND|ESCALATE|SPEC_GAP|TASK_BLOCKED|DEPENDENCY_MISSING.",
    input_schema: {
      type: "object" as const,
      properties: {
        feature_name: {
          type: "string",
          description: "The feature identifier (slug used in state.json)",
        },
        to_state: {
          type: "string",
          enum: [
            "draft","specified","planned","decomposed",
            "implementing","blocked","fix_loop","fix_review",
            "awaiting_input","verifying","reviewing",
            "pr_created","merged","escalated",
          ],
          description: "Target state to transition to",
        },
        agent_id: {
          type: "string",
          enum: [
            "spec-generator","plan-generator","task-decomposer",
            "implementation-engine","verification-engine","fix-engine",
            "adversarial-reviewer","git-operator","haiku-validator","orchestrator",
          ],
          description: "Calling agent's identity — used to authorize the transition",
        },
        command: {
          type: "string",
          description: "Machine-readable reason for the transition (logged in transition history)",
        },
      },
      required: ["feature_name", "to_state", "agent_id", "command"],
    },
    allowed_callers: ["code_execution_20260120"],
  } as any,
  {
    name: "append_signal",
    description:
      "Append a typed signal to the feature's signal log. Signals are append-only — never mutated or deleted. " +
      "Downstream agents in the same or next wave read signals to enrich their context. " +
      "Signal types: ATTENTION_REQUIRED|PATTERN_DETECTED|DEPENDENCY_WARNING|CONTEXT_NOTE|META_LEARNING_HINT.",
    input_schema: {
      type: "object" as const,
      properties: {
        feature_name: {
          type: "string",
          description: "The feature identifier",
        },
        from_agent: {
          type: "string",
          enum: [
            "spec-generator","plan-generator","task-decomposer",
            "implementation-engine","verification-engine","fix-engine",
            "adversarial-reviewer","git-operator","haiku-validator","orchestrator",
          ],
          description: "Agent emitting the signal",
        },
        signal_type: {
          type: "string",
          enum: ["ATTENTION_REQUIRED","PATTERN_DETECTED","DEPENDENCY_WARNING","CONTEXT_NOTE","META_LEARNING_HINT"],
          description: "Signal category",
        },
        payload: {
          type: "object",
          description: "Structured signal data — schema varies by signal_type",
        },
      },
      required: ["feature_name", "from_agent", "signal_type", "payload"],
    },
    allowed_callers: ["code_execution_20260120"],
  } as any,
  {
    name: "run_shell",
    description:
      "Run a shell command in the project directory. Returns stdout, stderr, and exit code. " +
      "Use for git, tests, build commands, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute",
        },
        cwd: {
          type: "string",
          description: "Working directory (defaults to project root)",
        },
        timeout_ms: {
          type: "number",
          description: "Timeout in ms (default: 120000)",
        },
      },
      required: ["command"],
    },
    allowed_callers: ["code_execution_20260120"],
  } as any,
  {
    name: "search_code",
    description:
      "Search for a regex pattern in the codebase. Returns matching file paths and line numbers.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string",
          description: "Regex pattern to search for",
        },
        path: {
          type: "string",
          description: "Directory to search in (defaults to project root)",
        },
        glob: {
          type: "string",
          description: "Glob filter for files (e.g., '*.ts', '*.tsx')",
        },
      },
      required: ["pattern"],
    },
    allowed_callers: ["code_execution_20260120"],
  } as any,
];
