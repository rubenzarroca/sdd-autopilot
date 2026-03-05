// Task parser — reads specs/{feature}/tasks.md and extracts individual TASK-NNN blocks.
// Used by runImplementStage (sequential) and runParallelWavesStage (parallel, section 8.2).

export interface ParsedTask {
  id: string;          // "TASK-001"
  title: string;       // "Create auth middleware"
  raw: string;         // full task block (injected verbatim into per-task prompt)
  dependsOn: string[]; // ["TASK-001"] | []
}

/**
 * Splits tasks.md into individual TASK-NNN entries.
 * Preserves file order — spec guarantees topological ordering, no sort needed.
 */
export function parseTasks(content: string): ParsedTask[] {
  // Split on H2 task headings; filter out the header section before TASK-001
  const blocks = content.split(/(?=^## TASK-)/m).filter(b => /^## TASK-/.test(b.trimStart()));

  return blocks.map(block => {
    const idMatch = block.match(/^## (TASK-\d+):\s*(.+)/m);
    const depsMatch = block.match(/\*\*Depends on\*\*:\s*(.+)/i);

    const id = idMatch?.[1] ?? "";
    const title = idMatch?.[2]?.trim() ?? "";
    const depsRaw = depsMatch?.[1]?.trim() ?? "none";
    const dependsOn =
      depsRaw.toLowerCase() === "none"
        ? []
        : depsRaw.split(/[,\s]+/).filter(d => /^TASK-\d+$/.test(d));

    return { id, title, raw: block.trim(), dependsOn };
  });
}

/**
 * Groups tasks into dependency waves for parallel execution.
 *
 * Wave 0: tasks with no dependencies (can run immediately).
 * Wave N: tasks whose all dependencies are satisfied by waves 0..N-1.
 * Preserves relative order within each wave (spec guarantees topological ordering).
 *
 * Star topology: waves are computed by the orchestrator, not inferred by agents.
 * Agents in a wave are independent by definition — no P2P communication needed.
 *
 * Throws if a circular dependency is detected (impossible in a valid DAG).
 */
export function computeWaves(tasks: ParsedTask[]): ParsedTask[][] {
  const waves: ParsedTask[][] = [];
  const completed = new Set<string>();
  const remaining = tasks.slice();  // shallow copy — we'll splice from this

  while (remaining.length > 0) {
    const wave = remaining.filter(t => t.dependsOn.every(dep => completed.has(dep)));

    if (wave.length === 0) {
      throw new Error(
        `[computeWaves] Circular dependency detected. Blocked tasks: ${remaining.map(t => t.id).join(", ")}`,
      );
    }

    const waveIds = new Set(wave.map(t => t.id));
    wave.forEach(t => completed.add(t.id));
    waves.push(wave);

    // Remove this wave's tasks from remaining (in-place to preserve indices)
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (waveIds.has(remaining[i].id)) remaining.splice(i, 1);
    }
  }

  return waves;
}
