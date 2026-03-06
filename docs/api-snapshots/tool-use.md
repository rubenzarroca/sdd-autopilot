# Tool Use with Claude
Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
Snapshot date: 2026-03-06

## Overview
Claude can interact with tools and functions to extend its capabilities.
Tool access is one of the highest-leverage primitives for agents.

## Key Features
- strict: true on tool definitions guarantees schema conformance via Structured Outputs
- Structured Outputs: generally available on Sonnet 4.5, Opus 4.5, Haiku 4.5 (no beta header required)
- output_format parameter moved to output_config.format

## Tool Definition Schema
{
  "name": "tool_name",
  "description": "Description of the tool",
  "input_schema": {
    "type": "object",
    "properties": { ... },
    "required": [...]
  },
  "strict": true  // optional, for guaranteed schema conformance
}

## Tool Choice Options
- {"type": "auto"} - Claude decides when to use tools
- {"type": "any"} - Claude must use at least one tool
- {"type": "tool", "name": "..."} - Force specific tool use
- {"type": "none"} - Prevents Claude from calling any tools

## Parallel Tool Use
- Claude can make multiple tool calls in a single response
- Disable with: disable_parallel_tool_use: true in tool_choice field

## Fine-Grained Tool Streaming
- Generally available on all models and platforms (no beta header required)
- Enables streaming tool use parameters without buffering

## Tool Use System Prompt Tokens (Opus 4.6 / Sonnet 4.6)
- tool_choice "auto" or "none": 346 tokens
- tool_choice "any" or "tool": 313 tokens
- These token counts are added to input/output tokens for cost calculation

## Server-Side Tools
- web_search_20260209: $10 per 1,000 searches
- web_fetch_20260209: No additional charges
- code_execution: Free when used with web search or web fetch; otherwise $0.05/hour/container
- Programmatic tool calling: Generally available (no beta header required)
- Tool search tool: Generally available (no beta header required)
