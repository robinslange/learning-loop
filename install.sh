#!/usr/bin/env bash
#
# learning-loop bootstrap
# https://github.com/robinslange/learning-loop
#
# This script takes a fresh macOS or Linux machine to a state where
# /learning-loop:init can be run inside Claude Code.
#
# Inspect first: curl -fsSL https://raw.githubusercontent.com/robinslange/learning-loop/main/install.sh | less
# Then run:      curl -fsSL https://raw.githubusercontent.com/robinslange/learning-loop/main/install.sh | bash
#
# Resolved constants (pinned 2026-05-20):
#   MIN_NODE_MAJOR=22
#   MIN_CLAUDE_VERSION="2.1.144"
#   CLAUDE_INSTALLER="curl -fsSL https://claude.ai/install.sh | bash"
#   CLAUDE_SESSION_VAR="CLAUDECODE"
#

set -euo pipefail

if [ -z "${LL_INSTALL_LOADED:-}" ]; then
  readonly LL_INSTALL_LOADED="1"
  readonly SELF_URL="https://raw.githubusercontent.com/robinslange/learning-loop/main/install.sh"
  readonly LOG_FILE="$HOME/.cache/learning-loop-install.log"
  readonly MIN_NODE_MAJOR=22
  readonly MIN_CLAUDE_VERSION="2.1.144"
  readonly CLAUDE_SESSION_VAR="CLAUDECODE"
  readonly MARKER_PREFIX="learning-loop-install: PATH"
  readonly MARKER_TAG="${MARKER_PREFIX} v1"

  readonly C_DIM="$(printf '\033[2m')"
  readonly C_GREEN="$(printf '\033[32m')"
  readonly C_YELLOW="$(printf '\033[33m')"
  readonly C_RED="$(printf '\033[31m')"
  readonly C_RESET="$(printf '\033[0m')"
fi

START_TIME=${START_TIME:-}
STEPS_RUN=${STEPS_RUN:-0}
STEPS_SKIPPED=${STEPS_SKIPPED:-0}
: "${STEP_NAME:=}"
: "${STEP_T0:=0}"
: "${PLATFORM:=}"
: "${OLD_NODE_VERSION:=}"

init_log_state() {
  mkdir -p "$(dirname "$LOG_FILE")"
  : >"$LOG_FILE"
  START_TIME=$(date +%s)
  STEPS_RUN=0
  STEPS_SKIPPED=0
}

on_interrupt() {
  echo
  echo "${C_YELLOW}Interrupted.${C_RESET} Log saved to $LOG_FILE"
  echo "Re-run when ready: curl -fsSL $SELF_URL | bash"
  exit 130
}
trap on_interrupt INT TERM

on_exit() {
  local code=$?
  if [ "$code" -ne 0 ] && [ "$code" -ne 130 ] && [ -z "${LL_INSTALL_NO_TRAP:-}" ]; then
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
  bash -c "$*" >>"$LOG_FILE" 2>&1 &
  local pid=$!
  local spinner='|/-\'
  local i=0
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r→ %s... ${spinner:$((i % 4)):1}" "$STEP_NAME"
    i=$((i + 1))
    sleep 0.1
  done
  wait "$pid"
  return $?
}

run_capture() {
  bash -c "$*" 2>>"$LOG_FILE"
}

# Read a prompt answer into $ans from the controlling terminal. Leaves $ans
# empty (so each prompt's default applies) when LL_INSTALL_ASSUME_NO is set
# or no usable terminal is attached — non-interactive runs (CI, bats) must
# never block on /dev/tty.
prompt_read() {
  ans=""
  if [ -n "${LL_INSTALL_ASSUME_NO:-}" ]; then
    return 0
  fi
  if [ ! -e /dev/tty ] || [ ! -t 1 ]; then
    return 0
  fi
  read -r ans </dev/tty 2>/dev/null || ans=""
}

detect_platform() {
  step_start "Detecting platform"
  local kernel arch ans
  kernel=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m)
  case "${kernel}-${arch}" in
    darwin-arm64)        PLATFORM="darwin-arm64" ;;
    linux-x86_64)        PLATFORM="linux-x86_64" ;;
    darwin-x86_64|linux-aarch64)
      PLATFORM="${kernel}-${arch}"
      step_fail "No prebuilt ll-search binary for ${PLATFORM}"
      echo "Prebuilt binaries cover: macOS arm64 (Apple Silicon), Linux x86_64 (also used by WSL), Windows x64."
      echo "On ${PLATFORM}, /learning-loop:init cannot download the search binary; you would"
      echo "need a Rust toolchain to build it from source (cd native && cargo build --release)."
      echo "See guide/cross-platform.md in the repo for details."
      echo "  ${C_DIM}Continue anyway (you'll build ll-search from source)? [y/N]${C_RESET}"
      prompt_read
      case "$ans" in
        y|Y) ;;
        *) exit 1 ;;
      esac
      ;;
    *)
      step_fail "Unsupported platform: ${kernel}-${arch}"
      echo "This installer is bash, so it covers: macOS (Apple Silicon arm64), Linux (x86_64), WSL (x86_64)."
      echo "Native Windows x64 is supported by the plugin itself — install it manually:"
      echo "  claude plugin marketplace add robinslange/learning-loop"
      echo "  claude plugin install learning-loop@learning-loop-marketplace"
      echo "See guide/cross-platform.md for per-platform status."
      exit 1
      ;;
  esac
  step_done "${PLATFORM}"
}

detect_proxy() {
  step_start "Checking proxy"
  if [ -n "${HTTPS_PROXY:-}${HTTP_PROXY:-}${https_proxy:-}${http_proxy:-}" ]; then
    step_skip "using ${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-}}}}"
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
      step_skip "node v$(node -v | sed 's/^v//') already installed"
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
    prompt_read
    case "${ans:-y}" in
      y|Y|"") ;;
      *) step_fail "declined; install Node ${MIN_NODE_MAJOR}+ manually and re-run"; exit 1 ;;
    esac
  elif [ ${#managers[@]} -eq 1 ]; then
    chosen_manager="${managers[0]}"
    echo
    echo "  ${C_DIM}Node ${MIN_NODE_MAJOR}+ required (found: ${OLD_NODE_VERSION:-none}).${C_RESET}"
    echo "  ${C_DIM}Found ${chosen_manager}. Install Node ${MIN_NODE_MAJOR} with it? [Y/n]${C_RESET}"
    prompt_read
    case "${ans:-y}" in
      y|Y|"") ;;
      *) chosen_manager="fnm-new" ;;
    esac
  else
    echo
    echo "  ${C_DIM}Multiple Node managers found: ${managers[*]}${C_RESET}"
    echo "  ${C_DIM}Which should install Node ${MIN_NODE_MAJOR}? (default: ${managers[0]})${C_RESET}"
    prompt_read
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

  if grep -qF "$MARKER_PREFIX" "$shell_rc" 2>/dev/null; then
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
    installed=$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
    if [ -n "$installed" ] && version_ge "$installed" "$MIN_CLAUDE_VERSION"; then
      step_skip "claude $installed already installed"
      return 0
    fi
    echo
    echo "  ${C_YELLOW}Claude Code $installed is older than required ($MIN_CLAUDE_VERSION).${C_RESET}"
    echo "  ${C_DIM}Upgrade now? [Y/n]${C_RESET}"
    prompt_read
    case "${ans:-y}" in
      y|Y|"") ;;
      *) step_fail "Claude Code $MIN_CLAUDE_VERSION+ required"; exit 1 ;;
    esac
  fi

  install_claude_code
}

install_claude_code() {
  step_start "Installing Claude Code"
  run_logged 'curl -fsSL https://claude.ai/install.sh | bash'

  if ! command -v claude >/dev/null 2>&1; then
    step_fail "Claude Code install completed but 'claude' is not on PATH"
    echo "  Manual recovery: see https://docs.anthropic.com/en/docs/claude-code for install instructions"
    exit 1
  fi
  step_done "claude $(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
}

add_marketplaces() {
  step_start "Adding marketplaces"
  local mp added=0
  for mp in "obra/superpowers-marketplace" "robinslange/learning-loop"; do
    local log_size_before
    log_size_before=$(wc -c <"$LOG_FILE" 2>/dev/null || echo 0)
    if run_logged "claude plugin marketplace add $mp"; then
      local new_output
      new_output=$(tail -c "+$((log_size_before + 1))" "$LOG_FILE" 2>/dev/null || echo "")
      if echo "$new_output" | grep -qE "already on disk|already added|already exists"; then
        :
      else
        added=$((added + 1))
      fi
    else
      local rc=$?
      step_fail "failed to add marketplace $mp (exit $rc)"
      echo "  See $LOG_FILE for details."
      exit 1
    fi
  done
  if [ "$added" -eq 0 ]; then
    step_skip "2 marketplaces already on disk"
  else
    step_done "$added new, $((2 - added)) already on disk"
  fi
}

install_plugins() {
  step_start "Installing plugins"
  local p name added=0
  local installed_versions=()
  for p in "episodic-memory@superpowers-marketplace" "learning-loop@learning-loop-marketplace"; do
    name="${p%%@*}"
    local log_size_before
    log_size_before=$(wc -c <"$LOG_FILE" 2>/dev/null || echo 0)
    if run_logged "claude plugin install $p"; then
      local new_output
      new_output=$(tail -c "+$((log_size_before + 1))" "$LOG_FILE" 2>/dev/null || echo "")
      local v
      v=$(claude plugin list 2>/dev/null | awk -v n="${p}" '$0 ~ n {f=1; next} /Version:/ && f {print $2; f=0; exit}' || true)
      if echo "$new_output" | grep -qE "already installed"; then
        installed_versions+=("${name} ${v:-?} already")
      else
        added=$((added + 1))
        installed_versions+=("${name} ${v:-?}")
      fi
    else
      local rc=$?
      step_fail "failed to install $p (exit $rc)"
      if [ "$name" = "episodic-memory" ]; then
        echo "  episodic-memory is a hard dependency; /init will not work without it."
      fi
      echo "  See $LOG_FILE for details."
      exit 1
    fi
  done
  if [ "$added" -eq 0 ]; then
    step_skip "$(IFS=', '; echo "${installed_versions[*]}")"
  else
    step_done "$(IFS=', '; echo "${installed_versions[*]}")"
  fi
}

# Locate the generate-agents script in whichever copy of the plugin exists:
# the repo checkout this script sits in, the Claude Code plugin cache, or the
# Codex plugin cache. Newest version wins in the cache directories.
find_codex_generator() {
  local rel="scripts/codex/generate-agents.mjs"
  local here=""
  [[ -n "${BASH_SOURCE[0]:-}" ]] && here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -n "$here" ] && [ -f "$here/plugin/$rel" ]; then
    printf '%s\n' "$here/plugin/$rel"
    return 0
  fi
  local base
  for base in "$HOME/.claude/plugins/cache/learning-loop-marketplace/learning-loop" \
    "$HOME/.codex/plugins/cache/learning-loop-marketplace/learning-loop"; do
    [ -d "$base" ] || continue
    local found
    found=$(find "$base" -maxdepth 2 -path "*/$rel" 2>/dev/null | sort -V | tail -1)
    [ -n "$found" ] && printf '%s\n' "$found" && return 0
  done
  return 1
}

# Codex reads the same skills and the same hooks/hooks.json out of the plugin
# tree, so those need nothing here. Subagents are the exception: Codex has no
# manifest field for them and loads them from standalone TOML in ~/.codex/agents,
# so they are generated at install time from the same markdown definitions.
setup_codex() {
  step_start "Configuring Codex"

  if ! command -v codex >/dev/null 2>&1; then
    step_skip "codex not on PATH — skipping (re-run this installer after installing Codex)"
    return 0
  fi

  local generator
  if ! generator=$(find_codex_generator); then
    step_fail "could not locate the learning-loop plugin tree to generate agents from"
    return 0
  fi

  if ! run_logged "node \"$generator\" --out \"$HOME/.codex/agents\""; then
    step_fail "agent generation failed (exit $?)"
    echo "  See $LOG_FILE for details."
    return 0
  fi

  run_logged "codex plugin marketplace add robinslange/learning-loop" || true

  local codex_config="$HOME/.codex/config.toml"
  local notes=()
  if [ ! -f "$codex_config" ] || ! grep -q "shell_environment_policy" "$codex_config" 2>/dev/null; then
    mkdir -p "$HOME/.codex"
    cat >>"$codex_config" <<'EOF'

# --- learning-loop ---
# Codex gives commands no marker saying which harness launched them, so the
# plugin's scripts read this to tell Codex from Claude Code.
[shell_environment_policy]
set = { LL_HARNESS = "codex" }
EOF
  else
    notes+=("add \`set = { LL_HARNESS = \"codex\" }\` under [shell_environment_policy] in $codex_config")
  fi

  local count
  count=$(ls -1 "$HOME/.codex/agents"/learning-loop-*.toml 2>/dev/null | wc -l | tr -d ' ')
  step_done "$count agents written to ~/.codex/agents"

  echo "  ${C_DIM}Codex will not run plugin hooks until you trust them: run ${C_RESET}/hooks${C_DIM} in Codex.${C_RESET}"
  local n
  for n in "${notes[@]:-}"; do
    [ -n "$n" ] && echo "  ${C_DIM}Manual step: $n${C_RESET}"
  done
}

version_ge() {
  printf '%s\n%s\n' "$2" "$1" | sort -V -C
}

print_next_steps() {
  local elapsed=$(($(date +%s) - START_TIME))
  local m=$((elapsed / 60))
  local s=$((elapsed % 60))

  echo
  if [ "$STEPS_RUN" -le 1 ]; then
    echo "${C_GREEN}✓ Already set up${C_RESET} (${STEPS_SKIPPED} steps skipped, ${s}s elapsed)."
    return 0
  fi

  echo "${C_GREEN}✓ Done.${C_RESET} ${m}m ${s}s elapsed (${STEPS_RUN} steps ran, ${STEPS_SKIPPED} skipped)."
  echo

  if [ -n "${!CLAUDE_SESSION_VAR:-}" ]; then
    echo "Next: ${C_DIM}Restart Claude Code${C_RESET} (the new plugin won't activate in this session)"
    echo "      and run ${C_GREEN}/learning-loop:init${C_RESET}"
  else
    echo "Next: Open Claude Code and run ${C_GREEN}/learning-loop:init${C_RESET}"
    echo "      This will configure your vault, persona voice, and download the ll-search binary."
  fi
}

preamble() {
  cat <<'EOF'
learning-loop bootstrap
=======================
This will:
  1. Verify your platform has a prebuilt binary (macOS arm64 / Linux x86_64 / WSL x86_64)
  2. Ensure Node.js 22+ is available (detects nvm, fnm, volta, asdf, mise, n, brew)
  3. Ensure ~/.local/bin is on PATH
  4. Install Claude Code if missing
  5. Add the learning-loop + episodic-memory marketplaces
  6. Install both plugins
  7. Configure Codex too, if it is installed

Estimated time: ~3 minutes.
EOF
  echo
}

main() {
  init_log_state
  preamble
  detect_platform
  detect_proxy
  ensure_node
  ensure_local_bin_path
  ensure_claude_code
  add_marketplaces
  install_plugins
  setup_codex
  print_next_steps
}

# Run main if executed directly or piped via stdin (curl ... | bash).
# Skip only when explicitly sourced (e.g. by bats tests).
if [[ -z "${BASH_SOURCE[0]:-}" ]] || [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
