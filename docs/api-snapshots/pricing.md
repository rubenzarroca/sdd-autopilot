# Pricing
Source: https://platform.claude.com/docs/en/docs/about-claude/pricing
Snapshot date: 2026-03-06

## Model Pricing (per MTok = Million tokens)

| Model | Base Input | 5m Cache Write | 1h Cache Write | Cache Hits | Output |
|-------|-----------|----------------|----------------|------------|--------|
| Claude Opus 4.6 | $5 | $6.25 | $10 | $0.50 | $25 |
| Claude Opus 4.5 | $5 | $6.25 | $10 | $0.50 | $25 |
| Claude Opus 4.1 | $15 | $18.75 | $30 | $1.50 | $75 |
| Claude Opus 4 | $15 | $18.75 | $30 | $1.50 | $75 |
| Claude Sonnet 4.6 | $3 | $3.75 | $6 | $0.30 | $15 |
| Claude Sonnet 4.5 | $3 | $3.75 | $6 | $0.30 | $15 |
| Claude Sonnet 4 | $3 | $3.75 | $6 | $0.30 | $15 |
| Claude Haiku 4.5 | $1 | $1.25 | $2 | $0.10 | $5 |
| Claude Haiku 3.5 | $0.80 | $1 | $1.6 | $0.08 | $4 |
| Claude Haiku 3 | $0.25 | $0.30 | $0.50 | $0.03 | $1.25 |

## Batch Processing (50% discount)

| Model | Batch Input | Batch Output |
|-------|------------|--------------|
| Claude Opus 4.6 | $2.50 | $12.50 |
| Claude Sonnet 4.6 | $1.50 | $7.50 |
| Claude Haiku 4.5 | $0.50 | $2.50 |

## Long Context Pricing (>200K input tokens, requires 1M context beta)

| Model | <=200K Input | >200K Input | Output (>200K) |
|-------|-------------|-------------|----------------|
| Claude Opus 4.6 | $5 | $10 | $37.50 |
| Claude Sonnet 4.6/4.5/4 | $3 | $6 | $22.50 |

## Fast Mode Pricing (Opus 4.6 research preview, 6x standard)
Input: $30/MTok, Output: $150/MTok

## Data Residency
US-only inference (inference_geo: "us"): 1.1x multiplier on all token categories.
Applies to Opus 4.6 and newer models released after February 1, 2026.

## Prompt Caching Multipliers
- 5-minute cache write: 1.25x base input price
- 1-hour cache write: 2x base input price
- Cache read (hit): 0.1x base input price

## Tool Use System Prompt Tokens (adds to input cost)
- Claude 4.x models: 346 tokens (auto/none) / 313 tokens (any/tool)

## Server Tools Additional Pricing
- Web search: $10 per 1,000 searches
- Web fetch: No additional charges
- Code execution: Free with web search/fetch; otherwise $0.05/hour/container (1,550 free hours/month)
- Computer use system prompt overhead: 466-499 tokens

## Third-Party Platforms
- Regional endpoints (AWS Bedrock, Vertex AI): 10% premium over global endpoints
- Applies to Sonnet 4.5, Haiku 4.5, and future models
