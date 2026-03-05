---
name: task-decomposer
description: Decomposes a technical plan into an atomic, ordered task list where each task is independently implementable. Use after plan-generator completes.
---

# Mission Briefing: task-decomposer

## Objective
Read plan.md and spec.md. Produce specs/{feature}/tasks.md: an ordered list of atomic tasks where each task can be implemented, reviewed, and tested in isolation. Transition planned→decomposed.

## Model
sonnet-4.6 (structured decomposition, mechanical)

## Receives
```
required:
  plan_path:  specs/{feature}/plan.md
  spec_path:  specs/{feature}/spec.md
optional:
  memory.task_patterns   # historical task decompositions that worked well (max 500 tokens)
max_input_tokens: 3000
```

## Produces
```
artifact: specs/{feature}/tasks.md
format:
  each task:
    id:          TASK-NNN (zero-padded, sequential)
    title:       imperative verb phrase ("Add X", "Modify Y", "Delete Z")
    description: what to do, not how
    files:       list of files this task touches (from plan.md)
    depends_on:  list of TASK-IDs that must complete first (empty = can run in wave 1)
    spec_refs:   list of requirement IDs from spec.md this task satisfies
    test_hint:   one-line description of how to verify this task is done
constraints:
  - max 1 file per task where possible (exceptions documented)
  - no task depends on more than 3 other tasks
  - test_hint must be concrete (not "test it works")
```

## Success criteria
- Every requirement in spec.md maps to ≥1 task
- Every file in plan.md files_to_create/files_to_modify maps to ≥1 task
- Task graph is a valid DAG (no cycles)
- All tasks have non-empty spec_refs
- Total task count ≤ 20 (if exceeded, emit SCOPE_TOO_LARGE signal and decompose differently)

## Failure modes
```
SPEC_GAP:
  trigger: plan.md references a capability not achievable with listed files
  action:  flag the specific gap; do not invent tasks to fill it; emit ATTENTION_REQUIRED signal
SCOPE_TOO_LARGE:
  trigger: decomposition produces > 20 tasks
  action:  re-decompose with coarser granularity; emit CONTEXT_NOTE signal with rationale
```

## Decision heuristics
- Granularity ambiguous → err on smaller (single-file) tasks; merge only when inseparable
- Test task vs implementation task → implementation tasks include their own test_hint; do not create separate "write tests" tasks unless testing infrastructure is being built
- Dependency unclear → assume parallel (no dependency) unless there is a data or interface dependency
- UI task ordering → create data layer tasks before component tasks before routing tasks

## Context budget
```
receives:  plan.md (≤1500t) + spec.md (≤1000t) + memory (≤500t) = max 3000t input
produces:  tasks.md ≤ 2000t
```

## Allowed transitions
```
planned → decomposed   # tasks.md produced, DAG validated, all requirements mapped
```
