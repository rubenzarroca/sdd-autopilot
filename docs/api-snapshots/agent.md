# Subagents in the Agent SDK
Source: https://platform.claude.com/docs/en/agent-sdk/subagents
Snapshot date: 2026-03-06
Note: Replaces the old /docs/build-with-claude/agentic-tool-use page

## Overview
Subagents are separate agent instances that your main agent can spawn to handle focused subtasks.
Benefits: context isolation, parallelization, specialized instructions, tool restrictions.

## Three Ways to Create Subagents
1. Programmatically: agents parameter in query() options
2. Filesystem-based: markdown files in .claude/agents/ directories
3. Built-in general-purpose: Claude can invoke "general-purpose" subagent via Task tool without definition

## AgentDefinition Fields
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| description | string | Yes | When to use this agent (Claude reads this to decide when to delegate) |
| prompt | string | Yes | System prompt defining role and behavior |
| tools | string[] | No | Allowed tool names. If omitted, inherits all tools |
| model | 'sonnet' | 'opus' | 'haiku' | 'inherit' | No | Model override. Defaults to main model |

IMPORTANT: Subagents cannot spawn their own subagents. Do NOT include Task in a subagent's tools.
IMPORTANT: Task tool must be in allowedTools of the parent for subagent invocation to work.

## Subagent Invocation
- Automatic: Claude decides based on description + task context
- Explicit: mention subagent by name in prompt ("Use the code-reviewer agent to...")
- Detection: check for tool_use blocks with name: "Task"
- Messages from within subagent context include parent_tool_use_id field

## Common Tool Combinations
| Use case | Tools |
|----------|-------|
| Read-only analysis | Read, Grep, Glob |
| Test execution | Bash, Read, Grep |
| Code modification | Read, Edit, Write, Grep, Glob |
| Full access | Omit tools field (inherits all) |

## Model Routing per Subagent
model: "opus" for complex/critical tasks
model: "sonnet" for standard tasks
model: "haiku" for speed/simple tasks
model: "inherit" or omit to use main model

## Subagent Resume
- Subagents have session_id and agentId
- Resume with: options { resume: sessionId } and agentId in prompt
- Subagent transcripts persist independently of main conversation
- Automatic cleanup per cleanupPeriodDays setting (default: 30 days)

## Filesystem-Based Subagents
Defined as markdown files in .claude/agents/ directories.
Programmatically defined agents take precedence over filesystem-based agents with the same name.
Loaded at startup only — restart session to load newly created agent files.

## Troubleshooting
- Claude not delegating: check Task is in allowedTools, use explicit prompting, improve description
- Windows long prompt failures: keep prompts concise or use filesystem-based agents

## Related
- Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- Agent SDK overview: https://platform.claude.com/docs/en/agent-sdk/overview
