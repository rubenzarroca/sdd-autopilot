#!/bin/bash
set -euo pipefail

SOURCES_DIR="docs/api-snapshots"
NEW_DIR="/tmp/api-snapshots-new"
KNOWN_SOURCES="docs/api-watcher/known-sources.json"
mkdir -p "$NEW_DIR"

# Read sources dynamically from known-sources.json (not hardcoded)
SOURCES=$(jq -r '.sources[] | "\(.id)|\(.url)"' "$KNOWN_SOURCES")

METADATA="{}"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

while IFS='|' read -r id url; do
  [ -z "$id" ] && continue
  echo "Fetching: $id ($url)"

  # Download with 30s timeout, follow redirects
  HTTP_CODE=$(curl -s -o "/tmp/raw-$id.html" -w "%{http_code}" \
    -L --max-time 30 \
    -H "User-Agent: sdd-autopilot-api-watcher/1.0" \
    "$url" || echo "000")

  if [ "$HTTP_CODE" = "200" ]; then
    # Extract main text (strip HTML)
    if command -v lynx &> /dev/null; then
      lynx -dump -nolist "/tmp/raw-$id.html" > "$NEW_DIR/$id.md"
    else
      sed -e 's/<[^>]*>//g' -e '/^[[:space:]]*$/d' "/tmp/raw-$id.html" | head -500 > "$NEW_DIR/$id.md"
    fi
    METADATA=$(echo "$METADATA" | jq --arg id "$id" --arg ts "$TIMESTAMP" --arg code "$HTTP_CODE" \
      '. + {($id): {"fetched_at": $ts, "http_code": $code, "status": "ok"}}')
  else
    echo "WARNING: $id returned HTTP $HTTP_CODE"
    # Fall back to previous snapshot if available
    [ -f "$SOURCES_DIR/$id.md" ] && cp "$SOURCES_DIR/$id.md" "$NEW_DIR/$id.md"
    METADATA=$(echo "$METADATA" | jq --arg id "$id" --arg ts "$TIMESTAMP" --arg code "$HTTP_CODE" \
      '. + {($id): {"fetched_at": $ts, "http_code": $code, "status": "fetch_failed"}}')
  fi

  rm -f "/tmp/raw-$id.html"
  sleep 2  # Polite rate limiting
done <<< "$SOURCES"

echo "$METADATA" > "$NEW_DIR/metadata.json"
echo "Fetch complete."
