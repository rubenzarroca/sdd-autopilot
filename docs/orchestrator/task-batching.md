# Task Batching Reference

**Referenced from:** `skills/auto-run/SKILL.md` § Implementation phase details

## Batch eligibility

After DAG analysis, group `batch_eligible` tasks into batches of up to 3 tasks each. Batching criteria:

- Task is marked `batch_eligible: true` in tasks.md (set by task-decomposer for tasks affecting ≤ 2 files with straightforward logic)
- Tasks in the same batch must NOT have dependencies on each other
- Tasks in the same batch must NOT modify the same files (file ownership rule)
- Maximum 3 tasks per batch

## Execution

For each batch, spawn ONE implementation-engine agent with ALL task blocks in the brief. The agent executes them sequentially within its context. After completion, call `sdd_update_task` for each task in the batch.

Non-batch-eligible tasks (complex, multi-file, or interdependent) are spawned individually as before. If all batch_eligible tasks in a wave share file conflicts, treat them as non-batch-eligible and spawn individually.

## Example

If tasks.md has 7 tasks where 4 are batch_eligible with no conflicts, group into 2 batches of 2 → spawn 2 agents instead of 4. Combined with 3 individual tasks = 5 total spawns instead of 7.
