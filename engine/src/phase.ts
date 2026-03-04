// runPhase() — single PTC agentic loop per phase
// Adapted from ptc-code-patterns.md agentic loop pattern

import Anthropic from "@anthropic-ai/sdk";
import { CODE_EXECUTION_TOOL, TOOLS } from "./tools.js";
import { executeToolCall, type HandlerContext } from "./handlers.js";
import { MODELS, type PhaseResult } from "./types.js";

// ─── Retry wrapper ───────────────────────────────────────────────

const RETRY_STATUS_CODES = new Set([429, 529, 500, 503]);
const MAX_RETRIES = 3;

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      const isRetryable = status != null && RETRY_STATUS_CODES.has(status);
      if (!isRetryable || attempt === MAX_RETRIES) throw err;
      const delay = 1000 * 2 ** attempt;
      console.error(`  [retry] API error ${status}, waiting ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("Unreachable");
}

// ─── Phase runner ────────────────────────────────────────────────

export interface PhaseOptions {
  model: "opus" | "sonnet";
  systemPrompt: string;
  maxIterations?: number;
  onStep?: (label: string) => void;
  projectPath: string;
}

export async function runPhase(
  phaseName: string,
  userMessage: string,
  options: PhaseOptions,
): Promise<PhaseResult> {
  const anthropic = new Anthropic();
  const model = MODELS[options.model];
  const maxIterations = options.maxIterations ?? 25;
  const ctx: HandlerContext = { projectPath: options.projectPath };

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  let containerId: string | null = null;
  const steps: string[] = [];
  let totalInput = 0;
  let totalOutput = 0;
  let toolCallCount = 0;
  let finalText = "";

  console.log(`\n  [${phaseName}] Starting (model: ${options.model})...`);

  for (let iter = 0; iter < maxIterations; iter++) {
    const response = await withRetry(() =>
      anthropic.messages.create({
        model,
        max_tokens: 16384,
        system: options.systemPrompt,
        tools: [CODE_EXECUTION_TOOL, ...TOOLS],
        messages,
        ...(containerId ? { container: containerId } : {}),
      } as any),
    ) as any;

    // Capture container_id
    if (response.container?.id) {
      containerId = response.container.id;
    }

    totalInput += response.usage?.input_tokens ?? 0;
    totalOutput += response.usage?.output_tokens ?? 0;

    // Collect text and tool_use blocks
    const textParts: string[] = [];
    const toolUseBlocks: Anthropic.Messages.ToolUseBlock[] = [];

    for (const block of response.content) {
      if (block.type === "text" && block.text) {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        toolUseBlocks.push(block);
      }
    }

    if (textParts.length > 0) {
      finalText += textParts.join("");
    }

    // No tool calls → done
    if (toolUseBlocks.length === 0) {
      console.log(`  [${phaseName}] Completed (${iter + 1} iterations, ${toolCallCount} tool calls)`);
      break;
    }

    // Execute tool calls
    messages.push({ role: "assistant", content: response.content });

    const toolResults = await Promise.all(
      toolUseBlocks.map(async (block) => {
        const label = `${block.name}`;
        steps.push(label);
        toolCallCount++;
        options.onStep?.(label);

        if (toolCallCount % 5 === 0) {
          console.log(`  [${phaseName}] ${toolCallCount} tool calls...`);
        }

        try {
          const result = await executeToolCall(
            block.name,
            block.input as Record<string, unknown>,
            ctx,
          );
          return {
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: JSON.stringify(result),
          };
        } catch (err) {
          return {
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
            is_error: true,
          };
        }
      }),
    );

    messages.push({ role: "user", content: toolResults });

    // Safety: stop if we hit max iterations
    if (iter === maxIterations - 1) {
      console.warn(`  [${phaseName}] Hit max iterations (${maxIterations})`);
    }
  }

  return {
    text: finalText,
    steps,
    model: options.model,
    usage: {
      input_tokens: totalInput,
      output_tokens: totalOutput,
      tool_calls: toolCallCount,
    },
  };
}
