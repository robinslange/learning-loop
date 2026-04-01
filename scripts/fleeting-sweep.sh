#!/usr/bin/env bash
# Finds fleeting notes that have been absorbed into permanent (2+ inbound links)
# and stale project notes (no links, >60 days old, matches a project slug).
#
# Usage: fleeting-sweep.sh [vault_path]
# Output: TSV lines — TYPE\tNAME\tDETAIL

if [ -z "$1" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  CONFIG="$SCRIPT_DIR/../config.json"
  if [ -f "$CONFIG" ]; then
    VAULT=$(node -e "const c=JSON.parse(require('fs').readFileSync('$CONFIG','utf-8')); console.log(c.vault_path?.replace(/^~/, process.env.HOME) || process.env.HOME+'/brain/brain')")
  else
    VAULT="$HOME/brain/brain"
  fi
else
  VAULT="$1"
fi
FLEETING="$VAULT/1-fleeting"
PERMANENT="$VAULT/3-permanent"
PROJECT_SLUGS="solenoid|kinso|reguard|willems|auctionsense|nibbler|thalen|solwen"
STALE_DAYS=60

for f in "$FLEETING"/*.md; do
  [ -f "$f" ] || continue
  name=$(basename "$f" .md)

  # Skip counterpoint notes
  grep -q '^challenged:\|^challenges:' "$f" && continue

  # Count inbound links from permanent notes
  perm_count=$(grep -rl "\[\[$name\]\]" "$PERMANENT/" 2>/dev/null | wc -l | tr -d ' ')

  if [ "$perm_count" -ge 2 ]; then
    echo -e "PROMOTED\t$name\t$perm_count permanent refs"
    continue
  fi

  # Check stale project notes
  if echo "$name" | grep -qE "$PROJECT_SLUGS"; then
    # Any inbound links from anywhere?
    all_count=$(grep -rl "\[\[$name\]\]" "$VAULT/" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$all_count" -eq 0 ]; then
      file_mod=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null)
      mod_days=$(( ( $(date +%s) - file_mod ) / 86400 ))
      if [ "$mod_days" -ge "$STALE_DAYS" ]; then
        echo -e "STALE\t$name\t0 refs, ${mod_days} days old"
      fi
    fi
  fi
done
