#!/usr/bin/env bash
#
# learning-loop bootstrap
# https://github.com/robinslange/learning-loop
#
# This script takes a fresh macOS or Linux machine to a state where
# /learning-loop:init can be run inside Claude Code.
#
# Inspect first: curl -fsSL <url> | less
# Then run:      curl -fsSL <url> | bash
#
# Resolved constants (pinned 2026-05-20):
#   MIN_NODE_MAJOR=22
#   MIN_CLAUDE_VERSION="2.1.144"
#   CLAUDE_INSTALLER="curl -fsSL https://claude.ai/install.sh | bash"
#   CLAUDE_SESSION_VAR="CLAUDECODE"
#

set -euo pipefail

readonly INSTALL_VERSION="1"
readonly LOG_FILE="$HOME/.cache/learning-loop-install.log"
readonly MIN_NODE_MAJOR=22
readonly MIN_CLAUDE_VERSION="2.1.144"
readonly CLAUDE_SESSION_VAR="CLAUDECODE"
readonly MARKER_TAG="learning-loop-install: PATH v${INSTALL_VERSION}"

readonly C_DIM="$(printf '\033[2m')"
readonly C_GREEN="$(printf '\033[32m')"
readonly C_YELLOW="$(printf '\033[33m')"
readonly C_RED="$(printf '\033[31m')"
readonly C_RESET="$(printf '\033[0m')"

mkdir -p "$(dirname "$LOG_FILE")"
: >"$LOG_FILE"

START_TIME=$(date +%s)
STEPS_RUN=0
STEPS_SKIPPED=0

on_interrupt() {
  echo
  echo "${C_YELLOW}Interrupted.${C_RESET} Log saved to $LOG_FILE"
  echo "Re-run when ready: curl -fsSL <url> | bash"
  exit 130
}
trap on_interrupt INT TERM

on_exit() {
  local code=$?
  if [ "$code" -ne 0 ] && [ "$code" -ne 130 ]; then
    echo
    echo "${C_RED}Failed.${C_RESET} See $LOG_FILE for details."
  fi
}
trap on_exit EXIT

main() {
  preamble
  detect_platform
  detect_proxy
  ensure_node
  ensure_local_bin_path
  ensure_claude_code
  add_marketplaces
  install_plugins
  print_next_steps
}

preamble() {
  cat <<'EOF'
learning-loop bootstrap
=======================
This will:
  1. Verify your platform is supported (macOS / Linux / WSL)
  2. Ensure Node.js 22+ is available (detects nvm, fnm, volta, asdf, mise, n, brew)
  3. Ensure ~/.local/bin is on PATH
  4. Install Claude Code if missing
  5. Add the learning-loop + episodic-memory marketplaces
  6. Install both plugins

Estimated time: ~3 minutes.
EOF
  echo
}

main "$@"
