// SDD Autopilot v2 — State manager
// Feature as business entity: transition machine + agent boundaries + typed signals
// Governance lives here (executable), not in prompts (ignorable).

import { readFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteJSON } from "./utils.js";
import type {
  StateJson,
  FeatureState,
  FeatureEntry,
  AgentId,
  Signal,
  SignalType,
  TransitionResult,
  TransitionErrorCode,
} from "./types.js";

// ─── Agent permissions (executable governance) ───────────────────
// This is the authoritative source of allowed transitions.
// state.json does NOT store allowed_transitions — this map IS the contract.
// Any transition not listed here is rejected programmatically in transition().

type TransitionEdge = { from: FeatureState; to: FeatureState };

export const AGENT_PERMISSIONS: Record<AgentId, TransitionEdge[]> = {
  "spec-generator": [
    { from: "draft",          to: "specified" },
    { from: "draft",          to: "awaiting_input" },   // spec too ambiguous
    { from: "awaiting_input", to: "specified" },         // re-specify after human input
  ],
  "plan-architect": [
    { from: "specified",      to: "planned" },
  ],
  "task-decomposer": [
    { from: "planned",        to: "decomposed" },
  ],
  "implementation-engine": [
    { from: "decomposed",     to: "implementing" },
    { from: "implementing",   to: "implementing" },      // task completed (self-transition, updates tasks)
    { from: "implementing",   to: "blocked" },           // TASK_BLOCKED | DEPENDENCY_MISSING
    { from: "fix_loop",       to: "implementing" },      // resume after fix
    { from: "fix_review",     to: "implementing" },      // resume after review fix
  ],
  "verification-engine": [
    { from: "implementing",   to: "verifying" },
    { from: "verifying",      to: "fix_loop" },          // FAIL: implementation_bug
    { from: "verifying",      to: "awaiting_input" },    // SPEC_GAP detected
    { from: "verifying",      to: "reviewing" },         // PASS
  ],
  // haiku-validator: semantic gate checks only — no state transitions
  "haiku-validator": [],
  // orchestrator: resolves human-gate states and is the only one that can escalate.
  // awaiting_input→specified NOT here: orchestrator re-invokes spec-generator with the clarification;
  // spec-generator owns that transition. Orchestrator only restarts from scratch or resolves blockers.
  "orchestrator": [
    { from: "awaiting_input", to: "draft" },             // restart spec from scratch
    { from: "blocked",        to: "implementing" },      // human resolved blocker
    // ── Execution mode skip transitions ──────────────────────────
    // Express mode (trivial): draft → implementing (skip specify/plan/tasks)
    { from: "draft",          to: "implementing" },
    // Light mode (low): specified → implementing (skip plan/tasks)
    { from: "specified",      to: "implementing" },
    // Express/Light: implementing → reviewing (skip verify — use haiku-validator gate instead)
    { from: "implementing",   to: "reviewing" },
    // Review phase (all modes): orchestrator handles review via /code-review plugin
    { from: "reviewing",      to: "pr_created" },        // APPROVE
    { from: "reviewing",      to: "fix_review" },        // REQUEST_CHANGES
    // Fallback: if implementation-engine forgot to transition after fix
    { from: "fix_review",     to: "implementing" },
    { from: "fix_loop",       to: "implementing" },
    // PR phase: orchestrator handles inline (no subagent)
    { from: "pr_created",     to: "merged" },
    // any→escalated handled via isEscalation special-case in transition()
  ],
};

// States that accept re-entry (self-transitions are no-ops on state field)
const SELF_TRANSITION_STATES = new Set<FeatureState>(["implementing"]);

// States that mark the feature as done (no active feature after)
const TERMINAL_STATES = new Set<FeatureState>(["merged", "escalated"]);

// ─── State manager ───────────────────────────────────────────────

export class StateManager {
  private statePath: string;

  constructor(projectRoot: string) {
    this.statePath = join(projectRoot, ".sdd", "state.json");
  }

  async exists(): Promise<boolean> {
    try {
      await readFile(this.statePath, "utf-8");
      return true;
    } catch {
      return false;
    }
  }

  async read(): Promise<StateJson> {
    const raw = await readFile(this.statePath, "utf-8");
    return JSON.parse(raw) as StateJson;
  }

  async write(state: StateJson): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    await atomicWriteJSON(this.statePath, state);
  }

  async init(projectName: string): Promise<StateJson> {
    const state: StateJson = {
      version: "2.0.0",
      project: projectName,
      initialized_at: new Date().toISOString(),
      active_feature: null,
      features: {},
    };
    await this.write(state);
    return state;
  }

  async createFeature(featureName: string): Promise<void> {
    const state = await this.read();
    state.features[featureName] = {
      state: "draft",
      spec_path: `specs/${featureName}/spec.md`,
      transitions: [],
      tasks: {},
      signals: [],
      verification_attempts: 0,
      review_attempts: 0,
      fix_loop_attempts: 0,
      fix_review_attempts: 0,
    };
    state.active_feature = featureName;
    await this.write(state);
  }

  // ─── Transition (the governance gate) ────────────────────────
  // All state mutations go through here. Business rules are enforced here, not in prompts.

  async transition(
    featureName: string,
    toState: FeatureState,
    agentId: AgentId,
    command: string,
  ): Promise<TransitionResult> {
    const state = await this.read();
    const feature = state.features[featureName];

    if (!feature) {
      return { ok: false, code: "FEATURE_NOT_FOUND", reason: `Feature "${featureName}" not found` };
    }

    const fromState = feature.state;

    // Special rule: orchestrator can always escalate from any state
    const isEscalation = toState === "escalated" && agentId === "orchestrator";

    if (!isEscalation) {
      // Validate agent is permitted for this edge
      const agentEdges = AGENT_PERMISSIONS[agentId] ?? [];
      const permitted = agentEdges.some(e => e.from === fromState && e.to === toState);

      if (!permitted) {
        // Distinguish: is this transition valid at all (wrong agent) vs totally invalid?
        const anyAgentAllows = Object.values(AGENT_PERMISSIONS)
          .flat()
          .some(e => e.from === fromState && e.to === toState);

        const code: TransitionErrorCode = anyAgentAllows ? "UNAUTHORIZED" : "INVALID_TRANSITION";
        const reason = anyAgentAllows
          ? `Agent "${agentId}" is not authorized to transition from "${fromState}" to "${toState}"`
          : `No agent can transition from "${fromState}" to "${toState}"`;

        return { ok: false, code, reason };
      }
    }

    // ── Business preconditions ────────────────────────────────
    // These are invariants that the state machine enforces regardless of which agent calls.

    if (toState === "implementing" && fromState === "decomposed") {
      const taskCount = Object.keys(feature.tasks).length;
      if (taskCount === 0) {
        return { ok: false, code: "PRECONDITION_FAILED", reason: "Feature has no tasks defined. Run task-decomposer first." };
      }
    }

    // Worktree gate: first entry into implementing requires an active worktree (or explicit skip).
    // Re-entries from fix_loop/fix_review already have a worktree — only check initial transitions.
    const WORKTREE_REQUIRED_ORIGINS = new Set<FeatureState>(["decomposed", "draft", "specified"]);
    if (toState === "implementing" && WORKTREE_REQUIRED_ORIGINS.has(fromState)) {
      if (!feature.worktree_path && !feature.skip_worktree) {
        return {
          ok: false,
          code: "PRECONDITION_FAILED",
          reason: "No worktree active for this feature. Run /worktree-pr start and store worktree_path via sdd_update_feature, or set skip_worktree: true.",
        };
      }
    }

    if (toState === "verifying") {
      const pending = Object.entries(feature.tasks)
        .filter(([, t]) => t.status !== "completed")
        .map(([id]) => id);
      if (pending.length > 0) {
        return { ok: false, code: "PRECONDITION_FAILED", reason: `${pending.length} task(s) still pending: ${pending.join(", ")}` };
      }
    }

    // ── Circuit breaker ─────────────────────────────────────────
    // Block transitions when delta_check detected regression or thresholds were breached.
    // This is a hard enforcement — even if the orchestrator-prompt ignores the abort signal,
    // the state machine itself will refuse to advance.

    const abortSignal = feature.signals.find(s =>
      s.type === "ATTENTION_REQUIRED" &&
      s.payload &&
      (
        (s.payload as Record<string, unknown>).circuit_breaker === true ||
        String((s.payload as Record<string, unknown>).message ?? "").includes("max_fix_loops")
      )
    );

    if (abortSignal && !isEscalation) {
      return {
        ok: false,
        code: "CIRCUIT_BREAKER" as TransitionErrorCode,
        reason: `Circuit breaker: ${String((abortSignal.payload as Record<string, unknown>).message ?? "delta_check returned abort. Fix loop diverging.")}`,
      };
    }

    // ── Apply transition ──────────────────────────────────────
    const now = new Date().toISOString();
    const isSelf = SELF_TRANSITION_STATES.has(toState) && fromState === toState;

    if (!isSelf) {
      feature.state = toState;
    }

    feature.transitions.push({ from: fromState, to: toState, at: now, command, agent: agentId });

    // Bookkeeping counters
    if (toState === "fix_loop")   feature.fix_loop_attempts  += 1;
    if (toState === "fix_review") feature.fix_review_attempts += 1;
    if (toState === "verifying")  feature.verification_attempts += 1;
    if (toState === "reviewing")  feature.review_attempts += 1;

    // Active feature tracking
    if (TERMINAL_STATES.has(toState)) {
      state.active_feature = null;
    } else if (!isSelf) {
      state.active_feature = featureName;
    }

    await this.write(state);
    return { ok: true, from: fromState, to: toState, agent: agentId };
  }

  // ─── Signal (append-only) ────────────────────────────────────

  async appendSignal(
    featureName: string,
    fromAgent: AgentId,
    type: SignalType,
    payload: Record<string, unknown>,
  ): Promise<{ ok: true; signal: Signal } | { ok: false; reason: string }> {
    const state = await this.read();
    const feature = state.features[featureName];

    if (!feature) {
      return { ok: false, reason: `Feature "${featureName}" not found` };
    }

    const signal: Signal = {
      id: randomUUID(),
      type,
      from_agent: fromAgent,
      at: new Date().toISOString(),
      payload,
    };

    feature.signals.push(signal);
    await this.write(state);

    return { ok: true, signal };
  }

  // ─── Read helpers ─────────────────────────────────────────────

  async getFeature(featureName: string): Promise<FeatureEntry | null> {
    const state = await this.read();
    return state.features[featureName] ?? null;
  }

  async updateFeatureField(
    featureName: string,
    updates: Partial<Pick<FeatureEntry, "plan_path" | "tasks_path" | "worktree_path" | "branch" | "blocked_reason" | "escalation_reason" | "awaiting_input_reason" | "pr_url" | "pr_number" | "skip_worktree">>,
  ): Promise<void> {
    const state = await this.read();
    const feature = state.features[featureName];
    if (!feature) throw new Error(`Feature "${featureName}" not found`);
    Object.assign(feature, updates);
    await this.write(state);
  }

  async markTaskCompleted(featureName: string, taskId: string): Promise<void> {
    const state = await this.read();
    const feature = state.features[featureName];
    if (!feature) throw new Error(`Feature "${featureName}" not found`);
    if (!feature.tasks[taskId]) throw new Error(`Task "${taskId}" not found`);
    feature.tasks[taskId].status = "completed";
    feature.tasks[taskId].completed_at = new Date().toISOString();
    await this.write(state);
  }
}
