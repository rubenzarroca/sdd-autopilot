#!/bin/bash
set -euo pipefail

SOURCES_DIR="docs/api-snapshots"
NEW_DIR="/tmp/api-snapshots-new"
REPORT="/tmp/api-watcher-report.md"
HAS_CHANGES="false"

echo "# API Docs Watcher Report" > "$REPORT"
echo "" >> "$REPORT"
echo "Date: $(date -u +"%Y-%m-%d %H:%M UTC")" >> "$REPORT"
echo "" >> "$REPORT"

for new_file in "$NEW_DIR"/*.md; do
  id=$(basename "$new_file" .md)
  old_file="$SOURCES_DIR/$id.md"

  if [ ! -f "$old_file" ]; then
    echo "## $id — NEW (no previous snapshot)" >> "$REPORT"
    echo "First download. No diff available." >> "$REPORT"
    echo "" >> "$REPORT"
    HAS_CHANGES="true"
    continue
  fi

  # Generate diff (empty string if no changes)
  DIFF=$(diff -u "$old_file" "$new_file" || true)

  if [ -n "$DIFF" ]; then
    HAS_CHANGES="true"

    ADDED=$(echo "$DIFF" | grep -c "^+" || true)
    REMOVED=$(echo "$DIFF" | grep -c "^-" || true)

    # Classify impact by keywords in the diff (escalating severity)
    IMPACT="low"
    if echo "$DIFF" | grep -qiE "deprecat|removed|breaking|end.of.life|sunset"; then
      IMPACT="critical"
    elif echo "$DIFF" | grep -qiE "new model|model.string|haiku|sonnet|opus|thinking|adaptive|effort|budget_tokens"; then
      IMPACT="high"
    elif echo "$DIFF" | grep -qiE "pricing|rate.limit|token|context.window"; then
      IMPACT="medium"
    fi

    echo "## $id — Changes detected" >> "$REPORT"
    echo "" >> "$REPORT"
    echo "**Estimated impact: $IMPACT** (+$ADDED / -$REMOVED lines)" >> "$REPORT"
    echo "" >> "$REPORT"

    # Recommended action per source
    case "$id" in
      models)
        echo "**Recommended action**: Check for new model strings. Review \`engine/src/model-config.json\` and update if models are new or deprecated." >> "$REPORT"
        ;;
      thinking|effort)
        echo "**Recommended action**: Verify thinking/effort schema in \`engine/src/model-config.json\` and all agent definitions in \`.claude/agents/\`." >> "$REPORT"
        ;;
      tool-use|agent)
        echo "**Recommended action**: Check if tool calling changes affect the MCP server or orchestrator." >> "$REPORT"
        ;;
      pricing)
        echo "**Recommended action**: Review whether pricing changes affect the composite efficiency score or model routing." >> "$REPORT"
        ;;
      rate-limits)
        echo "**Recommended action**: Verify whether new limits affect parallel implementation waves." >> "$REPORT"
        ;;
      mcp)
        echo "**Recommended action**: Verify MCP engine compatibility with protocol changes." >> "$REPORT"
        ;;
      claude-code)
        echo "**Recommended action**: Check for plugin system or agent spawning changes that affect the architecture." >> "$REPORT"
        ;;
      changelog)
        echo "**Recommended action**: Review full changelog for changes not covered by other sources." >> "$REPORT"
        ;;
      *)
        echo "**Recommended action**: Review the diff and assess impact manually." >> "$REPORT"
        ;;
    esac

    echo "" >> "$REPORT"

    # Include truncated diff (max 80 lines to avoid bloating the issue)
    TOTAL_LINES=$(echo "$DIFF" | wc -l)
    echo "<details>" >> "$REPORT"
    echo "<summary>View diff ($ADDED added, $REMOVED removed)</summary>" >> "$REPORT"
    echo "" >> "$REPORT"
    echo '```diff' >> "$REPORT"
    echo "$DIFF" | head -80 >> "$REPORT"
    if [ "$TOTAL_LINES" -gt 80 ]; then
      echo "" >> "$REPORT"
      echo "... (diff truncated, $TOTAL_LINES total lines)" >> "$REPORT"
    fi
    echo '```' >> "$REPORT"
    echo "" >> "$REPORT"
    echo "</details>" >> "$REPORT"
    echo "" >> "$REPORT"
  fi
done

# Summary footer
if [ "$HAS_CHANGES" = "true" ]; then
  echo "---" >> "$REPORT"
  echo "" >> "$REPORT"
  echo "## Next steps" >> "$REPORT"
  echo "" >> "$REPORT"
  echo "1. Review each change detected above" >> "$REPORT"
  echo "2. If impact is **critical** or **high**, open Claude Code and run: \`/sdd-auto:run \"Update model-config.json and agent definitions per API changes\"\`" >> "$REPORT"
  echo "3. If impact is **medium** or **low**, evaluate whether action or just awareness is needed" >> "$REPORT"
  echo "4. Close this issue once changes are applied or discarded" >> "$REPORT"
fi

# Output for the Action
echo "has_changes=$HAS_CHANGES" >> "$GITHUB_OUTPUT"
echo "Report generated. has_changes=$HAS_CHANGES"
