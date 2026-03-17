// SDD Autopilot v2 — State manager
// Feature as business entity: transition machine + agent boundaries + typed signals
// Governance lives here (executable), not in prompts (ignorable).

import { readFile, mkdir, stat } from "node:fs/promises";
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
  RunHistoryEntry,
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
    // ── Pause / Resume ──────────────────────────────────────────
    // Any non-terminal state → paused (orchestrator only)
    { from: "draft",          to: "paused" },
    { from: "specified",      to: "paused" },
    { from: "planned",        to: "paused" },
    { from: "decomposed",     to: "paused" },
    { from: "implementing",   to: "paused" },
    { from: "blocked",        to: "paused" },
    { from: "fix_loop",       to: "paused" },
    { from: "fix_review",     to: "paused" },
    { from: "awaiting_input", to: "paused" },
    { from: "verifying",      to: "paused" },
    { from: "reviewing",      to: "paused" },
    { from: "pr_created",     to: "paused" },
    // paused → draft (reset, orchestrator only)
    { from: "paused",         to: "draft" },
  ],
};

// States that accept re-entry (self-transitions are no-ops on state field)
const SELF_TRANSITION_STATES = new Set<FeatureState>(["implementing"]);

// States that mark the feature as done (no active feature after).
// "escalated" is the only truly terminal state (no outbound transitions).
// "merged" is terminal (feature complete). "paused" is NOT terminal — it's recoverable via reset.
const TERMINAL_STATES = new Set<FeatureState>(["merged", "escalated"]);

// ─── State manager ───────────────────────────────────────────────

export class StateManager {
  private statePath: string;
  private static cache = new Map<string, StateJson>();
  private static lastMtime = new Map<string, number>();

  constructor(projectRoot: string) {
    this.statePath = join(projectRoot, ".sdd", "state.json");
  }

  /** Clear the in-memory cache (for testing or refresh_state). */
  static clearCache(): void {
    StateManager.cache.clear();
    StateManager.lastMtime.clear();
  }

  /** Invalidate cache for a specific project root (force next read to reload from disk). */
  static invalidate(projectRoot: string): void {
    const statePath = join(projectRoot, ".sdd", "state.json");
    StateManager.cache.delete(statePath);
    StateManager.lastMtime.delete(statePath);
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
    // mtime check: detect external modifications even when cache exists
    const cached = StateManager.cache.get(this.statePath);
    if (cached) {
      try {
        const fileStat = await stat(this.statePath);
        const fileMtime = fileStat.mtimeMs;
        const knownMtime = StateManager.lastMtime.get(this.statePath);
        if (knownMtime !== undefined && fileMtime > knownMtime) {
          console.warn("[SDD] External state modification detected, reloading from disk");
          StateManager.cache.delete(this.statePath);
          // fall through to disk read
        } else {
          return structuredClone(cached);
        }
      } catch {
        // stat failed — fall through to disk read
        StateManager.cache.delete(this.statePath);
      }
    }

    let raw: string;
    try {
      raw = await readFile(this.statePath, "utf-8");
    } catch (err) {
      throw new Error(`[SDD] Failed to read state.json at ${this.statePath}: ${(err as Error).message}`);
    }

    let state: StateJson;
    try {
      state = JSON.parse(raw) as StateJson;
    } catch (err) {
      throw new Error(`[SDD] state.json is corrupted at ${this.statePath}. Run 'sdd --reset' to reinitialize. Parse error: ${(err as Error).message}`);
    }

    // Backfill run_counter/run_history for state files created before this field existed
    if (state.run_counter === undefined) state.run_counter = 0;
    if (state.run_history === undefined) state.run_history = [];

    StateManager.cache.set(this.statePath, structuredClone(state));
    try {
      const fileStat = await stat(this.statePath);
      StateManager.lastMtime.set(this.statePath, fileStat.mtimeMs);
    } catch { /* best-effort mtime tracking */ }
    return state;
  }

  async write(state: StateJson): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    await atomicWriteJSON(this.statePath, state);
    StateManager.cache.set(this.statePath, structuredClone(state));
    try {
      const fileStat = await stat(this.statePath);
      StateManager.lastMtime.set(this.statePath, fileStat.mtimeMs);
    } catch { /* best-effort mtime tracking */ }
  }

  async init(projectName: string): Promise<StateJson> {
    const state: StateJson = {
      version: "2.0.0",
      project: projectName,
      initialized_at: new Date().toISOString(),
      active_feature: null,
      features: {},
      run_counter: 0,
      run_history: [],
    };
    await this.write(state);
    return state;
  }

  // ─── Run counter ──────────────────────────────────────────────

  /** Record a completed pipeline run. Increments counter, appends to history (bounded FIFO, max 20). */
  async recordRun(entry: Omit<RunHistoryEntry, "run_id">): Promise<RunHistoryEntry> {
    const state = await this.read();
    state.run_counter += 1;
    const fullEntry: RunHistoryEntry = { run_id: state.run_counter, ...entry };
    state.run_history.push(fullEntry);
    // FIFO bound: keep only last 20 entries
    if (state.run_history.length > 20) {
      state.run_history = state.run_history.slice(-20);
    }
    await this.write(state);
    return fullEntry;
  }

  /** Returns the current run counter (total completed pipeline runs). */
  async getRunCounter(): Promise<number> {
    const state = await this.read();
    return state.run_counter;
  }

  // ─── Pause / Reset ────────────────────────────────────────────

  /** Pause a feature: sets state to "paused" and emits a STATE_PAUSED signal. */
  async pauseFeature(featureName: string, reason: string): Promise<void> {
    const state = await this.read();
    const feature = state.features[featureName];
    if (!feature) throw new Error(`Feature "${featureName}" not found`);
    const fromState = feature.state;
    feature.state = "paused";
    const now = new Date().toISOString();
    feature.transitions.push({ from: fromState, to: "paused", at: now, command: "pause", agent: "orchestrator" });
    feature.signals.push({
      id: randomUUID(),
      type: "CONTEXT_NOTE",
      from_agent: "orchestrator",
      at: now,
      payload: { type: "STATE_PAUSED", from_state: fromState, reason, timestamp: now },
    });
    console.warn(`[SDD] Feature '${featureName}' paused. Previous state: ${fromState}. Reason: ${reason}`);
    await this.write(state);
  }

  /** Reset a feature to draft: clears counters, emits STATE_RESET signal. */
  async resetFeature(featureName: string, reason: string): Promise<void> {
    const state = await this.read();
    const feature = state.features[featureName];
    if (!feature) throw new Error(`Feature "${featureName}" not found`);
    const fromState = feature.state;
    feature.state = "draft";
    feature.fix_loop_attempts = 0;
    feature.fix_review_attempts = 0;
    feature.verification_attempts = 0;
    feature.review_attempts = 0;
    delete feature.blocked_reason;
    delete feature.escalation_reason;
    const now = new Date().toISOString();
    feature.transitions.push({ from: fromState, to: "draft", at: now, command: "reset", agent: "orchestrator" });
    feature.signals.push({
      id: randomUUID(),
      type: "CONTEXT_NOTE",
      from_agent: "orchestrator",
      at: now,
      payload: { type: "STATE_RESET", from_state: fromState, reason, timestamp: now },
    });
    console.warn(`[SDD] Feature '${featureName}' reset to draft. Previous state: ${fromState}. Reason: ${reason}`);
    await this.write(state);
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

    // Hard cap: auto-prune oldest 50 signals when array exceeds 200
    if (feature.signals.length >= 200) {
      console.warn(`[SDD] Signal array exceeded 200 entries, auto-pruning oldest 50`);
      feature.signals = feature.signals.slice(50);
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
    updates: Partial<Pick<FeatureEntry, "plan_path" | "tasks_path" | "worktree_path" | "branch" | "blocked_reason" | "escalation_reason" | "awaiting_input_reason" | "pr_url" | "pr_number" | "skip_worktree" | "brief">>,
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
