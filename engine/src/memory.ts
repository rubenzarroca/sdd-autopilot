// Memory Manager — two-layer persistent memory for SDD Autopilot (section 10)
//
// Layer 1: {project}/.sdd/memory.md    — project-scoped
//   - Project Conventions  (generated from codebase-map, updated rarely)
//   - Learned Patterns     (append-only after each run, via Haiku)
//   - Run History          (compact log of past runs)
//
// Layer 2: ~/.claude/sdd-autopilot/user-memory.md  — cross-project, user-scoped
//   - Cross-Project Patterns
//   - Design Heuristics
//   - Agent Performance Log

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";

// ─── Memory Provenance Types (GAP-02) ─────────────────────────────

export interface MemoryEntryMetadata {
  agent: string;
  run_id: string;
  feature_id: string;
  timestamp: string;
  confidence: number;  // 0-1
  ttl?: number;
}

export interface MemoryEntry {
  content: string;
  metadata: MemoryEntryMetadata;
}

// ─── Memory Sanitization (GAP-03) ─────────────────────────────────

const INJECTION_PATTERNS: RegExp[] = [
  /ignore previous instructions/i,
  /ignore all previous/i,
  /you are now/i,
  /\bact as\b/i,
  /system prompt/i,
  /\boverride\b/i,
  /\bdisregard\b/i,
  /pretend you are/i,
  /from now on you are/i,
];

export function sanitizeMemoryContent(content: string): { clean: boolean; content: string; warnings: string[] } {
  const warnings: string[] = [];
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(content)) {
      warnings.push(`Suspicious pattern detected: ${pattern.source}`);
    }
  }
  return { clean: warnings.length === 0, content, warnings };
}

// ─── GAP-10: Structured Extraction Filter ───────────────────────

const SECTION_PATTERNS: Record<string, RegExp[]> = {
  project_conventions: [
    /\buse\s+\S+\s+for\b/i,
    /\balways\b/i,
    /\bnever\b/i,
    /\bprefer\s+\S+\s+over\b/i,
    /\bnaming\s+convention/i,
    /\bpattern:/i,
    /\bconvention:/i,
    /\b(?:default|standard|required|recommended|avoid|ensure)\b/i,
    /\b(?:config|setting|option|flag|param)\b/i,
    /\b(?:style|format|structure|layout|organize)\b/i,
    /\b(?:import|export|module|package|dependency)\b/i,
    /\b(?:test|lint|check|validate|enforce)\b/i,
  ],
  learned_patterns: [
    /\b(?:when|if)\s+.+\b(?:then|do|must|should)\b/i,
    /\b(?:pattern|cause|trigger|fix|workaround|resolved\s+by|fixed\s+by):/i,
    /\b(?:because|causes|leads\s+to|results\s+in|prevents)\b/i,
    /\b(?:learned|observed|noticed|found|discovered|insight|note)\b/i,
    /\b(?:tip|recommendation|suggestion|rule|guideline|best\s+practice)\b/i,
    /\b(?:error|issue|problem|bug|failure|crash|timeout|reject)\b/i,
    /\b(?:solution|approach|strategy|technique|method|way\s+to)\b/i,
    /\b(?:important|critical|careful|watch\s+out|beware|caveat|gotcha)\b/i,
    /\b(?:works|helps|improves|reduces|speeds|simplifies)\b/i,
    /\b(?:avoid|skip|don't|do\s+not|instead|rather)\b/i,
    /\b(?:should|must|need|require|expect|assume)\b/i,
  ],
};
SECTION_PATTERNS.cross_project_patterns = SECTION_PATTERNS.learned_patterns;

export function validateExtractionFilter(content: string, section: string): { valid: boolean; reason?: string } {
  const patterns = SECTION_PATTERNS[section];
  if (!patterns) return { valid: true }; // run_history, agent_performance: no filter
  for (const p of patterns) {
    if (p.test(content)) return { valid: true };
  }
  return { valid: false, reason: `Content does not match expected patterns for section ${section}` };
}

// ─── GAP-01: Memory Consolidation ───────────────────────────────

const CONSOLIDATION_THRESHOLDS: Record<string, number> = {
  learned_patterns: 0.6,
  project_conventions: 0.7,
  cross_project_patterns: 0.7,
};

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter(t => t.length > 0),
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1.0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 1.0 : intersection / union;
}

export function consolidateEntry(
  existingEntries: string[],
  newContent: string,
  section: string,
): { action: "create" | "update" | "skip"; targetIndex?: number; reason: string; similarity_score?: number } {
  const threshold = CONSOLIDATION_THRESHOLDS[section];
  if (threshold === undefined) {
    return { action: "create", reason: "Section skips consolidation" };
  }

  const newTokens = tokenize(newContent);
  let bestScore = 0;
  let bestIndex = -1;

  for (let i = 0; i < existingEntries.length; i++) {
    const existingTokens = tokenize(existingEntries[i]);
    const score = jaccardSimilarity(newTokens, existingTokens);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  if (bestScore >= 1.0) {
    return { action: "skip", targetIndex: bestIndex, reason: "Identical entry already exists", similarity_score: bestScore };
  }
  if (bestScore > threshold) {
    return { action: "update", targetIndex: bestIndex, reason: `Similar entry found (Jaccard=${bestScore.toFixed(3)})`, similarity_score: bestScore };
  }
  return { action: "create", reason: bestScore > 0 ? `No similar entry above threshold (best=${bestScore.toFixed(3)})` : "No similar entries found", similarity_score: bestScore };
}

// ─── Types ───────────────────────────────────────────────────────

export interface ProjectMemory {
  conventions: string;       // ## Project Conventions section body
  learnedPatterns: string;   // ## Learned Patterns section body
  runHistory: string;        // ## Run History section body
  runCount: number;          // count of RUN-NNN entries (triggers consolidation every 10)
  retroHistory: string;      // ## Retro History section body  (11.1)
  retroCount: number;        // count of RETRO-NNN entries     (11.1)
  cleanMergeCount: number;   // count of clean retros          (11.1, triggers trends every 5)
}

export interface UserMemory {
  crossProjectPatterns: string;  // ## Cross-Project Patterns section body
  designHeuristics: string;      // ## Design Heuristics section body
  agentPerformanceLog: string;   // ## Agent Performance Log section body
}

export interface RunHistoryEntry {
  feature: string;
  date: string;   // ISO date (YYYY-MM-DD)
  cost: string;   // e.g. "$1.23"
  fix_loops: number;
  result: "merged" | "escalated" | "critical_complexity" | "spec_gap" | "infra_issue";
}

// ─── MemoryManager ───────────────────────────────────────────────

export class MemoryManager {
  readonly projectMemoryPath: string;
  readonly userMemoryPath: string;

  constructor(projectPath: string) {
    this.projectMemoryPath = resolve(projectPath, ".sdd", "memory.md");
    this.userMemoryPath    = resolve(homedir(), ".claude", "sdd-autopilot", "user-memory.md");
  }

  // ─── Read ──────────────────────────────────────────────────────

  readProjectMemory(): ProjectMemory {
    if (!existsSync(this.projectMemoryPath)) {
      return { conventions: "", learnedPatterns: "", runHistory: "", runCount: 0, retroHistory: "", retroCount: 0, cleanMergeCount: 0 };
    }
    const content = readFileSync(this.projectMemoryPath, "utf-8");
    const learnedPatterns = this.extractSection(content, "Learned Patterns");
    const runHistory      = this.extractSection(content, "Run History");
    const retroHistory    = this.extractSection(content, "Retro History");
    return {
      conventions:     this.extractSection(content, "Project Conventions"),
      learnedPatterns,
      runHistory,
      runCount:        (runHistory.match(/^<!-- RUN-/gm) ?? []).length,
      retroHistory,
      retroCount:      (retroHistory.match(/^<!-- RETRO-/gm) ?? []).length,
      cleanMergeCount: (retroHistory.match(/<!-- RETRO-\d+: [^,]+, clean,/gm) ?? []).length,
    };
  }

  readUserMemory(): UserMemory {
    if (!existsSync(this.userMemoryPath)) {
      return { crossProjectPatterns: "", designHeuristics: "", agentPerformanceLog: "" };
    }
    const content = readFileSync(this.userMemoryPath, "utf-8");
    return {
      crossProjectPatterns: this.extractSection(content, "Cross-Project Patterns"),
      designHeuristics:     this.extractSection(content, "Design Heuristics"),
      agentPerformanceLog:  this.extractSection(content, "Agent Performance Log"),
    };
  }

  // ─── Init ─────────────────────────────────────────────────────

  initProjectMemory(projectName: string, conventionsContent: string): void {
    if (existsSync(this.projectMemoryPath)) return;
    const content =
`# Project Memory — ${projectName}

## Project Conventions
${conventionsContent.trim()}

## Learned Patterns
(no patterns learned yet)

## Run History
(no runs recorded yet)

## Retro History
(no retros recorded yet)
`;
    mkdirSync(dirname(this.projectMemoryPath), { recursive: true });
    writeFileSync(this.projectMemoryPath, content, "utf-8");
  }

  initUserMemory(): void {
    if (existsSync(this.userMemoryPath)) return;
    const content =
`# User Memory — SDD Autopilot

## Cross-Project Patterns
(no cross-project patterns recorded yet)

## Design Heuristics
(no design heuristics recorded yet)

## Agent Performance Log
(no agent performance data recorded yet)

## Exploration Log
(no exploration experiments recorded yet)
`;
    mkdirSync(dirname(this.userMemoryPath), { recursive: true });
    writeFileSync(this.userMemoryPath, content, "utf-8");
  }

  // ─── Append ───────────────────────────────────────────────────

  // currentRun: run number for audit trail. ttl: decay counter (default 15). Omit both for date-only format (no decay).
  appendLearnedPatterns(patterns: string[], currentRun?: number, ttl: number = 15): void {
    if (patterns.length === 0 || !existsSync(this.projectMemoryPath)) return;
    const content = readFileSync(this.projectMemoryPath, "utf-8");
    const existing = this.extractSection(content, "Learned Patterns");
    const currentCount = (existing.match(/^<!-- PATTERN-/gm) ?? []).length;
    const date = new Date().toISOString().slice(0, 10);
    const newEntries = patterns.map((p, i) => {
      const id = String(currentCount + i + 1).padStart(3, "0");
      // TTL format when run is known; date-only format for legacy callers (no decay applied)
      const tag = currentRun !== undefined ? `added_run=${currentRun}, ttl=${ttl}` : date;
      return `<!-- PATTERN-${id}: ${tag} -->\n${p.trim()}`;
    }).join("\n\n");
    const body = existing.startsWith("(no patterns") ? newEntries : `${existing.trim()}\n\n${newEntries}`;
    const result = this.replaceSection(content, "Learned Patterns", body);
    if (!result.modified) {
      // Section missing — append it and write
      const withSection = content.trimEnd() + `\n\n## Learned Patterns\n${body}\n`;
      writeFileSync(this.projectMemoryPath, withSection, "utf-8");
    } else {
      writeFileSync(this.projectMemoryPath, result.content, "utf-8");
    }
  }

  appendRunHistory(entry: RunHistoryEntry): void {
    if (!existsSync(this.projectMemoryPath)) return;
    const content = readFileSync(this.projectMemoryPath, "utf-8");
    const existing = this.extractSection(content, "Run History");
    const count = (existing.match(/^<!-- RUN-/gm) ?? []).length;
    const id = String(count + 1).padStart(3, "0");
    const newEntry =
      `<!-- RUN-${id}: ${entry.date} -->\n` +
      `feature=${entry.feature}  cost=${entry.cost}  fix_loops=${entry.fix_loops}  result=${entry.result}`;
    const body = existing.startsWith("(no runs") ? newEntry : `${existing.trim()}\n\n${newEntry}`;
    writeFileSync(this.projectMemoryPath, this.replaceSection(content, "Run History", body).content, "utf-8");
  }

  appendCrossProjectPattern(pattern: string): void {
    if (!existsSync(this.userMemoryPath)) return;
    const content = readFileSync(this.userMemoryPath, "utf-8");
    const existing = this.extractSection(content, "Cross-Project Patterns");
    const date = new Date().toISOString().slice(0, 10);
    const count = (existing.match(/^<!-- XP-/gm) ?? []).length;
    const id = String(count + 1).padStart(3, "0");
    const newEntry = `<!-- XP-${id}: ${date} -->\n${pattern.trim()}`;
    const body = existing.startsWith("(no cross") ? newEntry : `${existing.trim()}\n\n${newEntry}`;
    writeFileSync(this.userMemoryPath, this.replaceSection(content, "Cross-Project Patterns", body).content, "utf-8");
  }

  replaceLearnedPatterns(consolidated: string): void {
    if (!existsSync(this.projectMemoryPath)) return;
    const content = readFileSync(this.projectMemoryPath, "utf-8");
    writeFileSync(this.projectMemoryPath, this.replaceSection(content, "Learned Patterns", consolidated.trim()).content, "utf-8");
  }

  // ─── Retro history ────────────────────────────────────────────
  // (11.1) Append an RETRO-NNN entry to ## Retro History in project memory.

  appendRetroEntry(result: { clean_merge: boolean; delta_summary: string; learnings: string[]; human_changes_count: number }, featureName: string): void {
    if (!existsSync(this.projectMemoryPath)) return;
    const content = readFileSync(this.projectMemoryPath, "utf-8");
    const existing = this.extractSection(content, "Retro History");
    const count = (existing.match(/^<!-- RETRO-/gm) ?? []).length;
    const id = String(count + 1).padStart(3, "0");
    const date = new Date().toISOString().slice(0, 10);
    const cleanTag = result.clean_merge ? "clean" : "fixed";
    const learningLines = result.learnings.length > 0
      ? `\n${result.learnings.map(l => `  · ${l}`).join("\n")}`
      : "";
    const newEntry =
      `<!-- RETRO-${id}: ${date}, ${cleanTag}, changes=${result.human_changes_count} -->\n` +
      `feature=${featureName}  delta="${result.delta_summary}"${learningLines}`;
    const body = existing.startsWith("(no retro") ? newEntry : `${existing.trim()}\n\n${newEntry}`;
    writeFileSync(this.projectMemoryPath, this.replaceSection(content, "Retro History", body).content, "utf-8");
  }

  // ─── Exploration log ──────────────────────────────────────────
  // (11.2) Read/append to ## Exploration Log in user memory.

  readExplorationLog(): string {
    if (!existsSync(this.userMemoryPath)) return "";
    const content = readFileSync(this.userMemoryPath, "utf-8");
    return this.extractSection(content, "Exploration Log");
  }

  appendExplorationEntry(entry: { id: string; change_type: string; target: string; hypothesis: string; metric: string; proposal: string; added_at_run: number; runs_remaining: number; status: string }): void {
    if (!existsSync(this.userMemoryPath)) return;
    const content = readFileSync(this.userMemoryPath, "utf-8");
    const existing = this.extractSection(content, "Exploration Log");
    const newEntry =
      `<!-- EXP-${entry.id}: added_run=${entry.added_at_run}, ttl=${entry.runs_remaining}, status=${entry.status} -->\n` +
      `change_type=${entry.change_type}  target=${entry.target}\n` +
      `hypothesis: ${entry.hypothesis}\n` +
      `metric: ${entry.metric}\n` +
      `proposal: ${entry.proposal}`;
    const body = existing.startsWith("(no exploration") ? newEntry : `${existing.trim()}\n\n${newEntry}`;
    writeFileSync(this.userMemoryPath, this.replaceSection(content, "Exploration Log", body).content, "utf-8");
  }

  // (11.3) Append an agent observation to ## Agent Performance Log in user memory.
  appendAgentPerformanceNote(agent: string, observation: string): void {
    if (!existsSync(this.userMemoryPath)) return;
    const content = readFileSync(this.userMemoryPath, "utf-8");
    const existing = this.extractSection(content, "Agent Performance Log");
    const date = new Date().toISOString().slice(0, 10);
    const newEntry = `<!-- AGENT-NOTE: ${date} -->\nagent=${agent}: ${observation}`;
    const body = existing.startsWith("(no agent") ? newEntry : `${existing.trim()}\n\n${newEntry}`;
    writeFileSync(this.userMemoryPath, this.replaceSection(content, "Agent Performance Log", body).content, "utf-8");
  }

  // ─── Decay ────────────────────────────────────────────────────
  // (11.4) Tick TTLs for learned patterns. Patterns in TTL format expire when ttl reaches 0.
  // Returns count of expired (removed) patterns.

  tickPatternTTLs(): number {
    if (!existsSync(this.projectMemoryPath)) return 0;
    const content = readFileSync(this.projectMemoryPath, "utf-8");
    const section = this.extractSection(content, "Learned Patterns");
    if (!section || section.startsWith("(no patterns")) return 0;

    // Split into blocks (patterns joined with \n\n)
    const blocks = section.split("\n\n").filter(b => b.trim());
    let removed = 0;

    const updated = blocks.map(block => {
      const m = block.match(/<!-- PATTERN-\d+: added_run=\d+, ttl=(\d+) -->/);
      if (!m) return block;                // date-only format: no decay, keep forever
      const ttl = parseInt(m[1]);
      if (ttl <= 1) { removed++; return null; }  // expire
      return block.replace(/ttl=\d+/, `ttl=${ttl - 1}`);
    }).filter((b): b is string => b !== null);

    if (removed > 0) {
      // Re-number surviving patterns to keep IDs compact
      let idx = 1;
      const renumbered = updated.map(block =>
        block.replace(/<!-- PATTERN-\d+:/, `<!-- PATTERN-${String(idx++).padStart(3, "0")}:`),
      ).join("\n\n");
      const newBody = renumbered.trim() || "(no patterns learned yet)";
      writeFileSync(this.projectMemoryPath, this.replaceSection(content, "Learned Patterns", newBody).content, "utf-8");
    }

    return removed;
  }

  // (11.4) Tick TTLs for active exploration entries. Returns count of newly expired entries.
  tickExplorationTTLs(): number {
    if (!existsSync(this.userMemoryPath)) return 0;
    const content = readFileSync(this.userMemoryPath, "utf-8");
    const section = this.extractSection(content, "Exploration Log");
    if (!section || section.startsWith("(no exploration")) return 0;

    const blocks = section.split("\n\n").filter(b => b.trim());
    let expired = 0;

    const updated = blocks.map(block => {
      const m = block.match(/<!-- EXP-\S+: added_run=\d+, ttl=(\d+), status=(\w+) -->/);
      if (!m || m[2] !== "active") return block;  // skip non-active
      const ttl = parseInt(m[1]);
      if (ttl <= 1) {
        expired++;
        return block.replace(/ttl=\d+, status=\w+/, `ttl=0, status=expired`);
      }
      return block.replace(/ttl=\d+/, `ttl=${ttl - 1}`);
    });

    if (expired > 0) {
      writeFileSync(this.userMemoryPath, this.replaceSection(content, "Exploration Log", updated.join("\n\n")).content, "utf-8");
    }

    return expired;
  }

  // ─── Section parser ───────────────────────────────────────────
  // Extracts the body of a ## Section Name block (text between this header and the next ##).

  extractSection(content: string, sectionName: string): string {
    const headerRegex = new RegExp(`^## ${sectionName}\\s*$`, "m");
    const match = headerRegex.exec(content);
    if (!match) return "";
    const startIdx = match.index + match[0].length;
    const rest = content.slice(startIdx);
    const nextHeaderMatch = /^## /m.exec(rest);
    return (nextHeaderMatch ? rest.slice(0, nextHeaderMatch.index) : rest).trim();
  }

  replaceSection(content: string, sectionName: string, newBody: string): { content: string; modified: boolean } {
    const headerRegex = new RegExp(`^## ${sectionName}\\s*$`, "m");
    const match = headerRegex.exec(content);
    if (!match) return { content, modified: false };
    const startIdx = match.index + match[0].length;
    const rest = content.slice(startIdx);
    const nextHeaderMatch = /^## /m.exec(rest);
    const endIdx = nextHeaderMatch ? startIdx + nextHeaderMatch.index : content.length;
    return { content: content.slice(0, startIdx) + "\n" + newBody + "\n\n" + content.slice(endIdx), modified: true };
  }

  // Ensure all expected sections exist in a memory file. Appends missing sections at the end.
  ensureProjectSections(): void {
    if (!existsSync(this.projectMemoryPath)) return;
    const expected = ["Project Conventions", "Learned Patterns", "Run History", "Retro History"];
    let content = readFileSync(this.projectMemoryPath, "utf-8");
    let changed = false;
    for (const section of expected) {
      const headerRegex = new RegExp(`^## ${section}\\s*$`, "m");
      if (!headerRegex.test(content)) {
        content = content.trimEnd() + `\n\n## ${section}\n(no ${section.toLowerCase()} yet)\n`;
        changed = true;
      }
    }
    if (changed) writeFileSync(this.projectMemoryPath, content, "utf-8");
  }
}
