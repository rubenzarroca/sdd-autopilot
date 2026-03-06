#!/bin/bash
set -euo pipefail

CHANGELOG_NEW="/tmp/api-snapshots-new/changelog.md"
CHANGELOG_OLD="docs/api-snapshots/changelog.md"
KNOWN_SOURCES="docs/api-watcher/known-sources.json"
DISCOVERY_REPORT="/tmp/api-watcher-discovery.md"
NEW_SOURCES_ADDED="false"

# Nothing to analyze if changelog wasn't fetched
if [ ! -f "$CHANGELOG_NEW" ]; then
  echo "No changelog to analyze"
  echo "new_sources=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

# Extract only lines added in the new changelog
if [ -f "$CHANGELOG_OLD" ]; then
  CHANGELOG_DIFF=$(diff "$CHANGELOG_OLD" "$CHANGELOG_NEW" | grep "^>" || true)
else
  CHANGELOG_DIFF=$(cat "$CHANGELOG_NEW")
fi

if [ -z "$CHANGELOG_DIFF" ]; then
  echo "No new changelog entries"
  echo "new_sources=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

# Extract URLs from the new entries
FOUND_URLS=$(echo "$CHANGELOG_DIFF" | \
  grep -oE 'https://(docs\.anthropic\.com|platform\.claude\.com|modelcontextprotocol\.io)[^ ")<>]+' | \
  sort -u || true)

if [ -z "$FOUND_URLS" ]; then
  echo "No new doc URLs in changelog"
  echo "new_sources=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

# Load already-known URLs
KNOWN_URLS=$(jq -r '.sources[].url' "$KNOWN_SOURCES" 2>/dev/null || echo "")

# Filter to only URLs we don't know yet
NEW_URLS=""
while IFS= read -r url; do
  [ -z "$url" ] && continue
  if ! echo "$KNOWN_URLS" | grep -qF "$url"; then
    NEW_URLS="$NEW_URLS"$'\n'"$url"
  fi
done <<< "$FOUND_URLS"

if [ -z "$(echo "$NEW_URLS" | tr -d '[:space:]')" ]; then
  echo "All changelog URLs already tracked"
  echo "new_sources=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

# Generate discovery report
echo "## Newly discovered sources" > "$DISCOVERY_REPORT"
echo "" >> "$DISCOVERY_REPORT"
echo "The changelog contains links to doc pages not currently monitored:" >> "$DISCOVERY_REPORT"
echo "" >> "$DISCOVERY_REPORT"

while IFS= read -r url; do
  [ -z "$url" ] && continue

  echo "- \`$url\`" >> "$DISCOVERY_REPORT"

  # Pre-classify by URL keywords
  RELEVANCE="unknown"
  if echo "$url" | grep -qiE "model|thinking|effort|agent|tool|mcp|code|plugin"; then
    RELEVANCE="likely_relevant"
  elif echo "$url" | grep -qiE "pricing|rate|limit|token|context|batch"; then
    RELEVANCE="possibly_relevant"
  elif echo "$url" | grep -qiE "safety|policy|terms|legal|blog"; then
    RELEVANCE="likely_irrelevant"
  fi

  # Download page once, check for SDD-specific keywords
  HTTP_CODE=$(curl -s -o "/tmp/discovery-page.html" -w "%{http_code}" \
    -L --max-time 15 \
    -H "User-Agent: sdd-autopilot-api-watcher/1.0" \
    "$url" || echo "000")

  KEYWORD_HITS=""
  if [ "$HTTP_CODE" = "200" ]; then
    KEYWORD_HITS=$(grep -oiE "subagent|multi.agent|spawn|thinking|adaptive|effort|tool.use|mcp|stdio|model.routing|deprecated|breaking.change" \
      "/tmp/discovery-page.html" | sort -u | tr '\n' ', ' || true)

    if [ -n "$KEYWORD_HITS" ]; then
      RELEVANCE="confirmed_relevant"
    fi
  fi

  echo "  Estimated relevance: **$RELEVANCE**" >> "$DISCOVERY_REPORT"
  [ -n "$KEYWORD_HITS" ] && echo "  Keywords detected: $KEYWORD_HITS" >> "$DISCOVERY_REPORT"
  echo "" >> "$DISCOVERY_REPORT"

  # Auto-add confirmed_relevant sources to known-sources.json
  if [ "$RELEVANCE" = "confirmed_relevant" ]; then
    URL_ID=$(echo "$url" | sed 's|.*docs/||; s|/|-|g; s|\.[^.]*$||')

    jq --arg id "$URL_ID" --arg url "$url" --arg keywords "$KEYWORD_HITS" \
      '.sources += [{"id": $id, "url": $url, "auto_discovered": true, "discovery_keywords": $keywords, "priority": "secondary"}]' \
      "$KNOWN_SOURCES" > "/tmp/known-sources-updated.json"
    mv "/tmp/known-sources-updated.json" "$KNOWN_SOURCES"

    echo "AUTO-ADDED: $url (keywords: $KEYWORD_HITS)"
    NEW_SOURCES_ADDED="true"
  fi

  rm -f "/tmp/discovery-page.html"
  sleep 1
done <<< "$NEW_URLS"

# Append decision guide to discovery report
echo "" >> "$DISCOVERY_REPORT"
echo "### Automatic action" >> "$DISCOVERY_REPORT"
echo "" >> "$DISCOVERY_REPORT"
echo "Sources with **confirmed_relevant** status were auto-added to \`known-sources.json\` and will be monitored starting next cycle." >> "$DISCOVERY_REPORT"
echo "" >> "$DISCOVERY_REPORT"
echo "Sources with **likely_relevant** or **unknown** status require a human decision: add to \`known-sources.json\` manually or discard." >> "$DISCOVERY_REPORT"
echo "" >> "$DISCOVERY_REPORT"
echo "Sources marked **likely_irrelevant** are ignored unless overridden." >> "$DISCOVERY_REPORT"

echo "new_sources=$NEW_SOURCES_ADDED" >> "$GITHUB_OUTPUT"
echo "Discovery complete. new_sources=$NEW_SOURCES_ADDED"
