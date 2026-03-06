# Claude Code Overview
Source: https://platform.claude.com/docs/en/docs/claude-code/overview
Snapshot date: 2026-03-06

## Overview
Claude Code is Anthropic's official CLI for Claude.
Enables developers to delegate coding tasks to Claude directly from their terminal.
Provides agentic coding experience.

## Key Features

### Agentic Coding Capabilities
- Execute coding tasks from command line
- Direct integration with Claude models
- Support for multi-step coding workflows

### Plugin System
- Claude Code supports plugins: installable bundles of MCPs, skills, and tools
- Plugins can be grouped into marketplaces for discovery and installation
- Extensible architecture for custom functionality

### Model Access (current)
- Claude Opus 4.6 (claude-opus-4-6)
- Claude Sonnet 4.6 (claude-sonnet-4-6)
- Claude Haiku 4.5 (claude-haiku-4-5-20251001)

### Agent Tool
- Claude Code supports spawning subagents via Agent tool
- Multi-agent swarm coordination

### Claude Code Analytics API
- Programmatic access to daily aggregated usage metrics (available Sept 2025)
- Includes productivity metrics, tool usage statistics, and cost data

## Implementation
Claude Code is implemented on top of the Claude Agent SDK.
Powers portions of Anthropic's ecosystem including Cowork mode.

## Cowork Mode
Research preview feature of the Claude desktop app.
Enables automation of file and task management for non-developers.

## Related Resources
- CHANGELOG.md: https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
- For release notes on Claude Code, see the CHANGELOG on GitHub (separate from API changelog)
