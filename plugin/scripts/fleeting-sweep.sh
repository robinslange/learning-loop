#!/usr/bin/env bash
# Finds fleeting notes that have been absorbed into permanent (2+ inbound links),
# notes needing source repair (verification markers or source: unverified,
# untouched >14 days — the gate-demoted class whose repair path is /deepen),
# and stale project notes (no links, >60 days old, matches a project slug).
#
# Usage: fleeting-sweep.sh [vault_path]
# Output: TSV lines — TYPE\tNAME\tDETAIL
# Types: PROMOTED (archival candidate), NEEDS-DEEPEN (repair recommendation,
# never archival), STALE (archival candidate)
#
# Repair is bounded: NEEDS-DEEPEN is capped by the deepen_attempts frontmatter
# counter (incremented by /deepen when a repair pass fails to clear the
# markers). After MAX_DEEPEN_ATTEMPTS failed repairs the note surfaces as
# STALE instead — the archival exit, not another repair loop. A note matching
# both the stale-project rule and NEEDS-DEEPEN also surfaces as STALE:
# archival wins at end-of-life.

if [ -z "$1" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  VAULT=$(node "$SCRIPT_DIR/resolve-paths.mjs" VAULT)
  if [ $? -ne 0 ] || [ -z "$VAULT" ]; then
    echo "No vault_path configured" >&2
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
LINK_COUNTS_FILE=$(mktemp) || exit 1
trap 'rm -f "$PROJECT_SLUGS_FILE" "$LINK_COUNTS_FILE"' EXIT
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
# Inbound-link counts for every wikilink target in ONE vault pass. grep -o
# emits each bracket-innermost [[target]] occurrence as path:[[target]];
# sort -u collapses repeats within a file so counts are per-FILE, then awk
# splits on the last ":[[", strips the trailing "]]", and tallies per target:
# vault-wide plus 3-permanent/-only. Only exact [[target]] literals count;
# [[target|alias]] and [[target#heading]] are different literals and do not.
grep -roE '\[\[[^][]+\]\]' "$VAULT/" 2>/dev/null | sort -u | awk -v perm="$PERMANENT/" '
  {
    line = $0
    if (sub(/\]\]$/, "", line) == 0) next
    n = split(line, parts, /:\[\[/)
    if (n < 2) next
    target = parts[n]
    all[target]++
    if (index($0, perm) == 1) permc[target]++
  }
  END {
    for (t in all) printf "%s\t%d\t%d\n", t, permc[t], all[t]
  }
' > "$LINK_COUNTS_FILE"

link_counts_for() {
  awk -F'\t' -v n="$1" '$1 == n { print $2 "\t" $3; exit }' "$LINK_COUNTS_FILE"
}

STALE_DAYS=60
# Repair window: deliberately shorter than STALE_DAYS — a gate-demoted note
# should surface for /deepen well before it would qualify as archival-stale,
# but not on the very next /inbox run after the demotion.
NEEDS_DEEPEN_DAYS=14
# Repair budget: after this many failed /deepen passes (deepen_attempts
# frontmatter counter) the note is unfixable-by-research and gets the
# archival exit (STALE) instead of resurfacing as NEEDS-DEEPEN forever.
MAX_DEEPEN_ATTEMPTS=2

deepen_attempts_for() {
  local n
  n=$(grep -m1 -E '^deepen_attempts:[[:space:]]*[0-9]+' "$1" | grep -oE '[0-9]+' | head -1)
  echo "${n:-0}"
}

# Blocking verification markers. Must stay in sync with the MARKERS array in
# promotion-gate.mjs — tests/fleeting-sweep.test.mjs pins the two together.
has_blocking_marker() {
  # Strip fenced code blocks first (the gate ignores markers inside them),
  # then case-insensitive fixed-string match.
  awk '/^```/{f=!f;next} !f' "$1" | grep -qiF \
    -e '[unresolved]' \
    -e '[unverified]' \
    -e '[not in abstract]' \
    -e '[not in source]' \
    -e '[needs verification]' \
    -e '[citation needed]'
}

mod_days_for() {
  local file_mod
  file_mod=$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null)
  echo $(( ( $(date +%s) - file_mod ) / 86400 ))
}

for f in "$FLEETING"/*.md; do
  [ -f "$f" ] || continue
  name=$(basename "$f" .md)

  # Skip counterpoint notes
  grep -q '^challenged:\|^challenges:' "$f" && continue

  # Count inbound links from permanent notes
  IFS=$'\t' read -r perm_count all_count <<EOF
$(link_counts_for "$name")
EOF
  perm_count=${perm_count:-0}
  all_count=${all_count:-0}

  if [ "$perm_count" -ge 2 ]; then
    echo -e "PROMOTED\t$name\t$perm_count permanent refs"
    continue
  fi

  mod_days=$(mod_days_for "$f")

  # Check stale project notes BEFORE the repair branch: a note that already
  # qualifies as archival-stale keeps its archival exit even when it also
  # carries verification markers (archival wins at end-of-life).
  if matches_project_slug "$name"; then
    # Any inbound links from anywhere?
    if [ "$all_count" -eq 0 ]; then
      if [ "$mod_days" -ge "$STALE_DAYS" ]; then
        echo -e "STALE\t$name\t0 refs, ${mod_days} days old"
        continue
      fi
    fi
  fi

  # Gate-demoted notes whose documented repair path is /deepen: blocking
  # verification markers or an honest source: unverified, sitting untouched.
  # Bounded by the repair budget: past MAX_DEEPEN_ATTEMPTS failed /deepen
  # passes the note routes to the archival exit instead of looping.
  if [ "$mod_days" -ge "$NEEDS_DEEPEN_DAYS" ]; then
    reason=""
    if has_blocking_marker "$f"; then
      reason="verification markers"
    elif grep -Eq '^source:[[:space:]]*"?unverified' "$f"; then
      reason="source: unverified"
    fi
    if [ -n "$reason" ]; then
      attempts=$(deepen_attempts_for "$f")
      if [ "$attempts" -ge "$MAX_DEEPEN_ATTEMPTS" ]; then
        echo -e "STALE\t$name\t$reason, ${attempts} failed deepen attempts, ${mod_days} days old"
      else
        echo -e "NEEDS-DEEPEN\t$name\t$reason, ${mod_days} days old"
      fi
      continue
    fi
  fi
done
