# Effort Parameter
Source: https://platform.claude.com/docs/en/build-with-claude/effort
Snapshot date: 2026-03-06

## Overview
The effort parameter controls how many tokens Claude uses when responding, trading off between response thoroughness and token efficiency.
Effort is generally available on all supported models with no beta header required.

## Supported Models
Claude Opus 4.6, Claude Sonnet 4.6, and Claude Opus 4.5.

## IMPORTANT
For Claude Opus 4.6 and Sonnet 4.6, effort REPLACES budget_tokens as the recommended way to control thinking depth.
Combine with adaptive thinking (thinking: {type: "adaptive"}) for best experience.
While budget_tokens is still accepted on Opus 4.6 and Sonnet 4.6, it is DEPRECATED and will be removed in a future model release.
At high (default) and max effort, Claude will almost always think.
At lower effort levels, it may skip thinking for simpler problems.

## API Schema
output_config: { effort: "max" | "high" | "medium" | "low" }

## Effort Levels

| Level | Description | Typical use case |
|-------|-------------|-----------------|
| max | Absolute maximum capability, no constraints on token spend. Opus 4.6 ONLY. Other models return error. | Deepest reasoning, most thorough analysis |
| high | High capability. Equivalent to not setting the parameter. | Complex reasoning, difficult coding, agentic tasks |
| medium | Balanced approach, moderate token savings. | Agentic tasks balancing speed, cost, performance |
| low | Most efficient. Significant token savings, some capability reduction. | Simpler tasks, subagents, speed/cost optimization |

Note: Setting effort to "high" produces exactly the same behavior as omitting the effort parameter entirely.
Note: Effort is a behavioral signal, not a strict token budget.

## Recommended Effort for Sonnet 4.6
- Sonnet 4.6 defaults to high effort. Explicitly set effort to avoid unexpected latency.
- Medium effort (recommended default): Best balance for most applications, agentic coding, tool-heavy workflows.
- Low effort: High-volume or latency-sensitive workloads, chat, non-coding use cases.
- High effort: Tasks requiring maximum intelligence from Sonnet 4.6.

## Effect on Tool Use
Lower effort levels tend to:
- Combine multiple operations into fewer tool calls
- Make fewer tool calls
- Proceed directly to action without preamble

Higher effort levels may:
- Make more tool calls
- Explain the plan before taking action
- Provide detailed summaries
