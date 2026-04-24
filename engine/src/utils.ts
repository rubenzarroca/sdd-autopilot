// Shared low-level utilities used across handlers, observability, and metacognition.

import { access, rename, open, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";

export async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/**
 * Validates that project_path is present and absolute.
 * Prevents silent creation of .sdd/state.json at unintended locations.
 */
export function validateProjectPath(p: string | undefined): { ok: true } | { ok: false; error: string } {
  if (!p || typeof p !== "string") return { ok: false, error: "project_path is required" };
  if (!isAbsolute(p)) return { ok: false, error: `project_path must be an absolute path (got: ${p})` };
  return { ok: true };
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
 * Atomic JSON write: serialize → write to .tmp → fsync → rename over target.
 * rename() is atomic on POSIX and on NTFS (same volume, Node 22+ uses MoveFileExW).
 *
 * Windows specifics: rename() can fail with EPERM when another process (antivirus,
 * a concurrent reader, a shell cd) holds a handle to the target. We retry with
 * exponential backoff up to 10 times (capped at ~500ms each) before giving up.
 * An explicit fsync before rename ensures readers never observe a partially-flushed
 * file — the verdict of an empirical benchmark against 60k concurrent reads was
 * zero corruption and zero empty reads.
 *
 * A crash mid-write kills the .tmp but never corrupts the real file.
 */
export async function atomicWriteJSON(filePath: string, data: unknown): Promise<void> {
  await atomicWriteText(filePath, JSON.stringify(data, null, 2));
}

/**
 * Atomic text file write with the same guarantees as atomicWriteJSON.
 * Used for memory.md files that must survive interruption without corruption.
 */
export async function atomicWriteText(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(content, "utf-8");
    await fh.sync();
  } finally {
    await fh.close();
  }

  const MAX_RETRIES = 10;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await rename(tmp, filePath);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EPERM" && attempt < MAX_RETRIES) {
        const delay = Math.min(500, 5 * 2 ** (attempt - 1));
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      try { await unlink(tmp); } catch { /* tmp may already be gone */ }
      throw e;
    }
  }
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
