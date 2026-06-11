#!/usr/bin/env bash
# Finds fleeting notes that have been absorbed into permanent (2+ inbound links)
# and stale project notes (no links, >60 days old, matches a project slug).
#
# Usage: fleeting-sweep.sh [vault_path]
# Output: TSV lines — TYPE\tNAME\tDETAIL

if [ -z "$1" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  if [ -n "$CLAUDE_PLUGIN_DATA" ] && [ -f "$CLAUDE_PLUGIN_DATA/config.json" ]; then
    CONFIG="$CLAUDE_PLUGIN_DATA/config.json"
  else
    CONFIG="$SCRIPT_DIR/../config.json"
  fi
  if [ -f "$CONFIG" ]; then
    VAULT=$(node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf-8')); const v=c.vault_path; if(!v){process.exit(1)} console.log(v.replace(/^~/, process.env.HOME))" "$CONFIG")
    if [ $? -ne 0 ] || [ -z "$VAULT" ]; then
      echo "No vault_path configured" >&2
      exit 1
    fi
  else
    echo "No config found" >&2
    exit 1
  fi
else
  VAULT="$1"
fi
FLEETING="$VAULT/1-fleeting"
PERMANENT="$VAULT/3-permanent"
# Project slugs = 4-projects/*.md basenames (the project index notes).
# Instance-specific names must never be hardcoded here: this file ships publicly.
PROJECT_SLUGS_FILE=$(mktemp) || exit 1
trap 'rm -f "$PROJECT_SLUGS_FILE"' EXIT
if [ -d "$VAULT/4-projects" ]; then
  for p in "$VAULT/4-projects"/*.md; do
    [ -f "$p" ] || continue
    basename "$p" .md >> "$PROJECT_SLUGS_FILE"
  done
fi

matches_project_slug() {
  # anchored prefix match (slug or slug-*); literal (no regex) so slug text is safe
  while IFS= read -r slug; do
    [ -n "$slug" ] || continue
    case "$1" in "$slug"|"$slug"-*) return 0 ;; esac
  done < "$PROJECT_SLUGS_FILE"
  return 1
}
STALE_DAYS=60

for f in "$FLEETING"/*.md; do
  [ -f "$f" ] || continue
  name=$(basename "$f" .md)

  # Skip counterpoint notes
  grep -q '^challenged:\|^challenges:' "$f" && continue

  # Count inbound links from permanent notes
  perm_count=$(grep -rlF "[[$name]]" "$PERMANENT/" 2>/dev/null | wc -l | tr -d ' ')

  if [ "$perm_count" -ge 2 ]; then
    echo -e "PROMOTED\t$name\t$perm_count permanent refs"
    continue
  fi

  # Check stale project notes
  if matches_project_slug "$name"; then
    # Any inbound links from anywhere?
    all_count=$(grep -rlF "[[$name]]" "$VAULT/" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$all_count" -eq 0 ]; then
      file_mod=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null)
      mod_days=$(( ( $(date +%s) - file_mod ) / 86400 ))
      if [ "$mod_days" -ge "$STALE_DAYS" ]; then
        echo -e "STALE\t$name\t0 refs, ${mod_days} days old"
      fi
    fi
  fi
done
