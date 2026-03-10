#!/usr/bin/env python3
"""
SDD Autopilot — Skill Evaluation Framework

Evaluates skills as WORKFLOW/PREFERENCE type (sequencing steps the model already knows).
Criteria: trigger accuracy, step completeness, edge case coverage, instruction clarity, context efficiency.
"""

import sys
import os
import re
import json
import yaml
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional

# ──────────────────────────────────────────────
# Data structures
# ──────────────────────────────────────────────

@dataclass
class Finding:
    severity: str   # "critical", "warning", "info"
    category: str   # e.g. "trigger", "edge_case", "clarity", "efficiency"
    message: str
    location: str = ""  # e.g. "auto-init:step3"

@dataclass
class SkillEvalResult:
    name: str
    skill_type: str  # "workflow" | "capability"
    findings: list = field(default_factory=list)
    scores: dict = field(default_factory=dict)  # category -> 0-100

    @property
    def passed(self):
        return not any(f.severity == "critical" for f in self.findings)

    @property
    def total_score(self):
        if not self.scores:
            return 0
        return round(sum(self.scores.values()) / len(self.scores))

# ──────────────────────────────────────────────
# Parsers
# ──────────────────────────────────────────────

def parse_skill(skill_path: Path) -> tuple[dict, str]:
    """Parse SKILL.md into frontmatter dict and body string."""
    content = (skill_path / "SKILL.md").read_text(encoding="utf-8")
    match = re.match(r"^---\n(.*?)\n---\n?(.*)", content, re.DOTALL)
    if not match:
        raise ValueError(f"No valid frontmatter in {skill_path}/SKILL.md")
    fm = yaml.safe_load(match.group(1))
    body = match.group(2)
    return fm, body

# ──────────────────────────────────────────────
# Eval checks — structural
# ──────────────────────────────────────────────

def check_frontmatter(fm: dict, body: str, name: str) -> list[Finding]:
    findings = []

    # Required fields
    if "name" not in fm:
        findings.append(Finding("critical", "structure", "Missing 'name' in frontmatter", f"{name}:frontmatter"))
    if "description" not in fm:
        findings.append(Finding("critical", "structure", "Missing 'description' in frontmatter", f"{name}:frontmatter"))

    # Description quality for trigger accuracy
    desc = fm.get("description", "")
    if len(desc) < 50:
        findings.append(Finding("warning", "trigger", f"Description too short ({len(desc)} chars) — may miss triggers", f"{name}:frontmatter"))
    if len(desc) > 1024:
        findings.append(Finding("critical", "trigger", f"Description exceeds 1024 chars ({len(desc)})", f"{name}:frontmatter"))

    # Check trigger phrases in description
    trigger_patterns = [r"[Uu]se when", r"[Tt]rigger", r"[Rr]uns? /", r'says? "']
    trigger_count = sum(1 for p in trigger_patterns if re.search(p, desc))
    if trigger_count == 0:
        findings.append(Finding("warning", "trigger", "Description has no trigger phrases (Use when, says, etc.)", f"{name}:frontmatter"))
    elif trigger_count >= 2:
        findings.append(Finding("info", "trigger", f"Good trigger coverage ({trigger_count} phrases)", f"{name}:frontmatter"))

    # Unexpected keys
    allowed = {"name", "description", "license", "allowed-tools", "metadata", "compatibility", "argument-hint", "user-invokable"}
    unexpected = set(fm.keys()) - allowed
    if unexpected:
        findings.append(Finding("warning", "structure", f"Unexpected frontmatter keys: {unexpected}", f"{name}:frontmatter"))

    return findings

# ──────────────────────────────────────────────
# Eval checks — canonical structure
# ──────────────────────────────────────────────

def check_structure(body: str, fm: dict, name: str, skill_path: Path) -> list[Finding]:
    """Verify canonical SKILL.md structure for workflow skills."""
    findings = []

    # Check for H1 title
    h1_match = re.search(r"^# .+", body, re.MULTILINE)
    if h1_match:
        findings.append(Finding("info", "structure", f"Has H1 title: {h1_match.group()[:60]}", f"{name}:body"))
    else:
        findings.append(Finding("warning", "structure", "Missing H1 title", f"{name}:body"))

    # Check for H2 section headers (canonical structure)
    h2_headers = re.findall(r"^## (.+)", body, re.MULTILINE)
    if len(h2_headers) >= 2:
        findings.append(Finding("info", "structure", f"Has {len(h2_headers)} H2 sections: {', '.join(h2_headers[:6])}", f"{name}:body"))
    else:
        findings.append(Finding("warning", "structure", f"Only {len(h2_headers)} H2 sections — workflow skills need >= 2", f"{name}:body"))

    # Check for "What to do" or equivalent workflow header
    workflow_headers = [h for h in h2_headers if any(kw in h.lower() for kw in ["what to do", "steps", "workflow", "process", "how to"])]
    if workflow_headers:
        findings.append(Finding("info", "structure", f"Has workflow section: '{workflow_headers[0]}'", f"{name}:body"))
    else:
        # Check for numbered steps even without explicit header
        has_steps = bool(re.search(r"^\d+\.\s+\*\*", body, re.MULTILINE))
        if has_steps:
            findings.append(Finding("info", "structure", "Has numbered workflow steps (no explicit section header)", f"{name}:body"))
        else:
            findings.append(Finding("warning", "structure", "No workflow section header or numbered steps", f"{name}:body"))

    # Check for error handling section or inline error mentions
    error_section = any("error" in h.lower() or "fail" in h.lower() or "edge case" in h.lower() for h in h2_headers)
    if error_section:
        findings.append(Finding("info", "structure", "Has dedicated error/edge case section", f"{name}:body"))

    # Check for output format section or code examples showing expected output
    output_headers = [h for h in h2_headers if any(kw in h.lower() for kw in ["output", "report", "format", "communication"])]
    output_blocks = re.findall(r"```\n[^`]*(?:report|output|status|summary)[^`]*```", body, re.I | re.DOTALL)
    if output_headers or output_blocks:
        findings.append(Finding("info", "structure", "Has output format specification", f"{name}:body"))

    # Check references/ or docs/ exist if body is large
    words = len(body.split())
    has_refs = (skill_path / "references").exists() or any(
        re.findall(r"(?:references|docs)/\w+\.md", body)
    )
    if words > 3000 and has_refs:
        findings.append(Finding("info", "structure", "Large skill with reference files — good progressive disclosure", f"{name}:body"))
    elif words > 5000 and not has_refs:
        findings.append(Finding("warning", "structure", "Large skill (>5000 words) without reference files", f"{name}:body"))

    return findings

# ──────────────────────────────────────────────
# Eval checks — workflow specific
# ──────────────────────────────────────────────

def check_workflow_steps(body: str, name: str) -> list[Finding]:
    """Evaluate workflow step quality for workflow/preference skills."""
    findings = []

    # Extract numbered steps (e.g., "1.", "2.", "3b.")
    steps = re.findall(r"^(\d+[a-z]?)\.\s+\*\*(.+?)\*\*", body, re.MULTILINE)
    if not steps:
        # Also try without bold
        steps = re.findall(r"^(\d+[a-z]?)\.\s+(.+)", body, re.MULTILINE)

    if len(steps) == 0:
        findings.append(Finding("critical", "completeness", "No numbered workflow steps found", f"{name}:body"))
        return findings

    findings.append(Finding("info", "completeness", f"Found {len(steps)} workflow steps", f"{name}:body"))

    # Check step numbering continuity
    step_nums = [s[0] for s in steps]
    main_nums = sorted(set(int(re.match(r"\d+", s).group()) for s in step_nums))
    expected = list(range(main_nums[0], main_nums[-1] + 1))
    missing = set(expected) - set(main_nums)
    if missing:
        findings.append(Finding("warning", "completeness", f"Possibly missing step numbers: {sorted(missing)}", f"{name}:steps"))

    # Check for error handling keywords
    error_keywords = ["error", "fail", "not found", "not exist", "missing", "invalid", "crash", "exception"]
    error_mentions = sum(1 for kw in error_keywords if kw.lower() in body.lower())
    if error_mentions < 2:
        findings.append(Finding("warning", "edge_cases", f"Low error handling coverage ({error_mentions} mentions)", f"{name}:body"))
    else:
        findings.append(Finding("info", "edge_cases", f"Good error handling coverage ({error_mentions} mentions)", f"{name}:body"))

    # Check for conditional branching
    conditional_patterns = [r"[Ii]f .+:", r"[Oo]therwise", r"[Ee]lse", r"- If ", r"when .+ exist"]
    conditional_count = sum(len(re.findall(p, body)) for p in conditional_patterns)
    if conditional_count < 2:
        findings.append(Finding("warning", "edge_cases", f"Low conditional branching ({conditional_count} branches) — may miss scenarios", f"{name}:body"))

    return findings

def check_edge_case_coverage(body: str, name: str, test_cases: list[dict]) -> list[Finding]:
    """Check if documented behavior covers expected test cases."""
    findings = []

    for tc in test_cases:
        scenario = tc["scenario"]
        expected_keywords = tc["expected_keywords"]
        matched = [kw for kw in expected_keywords if kw.lower() in body.lower()]
        coverage = len(matched) / len(expected_keywords) if expected_keywords else 1.0

        if coverage < 0.5:
            findings.append(Finding(
                "warning", "edge_cases",
                f"Scenario '{scenario}' — low coverage ({coverage:.0%}), missing: {set(expected_keywords) - set(matched)}",
                f"{name}:edge_case"
            ))
        elif coverage < 1.0:
            findings.append(Finding(
                "info", "edge_cases",
                f"Scenario '{scenario}' — partial coverage ({coverage:.0%})",
                f"{name}:edge_case"
            ))
        else:
            findings.append(Finding(
                "info", "edge_cases",
                f"Scenario '{scenario}' — full coverage",
                f"{name}:edge_case"
            ))

    return findings

# ──────────────────────────────────────────────
# Eval checks — clarity & efficiency
# ──────────────────────────────────────────────

def check_clarity(body: str, name: str) -> list[Finding]:
    findings = []

    # Check for ambiguous language
    ambiguous = ["might", "could potentially", "maybe", "possibly", "you may want to", "consider"]
    ambiguous_found = [(a, len(re.findall(r"\b" + re.escape(a) + r"\b", body, re.I))) for a in ambiguous]
    total_ambiguous = sum(c for _, c in ambiguous_found if c > 0)
    if total_ambiguous > 5:
        details = ", ".join(f'"{a}"×{c}' for a, c in ambiguous_found if c > 0)
        findings.append(Finding("warning", "clarity", f"High ambiguity ({total_ambiguous} instances): {details}", f"{name}:body"))

    # Check for imperative verbs (good for workflow skills)
    imperative_starts = re.findall(r"^\d+[a-z]?\.\s+\*\*([A-Z][a-z]+)", body, re.MULTILINE)
    if imperative_starts:
        findings.append(Finding("info", "clarity", f"Step verbs: {', '.join(imperative_starts[:8])}", f"{name}:body"))

    # Check for code blocks (structured output examples)
    code_blocks = re.findall(r"```(\w*)\n", body)
    if code_blocks:
        findings.append(Finding("info", "clarity", f"Has {len(code_blocks)} code examples ({', '.join(set(code_blocks))})", f"{name}:body"))
    else:
        findings.append(Finding("warning", "clarity", "No code examples — workflow may be ambiguous for structured output", f"{name}:body"))

    return findings

def check_efficiency(body: str, fm: dict, name: str) -> list[Finding]:
    findings = []

    # Word count
    words = len(body.split())
    if words > 5000:
        findings.append(Finding("warning", "efficiency", f"Body is {words} words — may waste context window (target <5000)", f"{name}:body"))
    elif words > 3000:
        findings.append(Finding("info", "efficiency", f"Body is {words} words — moderate size", f"{name}:body"))
    else:
        findings.append(Finding("info", "efficiency", f"Body is {words} words — lean", f"{name}:body"))

    # Line count
    lines = body.count("\n")
    if lines > 500:
        findings.append(Finding("warning", "efficiency", f"Body is {lines} lines — consider splitting into references/", f"{name}:body"))

    # Check for redundancy (repeated phrases 3+ times)
    sentences = re.split(r"[.!?\n]", body)
    seen_phrases = {}
    for s in sentences:
        s = s.strip().lower()
        if len(s) > 30:
            key = s[:40]
            seen_phrases[key] = seen_phrases.get(key, 0) + 1
    repeated = {k: v for k, v in seen_phrases.items() if v >= 3}
    if repeated:
        findings.append(Finding("warning", "efficiency", f"Repeated phrases: {list(repeated.keys())[:3]}", f"{name}:body"))

    return findings

# ──────────────────────────────────────────────
# Eval checks — MCP tool references
# ──────────────────────────────────────────────

def check_tool_references(body: str, name: str) -> list[Finding]:
    """Check that MCP tool calls in the skill are well-formed."""
    findings = []

    # Find all MCP tool references
    tools = re.findall(r"mcp__[\w]+__[\w]+", body)
    unique_tools = set(tools)

    if unique_tools:
        findings.append(Finding("info", "completeness", f"References {len(unique_tools)} MCP tools: {', '.join(sorted(unique_tools)[:10])}", f"{name}:body"))

    # Check for tool calls without clear context
    for tool in unique_tools:
        # Find first usage
        idx = body.find(tool)
        context = body[max(0, idx - 100):idx + len(tool) + 100]
        if "call" not in context.lower() and "invoke" not in context.lower() and "run" not in context.lower():
            findings.append(Finding("info", "clarity", f"Tool '{tool}' referenced without explicit call instruction", f"{name}:body"))

    return findings

# ──────────────────────────────────────────────
# Test case definitions per skill
# ──────────────────────────────────────────────

TEST_CASES = {
    "auto-init": [
        {
            "scenario": "Project already initialized",
            "expected_keywords": ["already", "exist", "not overwrite", "skip"],
            "description": "When .sdd/state.json exists, should NOT overwrite"
        },
        {
            "scenario": "Node.js project detection",
            "expected_keywords": ["package.json", "node", "typescript", "scripts"],
            "description": "Should detect Node.js stack from package.json"
        },
        {
            "scenario": "Python project detection",
            "expected_keywords": ["requirements.txt", "pyproject.toml", "python"],
            "description": "Should detect Python stack"
        },
        {
            "scenario": "No stack detected",
            "expected_keywords": ["unknown", "none found"],
            "description": "Should handle projects with no recognizable stack"
        },
        {
            "scenario": "CLAUDE.md already exists",
            "expected_keywords": ["already exists", "skip", "not modify"],
            "description": "Should NOT overwrite existing CLAUDE.md"
        },
        {
            "scenario": "Specs directory creation",
            "expected_keywords": ["specs", "create", "prd-template"],
            "description": "Should create specs/ dir and prd-template.md"
        },
        {
            "scenario": "Custom project path via arguments",
            "expected_keywords": ["arguments", "path", "current working"],
            "description": "Should accept custom path or use CWD"
        },
    ],
    "auto-status": [
        {
            "scenario": "No SDD state found",
            "expected_keywords": ["not found", "init", "first"],
            "description": "Should report missing state and suggest init"
        },
        {
            "scenario": "No features yet",
            "expected_keywords": ["no features", "run"],
            "description": "Should report empty state and suggest auto-run"
        },
        {
            "scenario": "Active feature in progress",
            "expected_keywords": ["active feature", "state", "tasks", "verification"],
            "description": "Should show active feature with progress"
        },
        {
            "scenario": "Feature with PR awaiting merge",
            "expected_keywords": ["pr", "merge", "awaiting", "pr_created"],
            "description": "Should show PR status for features awaiting merge"
        },
        {
            "scenario": "Escalated feature",
            "expected_keywords": ["escalated", "completed"],
            "description": "Should show escalated features as completed with ✗"
        },
        {
            "scenario": "Score history with <3 runs",
            "expected_keywords": ["not enough", "baseline", "need 3"],
            "description": "Should show score history without golden baseline"
        },
        {
            "scenario": "Score history with 3+ runs (golden baseline)",
            "expected_keywords": ["golden", "weighted", "trend", "delta"],
            "description": "Should compute and display golden baseline"
        },
        {
            "scenario": "Spec TL;DR extraction",
            "expected_keywords": ["spec", "scope", "key decisions", "out of scope", "risk"],
            "description": "Should extract TL;DR from spec file"
        },
        {
            "scenario": "Missing spec file",
            "expected_keywords": ["skip", "doesn't exist", "unreadable"],
            "description": "Should skip TL;DR if spec file is missing"
        },
        {
            "scenario": "Complexity multipliers in golden",
            "expected_keywords": ["trivial", "0.6", "low", "0.8", "medium", "1.0", "high", "1.2", "critical", "1.4"],
            "description": "Should document all complexity multipliers"
        },
    ],
    "auto-run": [
        {
            "scenario": "Empty arguments",
            "expected_keywords": ["empty", "ask", "what feature"],
            "description": "Should ask user for feature description if empty"
        },
        {
            "scenario": "Auto-initialize uninitialized project",
            "expected_keywords": ["auto-init", "not initialized", "silently", "state.json"],
            "description": "Should auto-init if project not initialized"
        },
        {
            "scenario": "Auto-recover interrupted run",
            "expected_keywords": ["recover", "incomplete", "interrupted", "compaction"],
            "description": "Should detect and recover from incomplete runs"
        },
        {
            "scenario": "Transition UNAUTHORIZED error",
            "expected_keywords": ["unauthorized", "log", "correct agent", "delegation table"],
            "description": "Should handle UNAUTHORIZED by finding correct agent"
        },
        {
            "scenario": "Transition CIRCUIT_BREAKER error",
            "expected_keywords": ["circuit_breaker", "escalate", "not retry"],
            "description": "Should escalate immediately on circuit breaker"
        },
        {
            "scenario": "NEVER edit state.json directly",
            "expected_keywords": ["never edit", "bypass", "single source of truth"],
            "description": "Should prohibit direct state.json edits for transitions"
        },
        {
            "scenario": "Agent delegation correctness",
            "expected_keywords": ["spec-generator", "plan-architect", "task-decomposer", "implementation-engine", "verification-engine"],
            "description": "Should reference all 5 pipeline agents"
        },
        {
            "scenario": "Pair review opt-in only",
            "expected_keywords": ["pair-review", "flag", "opus-coach"],
            "description": "Should only run pair review when --pair-review flag is set"
        },
        {
            "scenario": "PR merged cleanup",
            "expected_keywords": ["merged", "worktree", "cleanup"],
            "description": "Should detect merged PRs and clean worktrees"
        },
        {
            "scenario": "Memory recovery for lost writes",
            "expected_keywords": ["memory", "recovery", "lost writes", "run_id"],
            "description": "Should recover memory entries lost to context compaction"
        },
        {
            "scenario": "Review phase delegates to /code-review",
            "expected_keywords": ["code-review", "plugin", "not adversarial"],
            "description": "Should use /code-review plugin, not adversarial-reviewer"
        },
        {
            "scenario": "Worktree path propagation",
            "expected_keywords": ["worktree_path", "worktree"],
            "description": "Should pass worktree_path to all subagents"
        },
    ],
}

# ──────────────────────────────────────────────
# Score calculator
# ──────────────────────────────────────────────

def compute_scores(findings: list[Finding]) -> dict[str, int]:
    """Compute scores per category from findings."""
    categories = {"trigger", "completeness", "edge_cases", "clarity", "efficiency", "structure"}
    scores = {}

    for cat in categories:
        cat_findings = [f for f in findings if f.category == cat]
        if not cat_findings:
            scores[cat] = 80  # default if no checks run
            continue

        score = 100
        for f in cat_findings:
            if f.severity == "critical":
                score -= 30
            elif f.severity == "warning":
                score -= 10
        scores[cat] = max(0, min(100, score))

    return scores

# ──────────────────────────────────────────────
# Main runner
# ──────────────────────────────────────────────

def evaluate_skill(skill_dir: Path) -> SkillEvalResult:
    """Run full evaluation on a single skill."""
    fm, body = parse_skill(skill_dir)
    name = skill_dir.name

    # For edge case coverage, also search referenced docs/ and references/ files
    full_text = body
    for ref_dir_name in ["references", "docs"]:
        ref_dir = skill_dir / ref_dir_name
        if ref_dir.exists():
            for f in ref_dir.glob("*.md"):
                full_text += "\n" + f.read_text(encoding="utf-8")
    # Also check repo-level docs/ for shared references (including subdirs)
    repo_docs = skill_dir.parent.parent / "docs"
    if repo_docs.exists():
        for f in repo_docs.glob("**/*.md"):
            full_text += "\n" + f.read_text(encoding="utf-8")

    result = SkillEvalResult(name=name, skill_type="workflow")
    test_cases = TEST_CASES.get(name, [])

    # Run all checks
    # body = SKILL.md only (for efficiency/clarity checks)
    # full_text = SKILL.md + all referenced docs (for edge case coverage)
    result.findings.extend(check_frontmatter(fm, body, name))
    result.findings.extend(check_structure(body, fm, name, skill_dir))
    result.findings.extend(check_workflow_steps(full_text, name))
    result.findings.extend(check_edge_case_coverage(full_text, name, test_cases))
    result.findings.extend(check_clarity(body, name))
    result.findings.extend(check_efficiency(body, fm, name))
    result.findings.extend(check_tool_references(full_text, name))

    # Compute scores
    result.scores = compute_scores(result.findings)
    return result

def print_result(result: SkillEvalResult):
    """Pretty-print evaluation results."""
    status = "PASS" if result.passed else "FAIL"
    print(f"\n{'='*60}")
    print(f"  {result.name} -- {status} -- Score: {result.total_score}/100")
    print(f"  Type: {result.skill_type}")
    print(f"{'='*60}")

    # Scores
    print("\n  Scores:")
    for cat, score in sorted(result.scores.items()):
        filled = score // 5
        bar = "#" * filled + "." * (20 - filled)
        print(f"    {cat:15s} [{bar}] {score:3d}")

    # Findings by severity
    for sev in ["critical", "warning", "info"]:
        items = [f for f in result.findings if f.severity == sev]
        if items:
            icon = {"critical": "X", "warning": "!", "info": "-"}[sev]
            print(f"\n  {sev.upper()} ({len(items)}):")
            for f in items:
                loc = f" [{f.location}]" if f.location else ""
                print(f"    {icon} {f.message}{loc}")

def main():
    skills_dir = Path(__file__).parent.parent / "skills"

    if not skills_dir.exists():
        print(f"Skills directory not found: {skills_dir}")
        sys.exit(1)

    skill_dirs = sorted(d for d in skills_dir.iterdir() if d.is_dir() and (d / "SKILL.md").exists())

    if not skill_dirs:
        print("No skills found.")
        sys.exit(1)

    results = []
    for sd in skill_dirs:
        try:
            result = evaluate_skill(sd)
            results.append(result)
            print_result(result)
        except Exception as e:
            print(f"\n  ERROR evaluating {sd.name}: {e}")

    # Summary
    print(f"\n{'='*60}")
    print("  SUMMARY")
    print(f"{'='*60}")
    total = len(results)
    passed = sum(1 for r in results if r.passed)
    avg_score = round(sum(r.total_score for r in results) / total) if total else 0
    print(f"  Skills: {passed}/{total} passed | Avg score: {avg_score}/100")

    for r in results:
        status = "PASS" if r.passed else "FAIL"
        crits = sum(1 for f in r.findings if f.severity == "critical")
        warns = sum(1 for f in r.findings if f.severity == "warning")
        print(f"    {r.name:20s} {status:4s}  {r.total_score:3d}/100  ({crits} critical, {warns} warnings)")

    # JSON output
    json_path = Path(__file__).parent / "results.json"
    json_results = []
    for r in results:
        json_results.append({
            "name": r.name,
            "type": r.skill_type,
            "passed": r.passed,
            "total_score": r.total_score,
            "scores": r.scores,
            "findings": [{"severity": f.severity, "category": f.category, "message": f.message, "location": f.location} for f in r.findings]
        })
    json_path.write_text(json.dumps(json_results, indent=2))
    print(f"\n  Results saved to: {json_path}")

    sys.exit(0 if all(r.passed for r in results) else 1)

if __name__ == "__main__":
    main()
