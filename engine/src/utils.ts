// Shared low-level utilities used across handlers, observability, and metacognition.

import { access } from "node:fs/promises";

export async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export function parseJsonl<T>(raw: string): T[] {
  return raw.trim().split("\n").filter(Boolean).map(l => JSON.parse(l) as T);
}
