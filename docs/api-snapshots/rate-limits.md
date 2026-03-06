# Rate Limits
Source: https://platform.claude.com/docs/en/api/rate-limits
Snapshot date: 2026-03-06

## Overview
Two types of limits:
1. Spend limits: maximum monthly cost per organization
2. Rate limits: maximum API requests over defined period

Limits are defined by usage tier. ITPM = Input Tokens Per Minute, OTPM = Output Tokens Per Minute.

IMPORTANT: For most Claude models, only UNCACHED input tokens count towards ITPM rate limits.
cache_read_input_tokens do NOT count towards ITPM (except older models marked with †).

## Tier Requirements (Credit Purchases to Advance)
- Tier 1: $5 / Max $100 single purchase
- Tier 2: $40 / Max $500
- Tier 3: $200 / Max $1,000
- Tier 4: $400 / Max $5,000
- Monthly Invoicing: N/A

## Messages API Rate Limits

### Tier 1
| Model | RPM | ITPM | OTPM |
|-------|-----|------|------|
| Claude Sonnet 4.x | 50 | 30,000 | 8,000 |
| Claude Haiku 4.5 | 50 | 50,000 | 10,000 |
| Claude Opus 4.x | 50 | 30,000 | 8,000 |

### Tier 2
| Model | RPM | ITPM | OTPM |
|-------|-----|------|------|
| Claude Sonnet 4.x | 1,000 | 450,000 | 90,000 |
| Claude Haiku 4.5 | 1,000 | 450,000 | 90,000 |
| Claude Opus 4.x | 1,000 | 450,000 | 90,000 |

### Tier 3
| Model | RPM | ITPM | OTPM |
|-------|-----|------|------|
| Claude Sonnet 4.x | 2,000 | 800,000 | 160,000 |
| Claude Haiku 4.5 | 2,000 | 1,000,000 | 200,000 |
| Claude Opus 4.x | 2,000 | 800,000 | 160,000 |

### Tier 4
| Model | RPM | ITPM | OTPM |
|-------|-----|------|------|
| Claude Sonnet 4.x | 4,000 | 2,000,000 | 400,000 |
| Claude Haiku 4.5 | 4,000 | 4,000,000 | 800,000 |
| Claude Opus 4.x | 4,000 | 2,000,000 | 400,000 |

Note: Sonnet 4.x rate limit applies combined to Sonnet 4.6 + 4.5 + 4.
Note: Opus 4.x rate limit applies combined to Opus 4.6 + 4.5 + 4.1 + 4.

## Long Context Rate Limits (>200K tokens, Tier 4 only)
| ITPM | OTPM |
|------|------|
| 1,000,000 | 200,000 |

## Fast Mode Rate Limits
Separate dedicated rate limits apply for fast mode on Opus 4.6.
Response includes anthropic-fast-* headers for fast mode rate limit status.

## Rate Limit Algorithm
Token bucket algorithm: capacity continuously replenished up to maximum, not reset at fixed intervals.
Rate limits currently shared across all inference_geo values.

## Cache-Aware ITPM
total_input_tokens = cache_read_input_tokens + cache_creation_input_tokens + input_tokens
Only (input_tokens + cache_creation_input_tokens) count towards ITPM on most models.
Effective throughput can be much higher with prompt caching.
