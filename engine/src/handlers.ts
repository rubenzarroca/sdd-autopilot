// Handler registry — executes PTC tool calls against the filesystem and shell
// Adapted from ptc-code-patterns.md handler registry pattern

import { readFile, writeFile, readdir, mkdir, stat } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { StateJson } from "./types.js";

const execAsync = promisify(exec);

// ─── Types ───────────────────────────────────────────────────────

export interface ToolResult {
  data: unknown;
  metadata: {
    tool: string;
    timestamp: string;
  };
}

type HandlerFn = (
  params: Record<string, unknown>,
  ctx: HandlerContext,
) => Promise<{ data: unknown }>;

export interface HandlerContext {
  projectPath: string;
}

// ─── Path resolution ─────────────────────────────────────────────

function resolvePath(filePath: string, projectPath: string): string {
  if (isAbsolute(filePath)) return filePath;
  return resolve(projectPath, filePath);
}

// ─── Handler implementations ─────────────────────────────────────

async function handleReadFile(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<{ data: unknown }> {
  const filePath = resolvePath(params.path as string, ctx.projectPath);
  try {
    const content = await readFile(filePath, "utf-8");
    return { data: { content, path: filePath } };
  } catch (err) {
    return { data: { error: `Failed to read ${filePath}: ${(err as Error).message}` } };
  }
}

async function handleWriteFile(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<{ data: unknown }> {
  const filePath = resolvePath(params.path as string, ctx.projectPath);
  const content = params.content as string;
  try {
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, content, "utf-8");
    return { data: { success: true, path: filePath } };
  } catch (err) {
    return { data: { error: `Failed to write ${filePath}: ${(err as Error).message}` } };
  }
}

async function handleEditFile(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<{ data: unknown }> {
  const filePath = resolvePath(params.path as string, ctx.projectPath);
  const oldString = params.old_string as string;
  const newString = params.new_string as string;
  try {
    const content = await readFile(filePath, "utf-8");
    const count = content.split(oldString).length - 1;
    if (count === 0) {
      return { data: { error: `old_string not found in ${filePath}` } };
    }
    if (count > 1) {
      return { data: { error: `old_string found ${count} times in ${filePath}. Must be unique.` } };
    }
    const updated = content.replace(oldString, newString);
    await writeFile(filePath, updated, "utf-8");
    return { data: { success: true, path: filePath } };
  } catch (err) {
    return { data: { error: `Failed to edit ${filePath}: ${(err as Error).message}` } };
  }
}

async function handleListDir(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<{ data: unknown }> {
  const dirPath = resolvePath((params.path as string) || ".", ctx.projectPath);
  const recursive = params.recursive as boolean ?? false;

  async function listRecursive(dir: string, prefix: string): Promise<string[]> {
    const entries: string[] = [];
    try {
      const items = await readdir(dir, { withFileTypes: true });
      for (const item of items) {
        if (item.name === "node_modules" || item.name === ".git") continue;
        const fullPath = join(prefix, item.name);
        if (item.isDirectory()) {
          entries.push(fullPath + "/");
          if (recursive) {
            entries.push(...await listRecursive(join(dir, item.name), fullPath));
          }
        } else {
          entries.push(fullPath);
        }
      }
    } catch (err) {
      entries.push(`[error reading ${dir}: ${(err as Error).message}]`);
    }
    return entries;
  }

  const entries = await listRecursive(dirPath, "");
  return { data: { entries, path: dirPath } };
}

async function handleReadState(
  _params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<{ data: unknown }> {
  const statePath = join(ctx.projectPath, ".sdd", "state.json");
  try {
    const raw = await readFile(statePath, "utf-8");
    return { data: JSON.parse(raw) };
  } catch (err) {
    return { data: { error: `Failed to read state: ${(err as Error).message}` } };
  }
}

async function handleWriteState(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<{ data: unknown }> {
  const statePath = join(ctx.projectPath, ".sdd", "state.json");
  const updates = params.updates as Record<string, unknown>;
  try {
    let state: StateJson;
    try {
      const raw = await readFile(statePath, "utf-8");
      state = JSON.parse(raw);
    } catch {
      return { data: { error: "state.json does not exist. Run init first." } };
    }
    // Deep merge updates
    Object.assign(state, updates);
    await mkdir(join(statePath, ".."), { recursive: true });
    await writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");
    return { data: { success: true } };
  } catch (err) {
    return { data: { error: `Failed to write state: ${(err as Error).message}` } };
  }
}

async function handleRunShell(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<{ data: unknown }> {
  const command = params.command as string;
  const cwd = params.cwd ? resolvePath(params.cwd as string, ctx.projectPath) : ctx.projectPath;
  const timeoutMs = (params.timeout_ms as number) ?? 120_000;

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      shell: process.platform === "win32" ? "bash" : "/bin/bash",
    });
    return { data: { stdout: stdout.trim(), stderr: stderr.trim(), exit_code: 0 } };
  } catch (err: any) {
    return {
      data: {
        stdout: err.stdout?.trim() ?? "",
        stderr: err.stderr?.trim() ?? "",
        exit_code: err.code ?? 1,
        error: err.message,
      },
    };
  }
}

async function handleSearchCode(
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<{ data: unknown }> {
  const pattern = params.pattern as string;
  const searchPath = params.path ? resolvePath(params.path as string, ctx.projectPath) : ctx.projectPath;
  const glob = params.glob as string | undefined;

  const globArg = glob ? `--glob "${glob}"` : "";
  const command = `rg --line-number --no-heading ${globArg} "${pattern.replace(/"/g, '\\"')}" "${searchPath}" 2>/dev/null || grep -rn "${pattern.replace(/"/g, '\\"')}" "${searchPath}" ${glob ? `--include="${glob}"` : ""} 2>/dev/null || echo "No matches found"`;

  try {
    const { stdout } = await execAsync(command, {
      cwd: ctx.projectPath,
      timeout: 30_000,
      maxBuffer: 5 * 1024 * 1024,
      shell: process.platform === "win32" ? "bash" : "/bin/bash",
    });
    const lines = stdout.trim().split("\n").slice(0, 100); // Cap at 100 matches
    return { data: { matches: lines, count: lines.length } };
  } catch {
    return { data: { matches: [], count: 0 } };
  }
}

// ─── Registry ────────────────────────────────────────────────────

const handlers: Record<string, HandlerFn> = {
  read_file: handleReadFile,
  write_file: handleWriteFile,
  edit_file: handleEditFile,
  list_dir: handleListDir,
  read_state: handleReadState,
  write_state: handleWriteState,
  run_shell: handleRunShell,
  search_code: handleSearchCode,
};

// ─── Central executor ────────────────────────────────────────────

export async function executeToolCall(
  name: string,
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<ToolResult> {
  const handler = handlers[name];
  if (!handler) {
    return {
      data: { error: `Unknown tool: "${name}"` },
      metadata: { tool: name, timestamp: new Date().toISOString() },
    };
  }

  try {
    const raw = await handler(params, ctx);
    return {
      data: raw.data,
      metadata: { tool: name, timestamp: new Date().toISOString() },
    };
  } catch (err) {
    return {
      data: { error: err instanceof Error ? err.message : String(err) },
      metadata: { tool: name, timestamp: new Date().toISOString() },
    };
  }
}
