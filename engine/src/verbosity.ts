// SDD Autopilot — Shared verbosity utility
// Single source of truth for verbosity resolution across all handler modules.

export type Verbosity = "minimal" | "standard" | "full";

export function resolveVerbosity(v?: string): Verbosity {
  if (v === "minimal" || v === "standard" || v === "full") return v;
  return "full";
}
