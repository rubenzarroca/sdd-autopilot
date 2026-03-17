# Non-Goals

Things SDD Autopilot explicitly does NOT do and is not designed to do.

1. **Not an IDE replacement.** It doesn't replace Claude Code for simple tasks. Use Claude Code directly for one-off edits, debugging, or exploration. SDD Autopilot is for structured feature development.

2. **Not a CI/CD system.** It doesn't manage deployments, environments, or build pipelines. It creates PRs — what happens after merge is your infrastructure's job.

3. **Not a testing framework.** It verifies implementations against specs, but it doesn't replace your test suite. Write real tests.

4. **Not multi-repo.** It operates on one project at a time. Cross-repo features need separate runs.

5. **Not for large teams (yet).** Designed for solo developers and small teams (5 or fewer). Team-scale coordination features are on the roadmap but not implemented.

6. **Not machine learning.** The "metacognition" layer (patterns, experiments, evolutions) is heuristic-based, not ML. It learns from run history through simple statistical analysis, not training models.

7. **Not a replacement for thinking.** It automates the ceremony of specification-driven development, not the judgment. You still need to write good feature descriptions and review the output.
