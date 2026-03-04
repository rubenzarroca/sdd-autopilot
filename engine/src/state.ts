// State management — adapted from sdd-plugin/server/src/state/manager.ts
// Removed MCP wrapper, kept transition logic, added verification/review states

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { StateJson, FeatureState, FeatureEntry } from "./types.js";

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
    await writeFile(this.statePath, JSON.stringify(state, null, 2), "utf-8");
  }

  async init(projectName: string): Promise<StateJson> {
    const state: StateJson = {
      version: "2.0.0",
      project: projectName,
      initialized_at: new Date().toISOString(),
      active_feature: null,
      features: {},
      allowed_transitions: {
        drafting: ["specified"],
        specified: ["planned"],
        planned: ["tasked"],
        tasked: ["implementing"],
        implementing: ["verifying"],
        verifying: ["reviewing", "implementing"],
        reviewing: ["completed", "implementing"],
        completed: [],
      },
    };
    await this.write(state);
    return state;
  }

  async getFeature(featureName: string): Promise<FeatureEntry | null> {
    const state = await this.read();
    return state.features[featureName] ?? null;
  }

  async transition(
    featureName: string,
    toState: FeatureState,
    command: string
  ): Promise<{ ok: true; from: FeatureState; to: FeatureState } | { ok: false; error: string }> {
    const state = await this.read();

    const feature = state.features[featureName];
    if (!feature) {
      return { ok: false, error: `Feature "${featureName}" not found in state.json` };
    }

    const fromState = feature.state;
    const allowed = state.allowed_transitions[fromState];
    if (!allowed || !allowed.includes(toState)) {
      return {
        ok: false,
        error: `Cannot transition from "${fromState}" to "${toState}". Allowed: ${(allowed ?? []).join(", ")}`,
      };
    }

    // Precondition: implementing requires tasks exist
    if (toState === "implementing") {
      const taskCount = Object.keys(feature.tasks).length;
      if (taskCount === 0) {
        return { ok: false, error: "Feature has no tasks defined" };
      }
    }

    // Precondition: verifying requires all tasks completed
    if (toState === "verifying") {
      const pending = Object.entries(feature.tasks)
        .filter(([, t]) => t.status !== "completed")
        .map(([id]) => id);
      if (pending.length > 0) {
        return { ok: false, error: `${pending.length} tasks still pending: ${pending.join(", ")}` };
      }
    }

    const now = new Date().toISOString();
    feature.state = toState;
    feature.transitions.push({ from: fromState, to: toState, at: now, command });

    if (toState === "implementing" || toState === "drafting") {
      state.active_feature = featureName;
    }
    if (toState === "completed") {
      state.active_feature = null;
    }

    await this.write(state);
    return { ok: true, from: fromState, to: toState };
  }

  async createFeature(featureName: string): Promise<void> {
    const state = await this.read();
    state.features[featureName] = {
      state: "drafting",
      spec_path: `specs/${featureName}/spec.md`,
      transitions: [],
      tasks: {},
      verification_attempts: 0,
      review_attempts: 0,
    };
    state.active_feature = featureName;
    await this.write(state);
  }

  async updateFeatureField(
    featureName: string,
    updates: Partial<FeatureEntry>
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

  async incrementAttempt(featureName: string, type: "verification" | "review"): Promise<number> {
    const state = await this.read();
    const feature = state.features[featureName];
    if (!feature) throw new Error(`Feature "${featureName}" not found`);
    const field = type === "verification" ? "verification_attempts" : "review_attempts";
    feature[field] += 1;
    await this.write(state);
    return feature[field];
  }
}
