# Agentic Tool Use
Source: URL needs verification - original https://docs.anthropic.com/en/docs/build-with-claude/agentic-tool-use redirects to platform.claude.com but 404s
Snapshot date: 2026-03-06
Status: PLACEHOLDER - page URL may have moved

## Note
The original agentic-tool-use page appears to have been reorganized.
Possible new location: https://platform.claude.com/docs/en/agents-and-tools/
Check the changelog for updated URL.

## Known Agent-Relevant Features (from changelog and other sources)

### Multi-Agent Patterns
- Orchestrator agents spawn subagents for parallel or sequential work
- Claude Code supports spawning subagents via Agent tool

### Interleaved Thinking (agent-relevant)
- Claude can think between tool calls
- Opus 4.6: Automatically enabled with adaptive thinking
- Sonnet 4.6: Beta header "interleaved-thinking-2025-05-14" required

### Context Management for Agents
- Context editing: available for clearing older tool results when approaching token limits
- Compaction API (beta on Opus 4.6): server-side context summarization for effectively infinite conversations
- Client-side compaction: available in Python and TypeScript SDKs via tool_runner

### Agent Skills
- Skills API available (skills-2025-10-02 beta)
- Organized folders of instructions, scripts, and resources
- Requires code execution tool to be enabled

### MCP Connector
- Connect to remote MCP servers directly from Messages API (GA, no beta header required)
- stdio transport supported

### Programmatic Tool Calling
- Generally available (no beta header required)
- Allows Claude to call tools from within code execution
- Reduces latency and token usage in multi-tool workflows
