// Git worktree operations — adapted from worktree-pr SKILL.md
// Converted skill instructions to TypeScript functions

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { basename, join, dirname } from "node:path";

const execAsync = promisify(exec);

async function run(cmd: string, cwd: string): Promise<string> {
  const { stdout } = await execAsync(cmd, {
    cwd,
    shell: process.platform === "win32" ? "bash" : "/bin/bash",
    timeout: 60_000,
  });
  return stdout.trim();
}

function sanitizeFeatureName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

export interface WorktreeStartResult {
  worktreePath: string;
  branchName: string;
  defaultBranch: string;
}

export async function worktreeStart(
  repoPath: string,
  featureName: string,
): Promise<WorktreeStartResult> {
  const sanitized = sanitizeFeatureName(featureName);
  const branchName = `feat/${sanitized}`;

  // Detect default branch
  let defaultBranch: string;
  try {
    defaultBranch = await run(
      "git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'",
      repoPath,
    );
  } catch {
    // Fallback: try common names
    try {
      await run("git rev-parse --verify origin/main", repoPath);
      defaultBranch = "main";
    } catch {
      defaultBranch = "master";
    }
  }

  // Pull latest
  try {
    await run(`git checkout ${defaultBranch} && git pull origin ${defaultBranch}`, repoPath);
  } catch {
    // May fail if already on the branch or no remote — continue
  }

  // Check if worktree already exists
  const worktreeList = await run("git worktree list --porcelain", repoPath);
  if (worktreeList.includes(branchName)) {
    throw new Error(`Worktree for branch "${branchName}" already exists`);
  }

  // Create worktree as sibling directory
  const repoName = basename(repoPath);
  const parentDir = dirname(repoPath);
  const worktreePath = join(parentDir, `${repoName}-${sanitized}`);

  await run(
    `git worktree add "${worktreePath}" -b ${branchName}`,
    repoPath,
  );

  // Exclude .sdd/state.json from commits
  try {
    await run(
      'echo ".sdd/state.json" >> .git/info/exclude',
      worktreePath,
    );
  } catch {
    // .git/info/exclude might not exist in worktree — safe to ignore
  }

  return { worktreePath, branchName, defaultBranch };
}

export interface WorktreeFinishResult {
  prUrl: string;
  prNumber: number;
  diffStats: string;
  branchName: string;
}

export async function worktreeFinish(
  worktreePath: string,
  featureName: string,
  specSummary?: string,
): Promise<WorktreeFinishResult> {
  const sanitized = sanitizeFeatureName(featureName);
  const branchName = `feat/${sanitized}`;

  // Verify not on default branch
  const currentBranch = await run("git rev-parse --abbrev-ref HEAD", worktreePath);
  if (currentBranch === "main" || currentBranch === "master") {
    throw new Error("Cannot finish: currently on default branch");
  }

  // Stage and commit
  await run("git add -A", worktreePath);
  try {
    await run('git reset HEAD .sdd/state.json 2>/dev/null || true', worktreePath);
  } catch { /* ignore */ }

  const commitMsg = `feat(${sanitized}): complete implementation\n\nSpec: specs/${sanitized}/spec.md\nTasks: specs/${sanitized}/tasks.md`;
  try {
    await run(`git commit -m "${commitMsg}"`, worktreePath);
  } catch {
    // May already be committed or nothing to commit
  }

  // Get diff stats
  let diffStats: string;
  try {
    const defaultBranch = await run(
      "git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'",
      worktreePath,
    ).catch(() => "main");
    diffStats = await run(`git diff --stat ${defaultBranch}...HEAD`, worktreePath);
  } catch {
    diffStats = "Unable to get diff stats";
  }

  // Push
  await run(`git push -u origin ${branchName}`, worktreePath);

  // Build PR body from spec
  let prBody: string;
  try {
    const specPath = join(worktreePath, "specs", sanitized, "spec.md");
    prBody = await readFile(specPath, "utf-8");
    if (prBody.length > 60000) {
      prBody = prBody.slice(0, 60000) + "\n\n...(truncated — see full spec in repo)";
    }
  } catch {
    prBody = `Feature: ${featureName}\n\n${specSummary ?? "Implemented via SDD Autopilot."}`;
  }

  // Create PR
  const prTitle = `feat(${sanitized}): ${featureName.slice(0, 60)}`;
  const prOutput = await run(
    `gh pr create --title "${prTitle}" --body "$(cat <<'PREOF'\n${prBody}\nPREOF\n)"`,
    worktreePath,
  );

  // Parse PR URL and number from gh output
  const prUrl = prOutput.trim();
  const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
  const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : 0;

  return { prUrl, prNumber, diffStats, branchName };
}

export async function worktreeCleanup(
  repoPath: string,
  featureName: string,
): Promise<void> {
  const sanitized = sanitizeFeatureName(featureName);
  const repoName = basename(repoPath);
  const parentDir = dirname(repoPath);
  const worktreePath = join(parentDir, `${repoName}-${sanitized}`);
  const branchName = `feat/${sanitized}`;

  try {
    await run(`git worktree remove "${worktreePath}" --force`, repoPath);
  } catch { /* may not exist */ }

  try {
    await run(`git branch -d ${branchName}`, repoPath);
  } catch { /* may not exist */ }
}
