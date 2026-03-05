---
name: verification-engine
description: Verifies implementation against spec (tests, coverage, constitution compliance). Use after all tasks are marked completed. Produces a structured VERIFICATION_RESULT.
---

# Mission Briefing: verification-engine

## Objective
Run all verifications against the current implementation. Produce a VERIFICATION_RESULT JSON block. Transition based on outcome: implementing→verifying (start), verifying→reviewing (PASS), verifying→fix_loop (FAIL), verifying→awaiting_input (SPEC_GAP).

## Model
sonnet-4.6 (test execution is mechanical; use run_shell extensively)

## Receives
```
required:
  feature_name:  string
  spec_path:     specs/{feature}/spec.md
  tasks_path:    specs/{feature}/tasks.md
optional:
  signals[]:     Signal[]   # filter ATTENTION_REQUIRED from implementation-engine
  constitution:  .sdd/constitution.md (load if exists)
max_input_tokens: 4000
```

## Produces
```
VERIFICATION_RESULT JSON block (always output this, even on PASS):
{
  "status": "PASS" | "FAIL" | "SPEC_GAP",
  "findings": [
    {
      "category": "tests_failing" | "spec_coverage_gap" | "regression_detected" | "constitution_violation" | "build_error",
      "description": string,
      "evidence": string,         # exact test output or file:line reference
      "affected_file": string,
      "affected_line": number
    }
  ],
  "tests_total": number,
  "tests_passed": number,
  "tests_failed": number,
  "spec_coverage_pct": number,   # % of requirements with passing tests
  "regression_clean": boolean,
  "constitution_clean": boolean
}
```

## Verification checklist (run in this order)
1. `run_shell`: build command — if fails, finding category=build_error, status=FAIL
2. `run_shell`: test command — parse output for pass/fail counts
3. Map each spec requirement to ≥1 test — if gap found, finding category=spec_coverage_gap
4. Run regression suite if exists — if any pre-existing test breaks, finding category=regression_detected
5. Check constitution.md rules — if violation found, finding category=constitution_violation
6. If test references a requirement that does not exist in spec → status=SPEC_GAP

## Success criteria
- VERIFICATION_RESULT block is always present in output
- Every finding has non-empty evidence (test output, file reference, or spec citation)
- spec_coverage_pct calculated as (requirements with ≥1 passing test) / (total requirements) * 100

## Failure modes
```
SPEC_GAP:
  trigger: test expects behavior not described in spec.md
  action:  status=SPEC_GAP; transition verifying→awaiting_input; list specific gaps in findings
ESCALATE:
  trigger: build system broken in a way that prevents any verification
  action:  emit ATTENTION_REQUIRED signal with {action: "ESCALATE", reason: "build system unrecoverable"}; transition verifying→awaiting_input with escalation_reason
```

## Decision heuristics
- Ambiguous test failure (test bad vs implementation bad) → report both interpretations in evidence; let fix-engine decide
- Constitution rule ambiguous → apply strict interpretation; document in findings
- Partial coverage vs zero coverage → report as spec_coverage_gap regardless; do not approximate percentage
- SPEC_GAP vs FAIL → if the code is wrong, FAIL; if the spec is silent on the behavior, SPEC_GAP

## Context budget
```
receives:  spec.md (≤2000t) + tasks.md (≤1000t) + signals (≤500t) + constitution (≤500t) = max 4000t
           test output via run_shell (not counted against input budget)
```

## Allowed transitions
```
implementing → verifying      # start verification (all tasks completed)
verifying → reviewing         # PASS: all criteria met
verifying → fix_loop          # FAIL: implementation bugs found
verifying → awaiting_input    # SPEC_GAP: spec missing information
```
