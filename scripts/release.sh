#!/usr/bin/env bash
# Bump version across all manifests, commit, tag, and push.
#
# Usage:
#   ./scripts/release.sh patch    # 1.2.2 -> 1.2.3
#   ./scripts/release.sh minor    # 1.2.2 -> 1.3.0
#   ./scripts/release.sh major    # 1.2.2 -> 2.0.0
#
# Flags:
#   --dry-run   Show what would happen without making changes
#   --no-push   Commit and tag locally but don't push

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR/.."
cd "$ROOT"

BUMP="${1:-}"
DRY_RUN=false
NO_PUSH=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --no-push) NO_PUSH=true ;;
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

# Update all versioned manifests
perl -i -pe "s/\"version\": \"$CURRENT\"/\"version\": \"$NEW\"/" \
  package.json \
  .claude-plugin/plugin.json

for cargo_toml in native/crates/*/Cargo.toml; do
  [ -f "$cargo_toml" ] && perl -i -pe "s/^version = \"[0-9]*\\.[0-9]*\\.[0-9]*\"/version = \"$NEW\"/" "$cargo_toml"
done

# Verify
for f in package.json .claude-plugin/plugin.json; do
  v=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$f','utf-8')).version)")
  if [ "$v" != "$NEW" ]; then
    echo "Error: $f version is $v, expected $NEW"
    git checkout -- package.json .claude-plugin/plugin.json
    exit 1
  fi
done

git add package.json .claude-plugin/plugin.json
git add native/crates/*/Cargo.toml 2>/dev/null
git commit -m "release: v$NEW"
git tag "v$NEW"

if $NO_PUSH; then
  echo "Tagged v$NEW (not pushed)"
else
  git push origin main --tags
  echo "Pushed v$NEW"
fi

echo ""
echo "To update the installed plugin:"
echo "  /plugin marketplace update learning-loop-marketplace"
echo "  /plugin install learning-loop@learning-loop-marketplace"
