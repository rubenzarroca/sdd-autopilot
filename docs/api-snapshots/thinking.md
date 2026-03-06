# Extended Thinking
Source: https://platform.claude.com/docs/en/docs/build-with-claude/extended-thinking
Snapshot date: 2026-03-06

## IMPORTANT: Note on Claude Opus 4.6
For Claude Opus 4.6, use adaptive thinking (thinking: {type: "adaptive"}) with the effort parameter instead of manual thinking mode.
The manual thinking: {type: "enabled", budget_tokens: N} configuration is DEPRECATED on Opus 4.6 and will be removed in future releases.

## Supported Models

- Claude Opus 4.6 (claude-opus-4-6) - adaptive thinking only; manual mode deprecated
- Claude Opus 4.5 (claude-opus-4-5-20251101)
- Claude Opus 4.1 (claude-opus-4-1-20250805)
- Claude Opus 4 (claude-opus-4-20250514)
- Claude Sonnet 4.6 (claude-sonnet-4-6) - supports both manual and adaptive thinking with interleaved mode
- Claude Sonnet 4.5 (claude-sonnet-4-5-20250929)
- Claude Sonnet 4 (claude-sonnet-4-20250514)
- Claude Sonnet 3.7 (claude-3-7-sonnet-20250219) - deprecated
- Claude Haiku 4.5 (claude-haiku-4-5-20251001)

## Key Parameters

- budget_tokens: Maximum tokens for internal reasoning. DEPRECATED on Opus 4.6. Use effort parameter instead.
- Interleaved thinking: Opus 4.6 has it automatically; Sonnet 4.6 needs beta header "interleaved-thinking-2025-05-14".
- budget_tokens can exceed max_tokens with interleaved mode (up to 200k context window).

## Summarized Thinking (Claude 4 models)
- Returns summarized thinking (not full)
- Charged for full thinking tokens, not summary tokens
- Claude Sonnet 3.7 continues returning full thinking output

## Tool Choice Limitation with Thinking
- Only supports tool_choice: {"type": "auto"} or tool_choice: {"type": "none"}
- Using "any" or specific tool causes errors

## Interleaved Thinking
- Opus 4.6: Automatically enabled with adaptive thinking (no beta header needed)
- Sonnet 4.6: Add beta header "interleaved-thinking-2025-05-14"
- Other Claude 4: Add beta header "interleaved-thinking-2025-05-14"

## Prompt Caching + Thinking
- Thinking blocks from previous turns are removed from context
- Changes to thinking parameters invalidate message cache breakpoints
- Use 1-hour cache duration for extended thinking tasks (often exceed 5 minutes)
