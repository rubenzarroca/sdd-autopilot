[Back to README](../README.md)

# Memory Intelligence

## Two-Layer Model

Memory is split into two scopes via `sdd_memory_write` and `sdd_memory_read`:

- **Project scope** — stored in `.sdd/memory.md` within the target project. Contains project-specific conventions, patterns, and run history. Persists across runs for the same project.
- **User scope** — stored in the user's global Claude directory. Contains cross-project patterns and agent performance data. Persists across all projects.

## Memory Sections

| Section | Scope | Purpose |
|---------|-------|---------|
| `project_conventions` | project | Coding standards, architectural patterns, naming conventions discovered during runs |
| `learned_patterns` | project | What worked and what didn't in this specific codebase |
| `run_history` | project | Summary of past pipeline runs (scores, outcomes, notable events) |
| `cross_project_patterns` | user | Patterns that generalize across multiple projects |
| `agent_performance` | user | Performance data per subagent (pass rates, common failure modes) |

## Defensive Layers

Memory operations include three defensive layers to maintain data integrity:

### Provenance Metadata

Every memory entry records:
- **agent** — which subagent wrote it
- **run_id** — which pipeline run produced it
- **feature_id** — which feature it relates to
- **confidence** — how confident the agent is in the insight

### Prompt Injection Sanitization

A blocklist filter runs on all memory writes, preventing prompt injection attempts from being persisted. This protects against adversarial content in code comments or user input that might try to manipulate agent behavior through stored memory.

### Jaccard Similarity Consolidation

On every write, new entries are compared against existing entries using Jaccard similarity. Entries above the similarity threshold are consolidated (merged) rather than duplicated. This prevents memory bloat from repeated similar observations.

### Extraction Pattern Validation

Structured filter on reads ensures only well-formed data is returned to agents. Malformed or corrupted entries are filtered out silently.
