# Claude Developer Platform Changelog
Source: https://platform.claude.com/docs/en/release-notes/api
Snapshot date: 2026-03-06

## February 19, 2026
- Automatic caching for Messages API launched (add cache_control to request body, system manages breakpoints automatically). Available on Claude API and Azure AI Foundry (preview).
- Claude Sonnet 3.7 (claude-3-7-sonnet-20250219) and Claude Haiku 3.5 (claude-3-5-haiku-20241022) RETIRED. All requests return error. Upgrade to Sonnet 4.6 and Haiku 4.5.
- Claude Haiku 3 (claude-3-haiku-20240307) DEPRECATED. Retirement scheduled April 19, 2026. Migrate to Haiku 4.5.

## February 17, 2026
- Claude Sonnet 4.6 launched. Improved agentic search, fewer tokens. Supports extended thinking and 1M token context window (beta).
- Code execution now FREE when used with web search or web fetch.
- Web search tool and programmatic tool calling now generally available (no beta header required).
- Code execution tool, web fetch tool, tool search tool, tool use examples, memory tool now generally available.

## February 7, 2026
- Fast mode launched in research preview for Opus 4.6. Up to 2.5x faster at premium pricing. speed parameter.

## February 5, 2026
- Claude Opus 4.6 launched. Recommends adaptive thinking (thinking: {type: "adaptive"}); manual thinking (type: "enabled" with budget_tokens) DEPRECATED. Opus 4.6 does not support prefilling assistant messages.
- Effort parameter now generally available (no beta header required), supports Claude Opus 4.6.
- Compaction API (beta, Opus 4.6): server-side context summarization for infinite conversations.
- Data residency controls: inference_geo parameter. US-only inference at 1.1x pricing for models after Feb 1, 2026.
- 1M token context window now in beta for Opus 4.6.
- Fine-grained tool streaming now generally available. output_format parameter moved to output_config.format.

## January 29, 2026
- Structured outputs generally available for Sonnet 4.5, Opus 4.5, Haiku 4.5. output_format moved to output_config.format.

## January 12, 2026
- console.anthropic.com now redirects to platform.claude.com.

## January 5, 2026
- Claude Opus 3 (claude-3-opus-20240229) RETIRED. Upgrade to Opus 4.5.

## December 19, 2025
- Claude Haiku 3.5 model deprecation announced.

## November 24, 2025
- Claude Opus 4.5 launched.
- Programmatic tool calling in public beta.
- Tool search tool in public beta.
- Effort parameter in public beta for Opus 4.5.
- Client-side compaction added to Python and TypeScript SDKs.

## November 19, 2025
- New documentation platform at platform.claude.com/docs. Redirects from docs.claude.com.

## October 28, 2025
- Claude Sonnet 3.7 deprecation announced.
- Claude Sonnet 3.5 models RETIRED.

## October 16, 2025
- Agent Skills launched (skills-2025-10-02 beta). Organized folders of instructions, scripts, resources. Anthropic-managed Skills (pptx, xlsx, docx, pdf). Requires code execution tool.

## October 15, 2025
- Claude Haiku 4.5 launched.

## September 29, 2025
- Claude Sonnet 4.5 launched.
- Global endpoint pricing for AWS Bedrock and Google Vertex AI.
- New stop reason: model_context_window_exceeded.
- Memory tool in beta.
- Context editing in beta.

## September 10, 2025
- Web fetch tool in beta.
- Claude Code Analytics API launched.

## September 2, 2025
- Code Execution Tool v2 in public beta (Bash + file manipulation, multi-language).

## August 5, 2025
- Claude Opus 4.1 launched.

## May 22, 2025
- Claude Opus 4 and Claude Sonnet 4 launched with extended thinking.
- Summarized thinking introduced for Claude 4 models.
- Interleaved thinking in public beta (beta header: interleaved-thinking-2025-05-14).
- Files API in public beta.
- Code execution tool in public beta (Python, sandboxed).
- MCP connector in public beta.
- top_p default changed from 0.999 to 0.99 for all models.

## February 24, 2025
- Claude Sonnet 3.7 launched with extended thinking.

## Key URL Changes
- docs.anthropic.com -> platform.claude.com/docs/en/
- console.anthropic.com -> platform.claude.com
- Tool use docs: /docs/en/agents-and-tools/tool-use/
- API rate limits: /docs/en/api/rate-limits
- Changelog: /docs/en/release-notes/api
