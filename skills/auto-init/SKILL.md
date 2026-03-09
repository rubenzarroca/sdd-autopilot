---
name: sdd-auto:init
description: >
  Initialize a project for SDD Autopilot. Creates .sdd/state.json with the autopilot state machine,
  scaffolds constitution.md, CLAUDE.md (if not exists), and specs/prd-template.md.
  Use when the user says "init sdd", "setup autopilot", "initialize project for sdd",
  or runs /sdd-auto:init.
argument-hint: '[project_path]'
user-invokable: true
---

# /sdd-auto:init — SDD Autopilot Initializer

You initialize a project for SDD Autopilot by creating the required configuration files and scaffolding useful templates.

## What to do

1. **Determine project path**: Use `$ARGUMENTS` if provided, otherwise use the current working directory.

2. **Check existing state**: Call `mcp__sdd-autopilot__sdd_get_state` with the project path.
   - If state.json already exists: report "Project already initialized at {path}" and show current state. Do NOT overwrite.
   - If not initialized: continue to step 3.

3. **Auto-detect project stack**: Read files in the project root to detect:
   - `package.json` → Node.js/TypeScript. Extract: name, scripts (test, dev, build, lint), dependencies
   - `requirements.txt` / `pyproject.toml` → Python. Extract: project name, test framework
   - `Cargo.toml` → Rust. Extract: package name, test command
   - `go.mod` → Go. Extract: module name
   - `pom.xml` / `build.gradle` → Java/Kotlin
   - If none found: set stack to "unknown"

   Also detect:
   - Test framework: check for jest.config, vitest.config, pytest.ini, .mocharc, etc.
   - Linter: check for .eslintrc, .prettierrc, biome.json, ruff.toml, etc.
   - Directory structure: run `ls` on the project root to get top-level layout

4. **Create `.sdd/state.json`**:
   ```json
   {
     "version": "2.0.0",
     "project": "{detected_project_name}",
     "initialized_at": "{ISO timestamp}",
     "active_feature": null,
     "features": {}
   }
   ```

5. **Create `constitution.md`** (at project root, NOT inside .sdd):
   ```markdown
   # Constitution

   ## Project
   - **Name**: {detected_project_name}
   - **Stack**: {detected_stack}
   - **Description**: [TODO: describe what this project does]

   ## Principles
   <!-- Add at least 3 non-negotiable principles for this project -->
   - [TODO: e.g., "All API endpoints must be authenticated"]
   - [TODO: e.g., "No direct database queries outside the repository layer"]
   - [TODO: e.g., "Every user-facing string must be internationalized"]

   ## Conventions
   - **Test framework**: {detected_test_framework or "[TODO: specify]"}
   - **Linter**: {detected_linter or "[TODO: specify]"}
   - **Directory structure**: {brief auto-generated overview}
   ```

6. **Create `CLAUDE.md`** (at project root) — ONLY if it does NOT already exist:
   ```markdown
   # CLAUDE.md

   ## Build & Test
   - Install: `{detected_install_command or "[TODO]"}`
   - Dev: `{detected_dev_command or "[TODO]"}`
   - Test: `{detected_test_command or "[TODO]"}`
   - Lint: `{detected_lint_command or "[TODO]"}`

   ## Architecture
   {brief auto-generated overview from directory structure listing}
   ```
   If CLAUDE.md already exists, do NOT modify it. Report: "CLAUDE.md already exists, skipping."

7. **Create `specs/prd-template.md`**:
   ```markdown
   # Product Requirements Document

   ## Vision
   [What is this product and why does it exist?]

   ## Users
   [Who uses this and what do they need?]

   ## Core Features
   [List the main features]

   ## Non-Goals
   [What this product explicitly does NOT do]

   ## Domain Vocabulary
   | Term | Definition | NOT to be confused with |
   |------|-----------|------------------------|
   | [term] | [definition] | [confusable term] |
   ```

8. **Report to user**:
   ```
   SDD Autopilot initialized successfully.

   Files created:
   ✓ .sdd/state.json
   ✓ constitution.md
   ✓ CLAUDE.md (or "skipped — already exists")
   ✓ specs/prd-template.md

   Before your first run:
   1. Fill in constitution.md with your project principles
   2. Review CLAUDE.md (auto-generated, adjust if needed)
   3. Optionally fill specs/prd-template.md for better spec generation

   Quick start: run /sdd-autopilot:auto-run "your feature description"
   Your first run will use Standard mode. Express mode activates for trivial tasks.
   ```

## Important notes
- Use Read, Glob, and Bash tools for auto-detection — do NOT guess
- All [TODO] placeholders should be clearly marked for the user to fill
- The constitution.md goes in the PROJECT ROOT, not in .sdd/
- The specs/ directory should be created if it doesn't exist
- Do NOT modify any existing files except creating new ones
