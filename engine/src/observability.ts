// Observability — structured run log + audit trail (section 12)
// 12.1  run.log   — {project}/.sdd/run.log  (one JSON line per phase execution)
// 12.2  audit.log — {project}/.sdd/audit.log (one JSON line per PTC tool call)
//
// All timestamps use full ISO-8601 (YYYY-MM-DDTHH:mm:ss.sssZ).
// Never use .slice(0, 10) date-only truncation here.

import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { RunLogEntry, AuditEvent } from "./types.js";

export class RunLogger {
  readonly runId: string;
  readonly runLogPath: string;
  readonly auditLogPath: string;
  private seq = 0;

  constructor(projectPath: string, featureName: string) {
    // Full ISO slug — includes date + hours + minutes + seconds (no sub-second for readability)
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19); // YYYY-MM-DDTHH-mm-ss
    this.runId        = `${featureName}-${ts}`;
    this.runLogPath   = resolve(projectPath, ".sdd", "run.log");
    this.auditLogPath = resolve(projectPath, ".sdd", "audit.log");
    mkdirSync(resolve(projectPath, ".sdd"), { recursive: true });
  }

  /** Append one JSON line to run.log (12.1 — one entry per phase execution). */
  logPhase(entry: RunLogEntry): void {
    appendFileSync(this.runLogPath, JSON.stringify(entry) + "\n", "utf-8");
  }

  /** Append one JSON line to audit.log (12.2 — one entry per PTC tool call). */
  logAuditEvent(event: AuditEvent): void {
    appendFileSync(this.auditLogPath, JSON.stringify(event) + "\n", "utf-8");
  }

  /** Monotonically increasing counter — orders audit events within a run. */
  nextSeq(): number {
    return ++this.seq;
  }
}
