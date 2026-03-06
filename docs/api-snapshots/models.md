# Models overview
Source: https://platform.claude.com/docs/en/docs/about-claude/models
Snapshot date: 2026-03-06

## Latest models comparison

| Feature | Claude Opus 4.6 | Claude Sonnet 4.6 | Claude Haiku 4.5 |
|:--------|:----------------|:------------------|:-----------------|
| **Claude API ID** | claude-opus-4-6 | claude-sonnet-4-6 | claude-haiku-4-5-20251001 |
| **Claude API alias** | claude-opus-4-6 | claude-sonnet-4-6 | claude-haiku-4-5 |
| **Pricing** | $5 / input MTok / $25 / output MTok | $3 / input MTok / $15 / output MTok | $1 / input MTok / $5 / output MTok |
| **Extended thinking** | Yes | Yes | Yes |
| **Adaptive thinking** | Yes | Yes | No |
| **Context window** | 200K tokens / 1M tokens (beta) | 200K tokens / 1M tokens (beta) | 200K tokens |
| **Max output** | 128K tokens | 64K tokens | 64K tokens |
| **Reliable knowledge cutoff** | May 2025 | Aug 2025 | Feb 2025 |
| **Training data cutoff** | Aug 2025 | Jan 2026 | Jul 2025 |

## Legacy models

| Feature | Claude Sonnet 4.5 | Claude Opus 4.5 | Claude Opus 4.1 | Claude Sonnet 4 | Claude Opus 4 | Claude Haiku 3 (deprecated) |
|:--------|:------------------|:----------------|:----------------|:----------------|:--------------|:----------------------------|
| **Claude API ID** | claude-sonnet-4-5-20250929 | claude-opus-4-5-20251101 | claude-opus-4-1-20250805 | claude-sonnet-4-20250514 | claude-opus-4-20250514 | claude-3-haiku-20240307 |
| **Max output** | 64K tokens | 64K tokens | 32K tokens | 64K tokens | 32K tokens | 4K tokens |

WARNING: Claude Haiku 3 (claude-3-haiku-20240307) is deprecated. Retirement scheduled for April 19, 2026. Migrate to Claude Haiku 4.5.

Note: Starting with Claude Sonnet 4.5 and subsequent models, AWS Bedrock and Google Vertex AI offer global endpoints (dynamic routing) and regional endpoints (10% premium over global).

Note: Models with same snapshot date (e.g., 20240620) are identical across platforms.
