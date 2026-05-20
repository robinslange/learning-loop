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

step_start() {
  STEP_NAME="$1"
  STEP_T0=$(date +%s)
  printf "→ %s..." "$STEP_NAME"
}

step_done() {
  local elapsed=$(($(date +%s) - STEP_T0))
  STEPS_RUN=$((STEPS_RUN + 1))
  if [ $# -gt 0 ]; then
    printf "\r${C_GREEN}✓${C_RESET} %s ${C_DIM}(%ds) — %s${C_RESET}\n" "$STEP_NAME" "$elapsed" "$1"
  else
    printf "\r${C_GREEN}✓${C_RESET} %s ${C_DIM}(%ds)${C_RESET}\n" "$STEP_NAME" "$elapsed"
  fi
}

step_skip() {
  STEPS_SKIPPED=$((STEPS_SKIPPED + 1))
  printf "\r${C_DIM}↷ %s — %s${C_RESET}\n" "$STEP_NAME" "$1"
}

step_fail() {
  printf "\r${C_RED}✗${C_RESET} %s — %s\n" "$STEP_NAME" "$1"
}

run_logged() {
  echo ">>> $*" >>"$LOG_FILE"
  bash -c "$*" >>"$LOG_FILE" 2>&1
}

run_capture() {
  bash -c "$*" 2>>"$LOG_FILE"
}

detect_platform() {
  step_start "Detecting platform"
  local kernel arch
  kernel=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m)
  case "${kernel}-${arch}" in
    darwin-arm64)        PLATFORM="darwin-arm64" ;;
    darwin-x86_64)       PLATFORM="darwin-x86_64" ;;
    linux-x86_64)        PLATFORM="linux-x86_64" ;;
    linux-aarch64)       PLATFORM="linux-aarch64" ;;
    *)
      step_fail "Unsupported platform: ${kernel}-${arch}"
      echo "Supported: macOS (arm64/x86_64), Linux (x86_64/aarch64), WSL."
      echo "If you're on native Windows, use WSL: https://learn.microsoft.com/en-us/windows/wsl/install"
      exit 1
      ;;
  esac
  step_done "${PLATFORM}"
}

detect_proxy() {
  step_start "Checking proxy"
  if [ -n "${HTTPS_PROXY:-}${HTTP_PROXY:-}${https_proxy:-}${http_proxy:-}" ]; then
    step_done "using ${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-}}}}"
  else
    step_skip "none set"
  fi
}

ensure_node() {
  step_start "Checking Node.js"
  if command -v node >/dev/null 2>&1; then
    local v
    v=$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)
    if [ -n "$v" ] && [ "$v" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null; then
      step_done "node v$(node -v | sed 's/^v//')"
      return 0
    fi
    OLD_NODE_VERSION=$(node -v 2>/dev/null || echo "unknown")
  else
    OLD_NODE_VERSION=""
  fi

  install_node_via_manager
}

install_node_via_manager() {
  local managers=()
  local chosen_manager=""
  [ -s "$HOME/.nvm/nvm.sh" ] && managers+=("nvm")
  command -v fnm >/dev/null 2>&1 && managers+=("fnm")
  command -v volta >/dev/null 2>&1 && managers+=("volta")
  if command -v asdf >/dev/null 2>&1 && asdf plugin list 2>/dev/null | grep -q '^nodejs$'; then
    managers+=("asdf")
  fi
  command -v mise >/dev/null 2>&1 && managers+=("mise")
  command -v n >/dev/null 2>&1 && managers+=("n")
  if [[ "$PLATFORM" == darwin-* ]] && command -v brew >/dev/null 2>&1; then
    managers+=("brew")
  fi

  if [ ${#managers[@]} -eq 0 ]; then
    chosen_manager="fnm-new"
    echo
    echo "  ${C_DIM}Node ${MIN_NODE_MAJOR}+ required (found: ${OLD_NODE_VERSION:-none}).${C_RESET}"
    echo "  ${C_DIM}No version manager detected. Install Node ${MIN_NODE_MAJOR} via fnm? [Y/n]${C_RESET}"
    read -r ans
    case "${ans:-y}" in
      y|Y|"") ;;
      *) step_fail "declined; install Node ${MIN_NODE_MAJOR}+ manually and re-run"; exit 1 ;;
    esac
  elif [ ${#managers[@]} -eq 1 ]; then
    chosen_manager="${managers[0]}"
    echo
    echo "  ${C_DIM}Node ${MIN_NODE_MAJOR}+ required (found: ${OLD_NODE_VERSION:-none}).${C_RESET}"
    echo "  ${C_DIM}Found ${chosen_manager}. Install Node ${MIN_NODE_MAJOR} with it? [Y/n]${C_RESET}"
    read -r ans
    case "${ans:-y}" in
      y|Y|"") ;;
      *) chosen_manager="fnm-new" ;;
    esac
  else
    echo
    echo "  ${C_DIM}Multiple Node managers found: ${managers[*]}${C_RESET}"
    echo "  ${C_DIM}Which should install Node ${MIN_NODE_MAJOR}? (default: ${managers[0]})${C_RESET}"
    read -r ans
    chosen_manager="${ans:-${managers[0]}}"
  fi

  install_via_manager "$chosen_manager"
}

install_via_manager() {
  local manager="$1"
  step_start "Installing Node ${MIN_NODE_MAJOR} via ${manager}"
  case "$manager" in
    nvm)
      run_logged ". $HOME/.nvm/nvm.sh && nvm install ${MIN_NODE_MAJOR} && nvm alias default ${MIN_NODE_MAJOR}"
      export PATH="$HOME/.nvm/versions/node/$(. "$HOME/.nvm/nvm.sh" && nvm version default)/bin:$PATH"
      ;;
    fnm)
      run_logged "fnm install ${MIN_NODE_MAJOR} && fnm default ${MIN_NODE_MAJOR}"
      eval "$(fnm env)"
      ;;
    volta)
      run_logged "volta install node@${MIN_NODE_MAJOR}"
      export PATH="$HOME/.volta/bin:$PATH"
      ;;
    asdf)
      local latest
      latest=$(run_capture "asdf list-all nodejs | grep '^${MIN_NODE_MAJOR}\\.' | tail -1")
      run_logged "asdf install nodejs ${latest} && asdf global nodejs ${latest}"
      ;;
    mise)
      run_logged "mise use -g node@${MIN_NODE_MAJOR}"
      ;;
    n)
      run_logged "n ${MIN_NODE_MAJOR}"
      ;;
    brew)
      run_logged "brew install node@${MIN_NODE_MAJOR} && brew link --overwrite node@${MIN_NODE_MAJOR}"
      ;;
    fnm-new)
      run_logged "curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell"
      export PATH="$HOME/.local/share/fnm:$PATH"
      eval "$(fnm env)" 2>/dev/null || true
      run_logged "fnm install ${MIN_NODE_MAJOR} && fnm default ${MIN_NODE_MAJOR}"
      eval "$(fnm env)"
      ;;
    *)
      step_fail "unknown manager: $manager"
      exit 1
      ;;
  esac

  if ! command -v node >/dev/null 2>&1 || ! node -v | grep -qE "^v${MIN_NODE_MAJOR}\\."; then
    step_fail "Node ${MIN_NODE_MAJOR} install failed; node -v reports: $(node -v 2>/dev/null || echo none)"
    echo "  Manual recovery: install Node ${MIN_NODE_MAJOR}+ via your preferred method and re-run this script."
    exit 1
  fi
  step_done "node $(node -v)"
}

ensure_local_bin_path() {
  step_start "Ensuring ~/.local/bin on PATH"
  local local_bin="$HOME/.local/bin"
  mkdir -p "$local_bin"

  case ":$PATH:" in
    *":$local_bin:"*)
      step_skip "already on PATH"
      return 0
      ;;
  esac

  local shell_rc=""
  case "$(basename "${SHELL:-/bin/bash}")" in
    bash) shell_rc="$HOME/.bashrc" ;;
    zsh)  shell_rc="$HOME/.zshrc" ;;
    fish) shell_rc="$HOME/.config/fish/config.fish" ;;
    nu)   shell_rc="$HOME/.config/nushell/env.nu" ;;
    *)
      echo
      echo "  ${C_YELLOW}⚠${C_RESET} unknown shell $(basename "$SHELL"); add this to your shell rc manually:"
      echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
      export PATH="$local_bin:$PATH"
      step_skip "unknown shell — added to current session only"
      return 0
      ;;
  esac

  mkdir -p "$(dirname "$shell_rc")"
  touch "$shell_rc"

  if grep -qF "$MARKER_TAG" "$shell_rc" 2>/dev/null; then
    step_skip "marker already present in $shell_rc"
    export PATH="$local_bin:$PATH"
    return 0
  fi

  case "$(basename "${SHELL:-/bin/bash}")" in
    fish)
      cat >>"$shell_rc" <<EOF

# ${MARKER_TAG}
set -gx PATH \$HOME/.local/bin \$PATH
EOF
      ;;
    nu)
      cat >>"$shell_rc" <<EOF

# ${MARKER_TAG}
\$env.PATH = (\$env.PATH | prepend (\$nu.home-path | path join ".local/bin"))
EOF
      ;;
    *)
      cat >>"$shell_rc" <<EOF

# ${MARKER_TAG}
export PATH="\$HOME/.local/bin:\$PATH"
EOF
      ;;
  esac

  export PATH="$local_bin:$PATH"
  step_done "added to $shell_rc"
}

ensure_claude_code() {
  step_start "Checking Claude Code"
  if command -v claude >/dev/null 2>&1; then
    local installed
    installed=$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
    if [ -n "$installed" ] && version_ge "$installed" "$MIN_CLAUDE_VERSION"; then
      step_done "claude $installed"
      return 0
    fi
    echo
    echo "  ${C_YELLOW}Claude Code $installed is older than required ($MIN_CLAUDE_VERSION).${C_RESET}"
    echo "  ${C_DIM}Upgrade now? [Y/n]${C_RESET}"
    read -r ans
    case "${ans:-y}" in
      y|Y|"") ;;
      *) step_fail "Claude Code $MIN_CLAUDE_VERSION+ required"; exit 1 ;;
    esac
  fi

  install_claude_code
}

install_claude_code() {
  run_logged 'curl -fsSL https://claude.ai/install.sh | bash'

  if ! command -v claude >/dev/null 2>&1; then
    step_fail "Claude Code install completed but 'claude' is not on PATH"
    echo "  Manual recovery: see https://docs.anthropic.com/en/docs/claude-code for install instructions"
    exit 1
  fi
  step_done "claude $(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
}

version_ge() {
  printf '%s\n%s\n' "$2" "$1" | sort -V -C
}

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
