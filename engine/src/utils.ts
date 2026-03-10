// Shared low-level utilities used across handlers, observability, and metacognition.

import { access, writeFile, rename, open } from "node:fs/promises";

export async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/**
 * Parse JSONL content with tolerance for corrupted lines (e.g. from crash mid-append).
 * Corrupted lines are skipped and a warning is logged.
 */
export function parseJsonl<T>(raw: string, filePath?: string): T[] {
  const lines = raw.split("\n").filter(l => l.trim() !== "");
  const data: T[] = [];
  let corrupted = 0;
  for (const line of lines) {
    try {
      data.push(JSON.parse(line) as T);
    } catch {
      corrupted++;
    }
  }
  if (corrupted > 0) {
    console.warn(`[SDD] ${filePath ?? "JSONL"}: ${corrupted} corrupted line(s) skipped`);
  }
  return data;
}

/**
 * Atomic JSON write: serialize → write to .tmp → rename over target.
 * rename() on the same filesystem is atomic on POSIX.
 * A crash mid-write kills the .tmp but never corrupts the real file.
 */
export async function atomicWriteJSON(filePath: string, data: unknown): Promise<void> {
  const tmp = filePath + ".tmp";
  const serialized = JSON.stringify(data, null, 2);
  await writeFile(tmp, serialized, "utf-8");
  await rename(tmp, filePath);
}

/**
 * Atomic append of a single JSON line to a JSONL file.
 * Opens in append mode, writes the line, then datasync to flush to disk.
 * A single write of <4KB in append mode is atomic on POSIX (PIPE_BUF guarantee).
 */
export async function atomicAppendJSONL(filePath: string, data: unknown): Promise<void> {
  const line = JSON.stringify(data) + "\n";
  const fd = await open(filePath, "a");
  try {
    await fd.write(line);
    await fd.datasync();
  } finally {
    await fd.close();
  }
}
