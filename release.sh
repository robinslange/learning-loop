#!/usr/bin/env bash
# Bump version across all manifests, commit, tag, and push.
#
# Usage:
#   ./release.sh patch    # 1.2.2 -> 1.2.3
#   ./release.sh minor    # 1.2.2 -> 1.3.0
#   ./release.sh major    # 1.2.2 -> 2.0.0
#
# Flags:
#   --dry-run     Show what would happen without making changes
#   --no-push     Commit and tag locally but don't push
#
# Preflight: must run on main, ff-only synced with origin. Lockfiles
# (native/Cargo.lock, package-lock.json) are regenerated with every bump.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR"
cd "$ROOT"

BUMP="${1:-}"
DRY_RUN=false
NO_PUSH=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --no-push) NO_PUSH=true ;;
    --skip-tests)
      echo "Error: --skip-tests was removed (W4) — the suite is deterministic; fix the failure instead."
      exit 1 ;;
  esac
done

if [[ ! "$BUMP" =~ ^(patch|minor|major)$ ]]; then
  echo "Usage: release.sh <patch|minor|major> [--dry-run] [--no-push]"
  exit 1
fi

# Read current version from package.json
CURRENT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf-8')).version)")

IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case "$BUMP" in
  patch) PATCH=$((PATCH + 1)) ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
esac

NEW="$MAJOR.$MINOR.$PATCH"

echo "$CURRENT -> $NEW ($BUMP)"

if $DRY_RUN; then
  echo "(dry run, no changes made)"
  exit 0
fi

# Check for uncommitted changes
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: uncommitted changes. Commit or stash first."
  exit 1
fi

# Preflight: releases only ship from an up-to-date main.
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
  echo "Error: release.sh must run on main (current: $BRANCH)"
  exit 1
fi
echo "Syncing with origin (ff-only)..."
if ! git pull --ff-only origin main; then
  echo "Error: ff-only pull from origin main failed; reconcile with origin first."
  exit 1
fi

# CI gate: the suite below runs on this machine's OS only, so it cannot fail for
# a platform it does not run on. v2.0.0 was tagged on a commit whose Windows job
# was red for exactly that reason. Ask GitHub instead.
#
# This gates the commit the release is *based on*, not the release commit, which
# does not exist yet. That is the honest scope: the release commit adds version
# bumps, a CHANGELOG rename and lockfiles, all of which the local suite covers.
# What CI adds is the platforms this machine is not.
#
# There is no bypass flag, for the same reason --skip-tests was removed: a red
# CI is a thing to fix, not to route around.
BASE_SHA=$(git rev-parse HEAD)
echo "Checking CI on $BASE_SHA..."

# Every failure below is a hard stop. A gate that passes when it could not run
# is the vacuous pre-flight this repo already fixed once in deploy.sh.
command -v gh >/dev/null 2>&1 || {
  echo "Error: gh is not installed, so CI status cannot be read."
  echo "Install the GitHub CLI, or verify the run for $BASE_SHA by hand and re-run."
  exit 1
}

# --jq runs per page, so paginated output arrives already flattened: one
# tab-separated line per check, no JSON reassembly.
if ! CHECKS=$(gh api "repos/{owner}/{repo}/commits/$BASE_SHA/check-runs" --paginate \
       --jq '.check_runs[] | [.status, (.conclusion // "none"), .name] | @tsv' 2>&1); then
  echo "Error: could not read CI status for $BASE_SHA."
  echo "$CHECKS"
  exit 1
fi

# Assert the complement is empty rather than listing the checks that must pass:
# a named list is a wordlist, and it goes stale the day a job is added.
# skipped/neutral are not failures — a path-filtered job declining to run is not
# a red build. Everything else (failure, cancelled, timed_out, action_required,
# stale) is.
CI_TOTAL=$(printf '%s' "$CHECKS" | grep -c . || true)
CI_PENDING=$(printf '%s\n' "$CHECKS" | awk -F'\t' '$1 != "completed" && NF { print $3 }' | paste -sd'|' - | tr '|' ',')
CI_BAD=$(printf '%s\n' "$CHECKS" | awk -F'\t' '
  $1 == "completed" && $2 != "success" && $2 != "skipped" && $2 != "neutral" { print $3 " (" $2 ")" }
' | paste -sd'|' - | tr '|' ',')

if [ "$CI_TOTAL" -eq 0 ]; then
  echo "Error: no CI has reported on $BASE_SHA."
  echo "An unpushed or unbuilt commit is not a green one. Push it and let CI run."
  exit 1
fi
if [ -n "$CI_PENDING" ]; then
  echo "Error: CI is still running on $BASE_SHA: $CI_PENDING"
  echo "Wait for it to finish, then re-run."
  exit 1
fi
if [ -n "$CI_BAD" ]; then
  echo "Error: CI is not green on $BASE_SHA: $CI_BAD"
  echo "Fix the failure and release from a commit CI has passed."
  exit 1
fi
echo "CI green on $BASE_SHA ($CI_TOTAL checks)."

# Test gate: run prettier + JS + Rust suites before tagging.
echo "Running prettier check..."
npx prettier --check 'plugin/hooks/**/*.{js,mjs}' 'plugin/scripts/**/*.{js,mjs}'
echo "Running npm test..."
npm test
if [ -d native ]; then
  echo "Running cargo test --workspace..."
  (cd native && cargo test --workspace --quiet)
fi

# Update all versioned manifests
perl -i -pe "s/\"version\": \"$CURRENT\"/\"version\": \"$NEW\"/" \
  package.json \
  plugin/.claude-plugin/plugin.json \
  plugin/.codex-plugin/plugin.json

for cargo_toml in native/crates/*/Cargo.toml; do
  [ -f "$cargo_toml" ] || continue
  # ll-core tracks its own crates.io semver line (0.1.x); never bump with the plugin release.
  case "$cargo_toml" in
    */ll-core/*) continue ;;
  esac
  perl -i -pe "s/^version = \"[0-9]*\\.[0-9]*\\.[0-9]*\"/version = \"$NEW\"/" "$cargo_toml"
done

# CHANGELOG: refuse if Unreleased section is empty; otherwise rename and stub.
if [ ! -f CHANGELOG.md ]; then
  echo "Error: CHANGELOG.md missing"
  git checkout -- package.json plugin/.claude-plugin/plugin.json plugin/.codex-plugin/plugin.json native/crates/*/Cargo.toml
  exit 1
fi

UNRELEASED_BODY=$(awk '
  /^## Unreleased/ { in_section = 1; next }
  /^## / && in_section { exit }
  in_section { print }
' CHANGELOG.md | grep -E '^[^[:space:]]' || true)

if [ -z "$UNRELEASED_BODY" ]; then
  echo "Error: CHANGELOG.md ## Unreleased section is empty; nothing to release"
  echo "Add a section under '## Unreleased' describing this release, then re-run."
  git checkout -- package.json plugin/.claude-plugin/plugin.json plugin/.codex-plugin/plugin.json native/crates/*/Cargo.toml
  exit 1
fi

# Rename '## Unreleased' to '## Unreleased\n\n## v$NEW' (preserves Unreleased as a future stub).
perl -i -pe "s/^## Unreleased\$/## Unreleased\n\n## v$NEW/" CHANGELOG.md

# Lockfiles must track the bumped manifest versions.
echo "Syncing lockfiles..."
(cd native && cargo update --workspace --quiet)
npm install --package-lock-only --silent

# Verify
for f in package.json plugin/.claude-plugin/plugin.json plugin/.codex-plugin/plugin.json; do
  v=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$f','utf-8')).version)")
  if [ "$v" != "$NEW" ]; then
    echo "Error: $f version is $v, expected $NEW"
    git checkout -- package.json plugin/.claude-plugin/plugin.json plugin/.codex-plugin/plugin.json CHANGELOG.md native/crates/*/Cargo.toml native/Cargo.lock package-lock.json
    exit 1
  fi
done

git add package.json plugin/.claude-plugin/plugin.json plugin/.codex-plugin/plugin.json CHANGELOG.md native/Cargo.lock package-lock.json
git add native/crates/*/Cargo.toml 2>/dev/null
git commit -m "release: v$NEW"
git tag "v$NEW"

if $NO_PUSH; then
  echo "Tagged v$NEW (not pushed)"
else
  git push --atomic origin main "v$NEW"
  echo "Pushed v$NEW"
fi

echo ""
echo "To update the installed plugin:"
echo "  /plugin marketplace update learning-loop-marketplace"
echo "  /plugin install learning-loop@learning-loop-marketplace"
