// SDD Autopilot — Tool Factory handlers
// Self-evolution: sdd_propose_tool, sdd_review_tool_proposal, sdd_generate_tool_prompt
// All deterministic — no LLM calls.

import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileExists } from "./utils.js";
import { TOOLS } from "./index.js";
import type { ToolProposal, ToolReviewResult, ToolPromptResult } from "./types.js";

// ─── sdd_propose_tool ─────────────────────────────────────────────

export async function handleProposeTool(params: {
  project_path: string;
  name: string;
  description: string;
  rationale: string;
  proposed_input_schema: Record<string, unknown>;
  proposed_output_schema: Record<string, unknown>;
  proposed_handler_logic: string;
  target_file: string;
  pipeline_phase: string;
  trigger_context: string;
}): Promise<unknown> {
  try {
    // Validate name format
    if (!/^sdd_[a-z_]+$/.test(params.name)) {
      return { success: false, error: `Invalid tool name "${params.name}". Must match /^sdd_[a-z_]+$/` };
    }

    const proposalPath = resolve(params.project_path, ".sdd", "proposals", `tool-${params.name}.json`);

    // Check for existing proposal
    if (await fileExists(proposalPath)) {
      return { success: false, error: `Proposal for "${params.name}" already exists at ${proposalPath}` };
    }

    // Check for existing tool with same name
    if (TOOLS.some(t => t.name === params.name)) {
      return { success: false, error: `Tool "${params.name}" already exists in the TOOLS array` };
    }

    // Ensure proposals directory exists
    await mkdir(resolve(params.project_path, ".sdd", "proposals"), { recursive: true });

    // Read state.json for run_id and feature_id
    let run_id = "";
    let feature_id = "";
    const statePath = resolve(params.project_path, ".sdd", "state.json");
    if (await fileExists(statePath)) {
      try {
        const state = JSON.parse(await readFile(statePath, "utf-8"));
        feature_id = state.active_feature ?? "";
        if (feature_id && state.features?.[feature_id]) {
          const transitions = state.features[feature_id].transitions ?? [];
          if (transitions.length > 0) {
            run_id = transitions[transitions.length - 1].command ?? "";
          }
        }
      } catch { /* ignore parse errors */ }
    }

    const proposal: ToolProposal = {
      name: params.name,
      description: params.description,
      rationale: params.rationale,
      proposed_input_schema: params.proposed_input_schema,
      proposed_output_schema: params.proposed_output_schema,
      proposed_handler_logic: params.proposed_handler_logic,
      target_file: params.target_file,
      pipeline_phase: params.pipeline_phase,
      trigger_context: params.trigger_context,
      proposed_at: new Date().toISOString(),
      proposed_by: "orchestrator",
      status: "proposed",
      run_id,
      feature_id,
    };

    await writeFile(proposalPath, JSON.stringify(proposal, null, 2), "utf-8");

    return { success: true, proposal_path: proposalPath, status: "proposed" };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── sdd_review_tool_proposal ─────────────────────────────────────

export async function handleReviewToolProposal(params: {
  project_path: string;
  proposal_name: string;
  reviewer_assessment?: string;
}): Promise<unknown> {
  try {
    const proposalPath = resolve(params.project_path, ".sdd", "proposals", `tool-${params.proposal_name}.json`);

    if (!await fileExists(proposalPath)) {
      return { success: false, error: `Proposal "${params.proposal_name}" not found at ${proposalPath}` };
    }

    const proposal: ToolProposal = JSON.parse(await readFile(proposalPath, "utf-8"));

    if (proposal.status !== "proposed") {
      return { success: false, error: `Proposal "${params.proposal_name}" is in status "${proposal.status}", expected "proposed"` };
    }

    // Compute overlap with existing tools
    const overlapDetails: Array<{ tool: string; score: number }> = [];
    const overlappingTools: string[] = [];

    // Tokenize proposal description
    const proposalTokens = new Set(proposal.description.toLowerCase().split(/\s+/).filter(Boolean));
    const proposalRequired = (proposal.proposed_input_schema as any)?.required as string[] | undefined ?? [];

    for (const tool of TOOLS) {
      // Jaccard similarity on tokenized descriptions
      const toolTokens = new Set(tool.description.toLowerCase().split(/\s+/).filter(Boolean));
      const intersection = new Set([...proposalTokens].filter(t => toolTokens.has(t)));
      const union = new Set([...proposalTokens, ...toolTokens]);
      const jaccard = union.size > 0 ? intersection.size / union.size : 0;

      // Check if proposal required input params are a subset of existing tool required params
      const toolRequired = (tool.inputSchema as any)?.required as string[] | undefined ?? [];
      const isSubset = proposalRequired.length > 0 && proposalRequired.every(p => toolRequired.includes(p));

      const combinedScore = 0.7 * jaccard + 0.3 * (isSubset ? 1 : 0);

      if (combinedScore > 0) {
        overlapDetails.push({ tool: tool.name, score: Math.round(combinedScore * 1000) / 1000 });
      }

      if (combinedScore > 0.6) {
        overlappingTools.push(tool.name);
      }
    }

    // Decision
    let status: "validated" | "rejected";
    let reason: string | undefined;

    if (overlappingTools.length > 0) {
      status = "rejected";
      reason = `Overlaps with existing tool(s): ${overlappingTools.join(", ")}`;
    } else {
      status = "validated";
    }

    // Emit signal to signals.jsonl
    const signalsPath = resolve(params.project_path, ".sdd", "signals.jsonl");
    await mkdir(resolve(params.project_path, ".sdd"), { recursive: true });

    const signal = status === "validated"
      ? { type: "TOOL_PROPOSAL_READY", content: `${params.proposal_name}: ${proposal.description}`, timestamp: new Date().toISOString() }
      : { type: "TOOL_PROPOSAL_REJECTED", content: `${params.proposal_name} rejected: overlaps with ${overlappingTools.join(", ")}`, timestamp: new Date().toISOString() };

    await appendFile(signalsPath, JSON.stringify(signal) + "\n", "utf-8");

    // Update proposal
    proposal.status = status;
    proposal.reviewed_at = new Date().toISOString();
    proposal.overlap_details = overlapDetails.filter(d => d.score > 0);
    if (params.reviewer_assessment) {
      proposal.reviewer_assessment = params.reviewer_assessment;
    }
    if (reason) {
      proposal.rejection_reason = reason;
    }

    await writeFile(proposalPath, JSON.stringify(proposal, null, 2), "utf-8");

    const result: ToolReviewResult & { success?: boolean } = { status };
    if (reason) result.reason = reason;
    if (overlappingTools.length > 0) result.overlapping_tools = overlappingTools;
    if (overlapDetails.length > 0) result.overlap_scores = overlapDetails.filter(d => d.score > 0);

    return result;
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── sdd_generate_tool_prompt ─────────────────────────────────────

export async function handleGenerateToolPrompt(params: {
  project_path: string;
  proposal_name: string;
}): Promise<unknown> {
  try {
    const proposalPath = resolve(params.project_path, ".sdd", "proposals", `tool-${params.proposal_name}.json`);

    if (!await fileExists(proposalPath)) {
      return { success: false, error: `Proposal "${params.proposal_name}" not found at ${proposalPath}` };
    }

    const proposal: ToolProposal = JSON.parse(await readFile(proposalPath, "utf-8"));

    if (proposal.status !== "validated") {
      return { success: false, error: `Proposal "${params.proposal_name}" is in status "${proposal.status}", expected "validated"` };
    }

    const prompt = [
      "# Prompt: Implementar tool " + proposal.name,
      "",
      "## Contexto",
      proposal.rationale,
      "",
      "Trigger: " + proposal.trigger_context,
      "",
      "## Tool specification",
      "- Name: " + proposal.name,
      "- Description: " + proposal.description,
      "- Target file: " + proposal.target_file,
      "- Input schema:",
      "```json",
      JSON.stringify(proposal.proposed_input_schema, null, 2),
      "```",
      "- Output schema:",
      "```json",
      JSON.stringify(proposal.proposed_output_schema, null, 2),
      "```",
      "",
      "## Handler logic",
      proposal.proposed_handler_logic,
      "",
      "## Implementación requerida",
      "1. Implementar handler en " + proposal.target_file,
      "2. Exportar función",
      "3. Añadir import en index.ts",
      "4. Añadir entry en HANDLER_MAP",
      "5. Añadir entry en TOOLS con inputSchema y outputSchema",
      "6. Correr alignment test",
      "7. Actualizar SKILL.md sección " + proposal.pipeline_phase + " con el paso donde se usa",
      "",
      "## Lo que NO hacer",
      "- No crear stubs",
      "- No modificar tools existentes",
      "",
    ].join("\n");

    const promptPath = resolve(params.project_path, ".sdd", "proposals", `prompt-${params.proposal_name}.md`);
    await writeFile(promptPath, prompt, "utf-8");

    // Update proposal status
    proposal.status = "prompt_generated";
    await writeFile(proposalPath, JSON.stringify(proposal, null, 2), "utf-8");

    return { success: true, prompt_path: promptPath };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
