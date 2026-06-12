#!/usr/bin/env bats

setup() {
  source "${BATS_TEST_DIRNAME}/../../install.sh"
  STEPS_RUN=0
  STEPS_SKIPPED=0
}

@test "version_ge: 1.2.3 >= 1.2.0" {
  run version_ge "1.2.3" "1.2.0"
  [ "$status" -eq 0 ]
}

@test "version_ge: 1.2.3 >= 1.2.3" {
  run version_ge "1.2.3" "1.2.3"
  [ "$status" -eq 0 ]
}

@test "version_ge: 1.2.0 < 1.2.3" {
  run version_ge "1.2.0" "1.2.3"
  [ "$status" -ne 0 ]
}

@test "PATH marker is idempotent — written only once" {
  local fake_home
  fake_home=$(mktemp -d)
  HOME="$fake_home" SHELL="/bin/zsh" PATH="/usr/bin:/bin" ensure_local_bin_path
  HOME="$fake_home" SHELL="/bin/zsh" PATH="/usr/bin:/bin" ensure_local_bin_path
  local count
  count=$(grep -cF "$MARKER_TAG" "$fake_home/.zshrc")
  [ "$count" -eq 1 ]
}

@test "PATH marker — bash shell writes to .bashrc" {
  local fake_home
  fake_home=$(mktemp -d)
  HOME="$fake_home" SHELL="/bin/bash" PATH="/usr/bin:/bin" ensure_local_bin_path
  [ -f "$fake_home/.bashrc" ]
  grep -qF "$MARKER_TAG" "$fake_home/.bashrc"
}

@test "PATH marker - already on PATH skips rc edit" {
  local fake_home orig_home orig_shell
  fake_home=$(mktemp -d)
  orig_home="$HOME"
  orig_shell="$SHELL"
  HOME="$fake_home" SHELL="/bin/zsh" PATH="$fake_home/.local/bin:$PATH" ensure_local_bin_path >/dev/null 2>&1
  HOME="$orig_home"
  SHELL="$orig_shell"
  [ ! -f "$fake_home/.zshrc" ]
}

@test "install_node_via_manager — picks nvm when only nvm present" {
  local fake_home fake_bin
  fake_home=$(mktemp -d)
  fake_bin=$(mktemp -d)
  mkdir -p "$fake_home/.nvm"
  echo "true" >"$fake_home/.nvm/nvm.sh"
  run bash -c "
    trap - EXIT INT TERM
    source '${BATS_TEST_DIRNAME}/../../install.sh'
    trap - EXIT INT TERM
    install_via_manager() { echo \"PICKED:\$1\"; exit 0; }
    HOME='$fake_home' PATH='$fake_bin:/usr/bin:/bin' PLATFORM='linux-x86_64' OLD_NODE_VERSION='v18.0.0' \
      install_node_via_manager <<< ''
  "
  [[ "$output" == *"PICKED:nvm"* ]]
}

@test "install_node_via_manager — picks fnm when only fnm present" {
  local fake_home fake_bin
  fake_home=$(mktemp -d)
  fake_bin=$(mktemp -d)
  cat >"$fake_bin/fnm" <<'EOF'
#!/usr/bin/env bash
echo "fnm 1.38.0"
EOF
  chmod +x "$fake_bin/fnm"
  run bash -c "
    trap - EXIT INT TERM
    source '${BATS_TEST_DIRNAME}/../../install.sh'
    trap - EXIT INT TERM
    install_via_manager() { echo \"PICKED:\$1\"; exit 0; }
    HOME='$fake_home' PATH='$fake_bin:/usr/bin:/bin' PLATFORM='linux-x86_64' OLD_NODE_VERSION='v18.0.0' \
      install_node_via_manager <<< ''
  "
  [[ "$output" == *"PICKED:fnm"* ]]
}

@test "install_node_via_manager — picks nvm first when multiple managers present" {
  local fake_home fake_bin
  fake_home=$(mktemp -d)
  fake_bin=$(mktemp -d)
  mkdir -p "$fake_home/.nvm"
  echo "true" >"$fake_home/.nvm/nvm.sh"
  for tool in fnm volta; do
    cat >"$fake_bin/$tool" <<EOF
#!/usr/bin/env bash
echo "$tool fake"
EOF
    chmod +x "$fake_bin/$tool"
  done
  run bash -c "
    trap - EXIT INT TERM
    source '${BATS_TEST_DIRNAME}/../../install.sh'
    trap - EXIT INT TERM
    install_via_manager() { echo \"PICKED:\$1\"; exit 0; }
    HOME='$fake_home' PATH='$fake_bin:/usr/bin:/bin' PLATFORM='linux-x86_64' OLD_NODE_VERSION='v18.0.0' \
      install_node_via_manager <<< ''
  "
  [[ "$output" == *"PICKED:nvm"* ]]
}

# ---------------------------------------------------------------------------
# step_skip / step_done / step_fail — set -u regression (Fix 3)
# ---------------------------------------------------------------------------

@test "step_skip works under set -u without prior step_start" {
  run bash -uc "
    export LL_INSTALL_NO_TRAP=1
    source '${BATS_TEST_DIRNAME}/../../install.sh'
    step_skip 'test message'
  "
  [ "$status" -eq 0 ]
  [[ "$output" == *"test message"* ]]
}

@test "step_done works under set -u without prior step_start" {
  run bash -uc "
    export LL_INSTALL_NO_TRAP=1
    source '${BATS_TEST_DIRNAME}/../../install.sh'
    step_done 'test detail'
  "
  [ "$status" -eq 0 ]
  [[ "$output" == *"test detail"* ]]
}

@test "step_fail works under set -u without prior step_start" {
  run bash -uc "
    export LL_INSTALL_NO_TRAP=1
    source '${BATS_TEST_DIRNAME}/../../install.sh'
    step_fail 'test fail msg'
  "
  [ "$status" -eq 0 ]
  [[ "$output" == *"test fail msg"* ]]
}

# ---------------------------------------------------------------------------
# version_ge — edge cases
# ---------------------------------------------------------------------------

@test "version_ge: multi-digit minor (1.10.0 >= 1.9.0)" {
  run version_ge "1.10.0" "1.9.0"
  [ "$status" -eq 0 ]
}

@test "version_ge: major bumps (2.0.0 >= 1.99.99)" {
  run version_ge "2.0.0" "1.99.99"
  [ "$status" -eq 0 ]
}

@test "version_ge: patch-only diff (1.0.10 >= 1.0.2)" {
  run version_ge "1.0.10" "1.0.2"
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# detect_platform — uname mocking
# ---------------------------------------------------------------------------

@test "detect_platform: darwin-arm64 sets PLATFORM correctly" {
  local fake_bin
  fake_bin=$(mktemp -d)
  cat >"$fake_bin/uname" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  -s) echo "Darwin" ;;
  -m) echo "arm64" ;;
esac
EOF
  chmod +x "$fake_bin/uname"
  run bash -c "
    export LL_INSTALL_NO_TRAP=1
    export PATH='$fake_bin:/usr/bin:/bin'
    source '${BATS_TEST_DIRNAME}/../../install.sh'
    detect_platform
    echo \"PLATFORM=\$PLATFORM\"
  "
  [ "$status" -eq 0 ]
  [[ "$output" == *"PLATFORM=darwin-arm64"* ]]
}

@test "detect_platform: linux-x86_64 sets PLATFORM correctly" {
  local fake_bin
  fake_bin=$(mktemp -d)
  cat >"$fake_bin/uname" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  -s) echo "Linux" ;;
  -m) echo "x86_64" ;;
esac
EOF
  chmod +x "$fake_bin/uname"
  run bash -c "
    export LL_INSTALL_NO_TRAP=1
    export PATH='$fake_bin:/usr/bin:/bin'
    source '${BATS_TEST_DIRNAME}/../../install.sh'
    detect_platform
    echo \"PLATFORM=\$PLATFORM\"
  "
  [ "$status" -eq 0 ]
  [[ "$output" == *"PLATFORM=linux-x86_64"* ]]
}

@test "detect_platform: darwin-x86_64 (no prebuilt binary) exits 1 non-interactively" {
  local fake_bin
  fake_bin=$(mktemp -d)
  cat >"$fake_bin/uname" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  -s) echo "Darwin" ;;
  -m) echo "x86_64" ;;
esac
EOF
  chmod +x "$fake_bin/uname"
  run bash -c "
    export LL_INSTALL_NO_TRAP=1
    export PATH='$fake_bin:/usr/bin:/bin'
    source '${BATS_TEST_DIRNAME}/../../install.sh'
    detect_platform </dev/null 2>/dev/null
  "
  [ "$status" -eq 1 ]
  [[ "$output" == *"No prebuilt ll-search binary"* ]]
  [[ "$output" == *"build it from source"* ]]
}

@test "detect_platform: linux-aarch64 (no prebuilt binary) exits 1 non-interactively" {
  local fake_bin
  fake_bin=$(mktemp -d)
  cat >"$fake_bin/uname" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  -s) echo "Linux" ;;
  -m) echo "aarch64" ;;
esac
EOF
  chmod +x "$fake_bin/uname"
  run bash -c "
    export LL_INSTALL_NO_TRAP=1
    export PATH='$fake_bin:/usr/bin:/bin'
    source '${BATS_TEST_DIRNAME}/../../install.sh'
    detect_platform </dev/null 2>/dev/null
  "
  [ "$status" -eq 1 ]
  [[ "$output" == *"No prebuilt ll-search binary"* ]]
}

@test "detect_platform: unsupported platform exits 1" {
  local fake_bin
  fake_bin=$(mktemp -d)
  cat >"$fake_bin/uname" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  -s) echo "OpenBSD" ;;
  -m) echo "sparc64" ;;
esac
EOF
  chmod +x "$fake_bin/uname"
  run bash -c "
    export LL_INSTALL_NO_TRAP=1
    export PATH='$fake_bin:/usr/bin:/bin'
    source '${BATS_TEST_DIRNAME}/../../install.sh'
    detect_platform
  "
  [ "$status" -eq 1 ]
  [[ "$output" == *"Unsupported platform"* ]]
}

# ---------------------------------------------------------------------------
# detect_proxy — env var combinations
# ---------------------------------------------------------------------------

@test "detect_proxy: no proxy reports 'none set'" {
  run bash -c "
    export LL_INSTALL_NO_TRAP=1
    unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy
    source '${BATS_TEST_DIRNAME}/../../install.sh'
    detect_proxy
  "
  [ "$status" -eq 0 ]
  [[ "$output" == *"none set"* ]]
}

@test "detect_proxy: HTTPS_PROXY reports the URL" {
  run bash -c "
    export LL_INSTALL_NO_TRAP=1
    export HTTPS_PROXY='http://example:8080'
    unset HTTP_PROXY https_proxy http_proxy
    source '${BATS_TEST_DIRNAME}/../../install.sh'
    detect_proxy
  "
  [ "$status" -eq 0 ]
  [[ "$output" == *"http://example:8080"* ]]
}

@test "detect_proxy: lowercase http_proxy fallback works" {
  run bash -c "
    export LL_INSTALL_NO_TRAP=1
    unset HTTPS_PROXY HTTP_PROXY https_proxy
    export http_proxy='http://lowercase:9090'
    source '${BATS_TEST_DIRNAME}/../../install.sh'
    detect_proxy
  "
  [ "$status" -eq 0 ]
  [[ "$output" == *"http://lowercase:9090"* ]]
}

# ---------------------------------------------------------------------------
# run_logged — exit code propagation + log writes
# ---------------------------------------------------------------------------

@test "run_logged: propagates success exit code" {
  run bash -c '
    export LL_INSTALL_NO_TRAP=1
    export LL_INSTALL_LOADED=1
    export LOG_FILE=$(mktemp)
    export STEP_NAME="test step"
    source '"'${BATS_TEST_DIRNAME}/../../install.sh'"'
    run_logged "exit 0"
    echo "rc=$?"
  '
  [[ "$output" == *"rc=0"* ]]
}

@test "run_logged: propagates failure exit code" {
  run bash -c '
    export LL_INSTALL_NO_TRAP=1
    export LL_INSTALL_LOADED=1
    export LOG_FILE=$(mktemp)
    export STEP_NAME="test step"
    source '"'${BATS_TEST_DIRNAME}/../../install.sh'"'
    set +e
    run_logged "exit 7"
    echo "rc=$?"
  '
  [[ "$output" == *"rc=7"* ]]
}

@test "run_logged: writes command echo to log" {
  local log
  log=$(mktemp)
  run bash -c "
    export LL_INSTALL_NO_TRAP=1
    export LL_INSTALL_LOADED=1
    export LOG_FILE='$log'
    export STEP_NAME='test step'
    source '${BATS_TEST_DIRNAME}/../../install.sh'
    run_logged 'echo hello'
  "
  [ "$status" -eq 0 ]
  grep -q ">>> echo hello" "$log"
  grep -q "^hello\$" "$log"
}

# ---------------------------------------------------------------------------
# ensure_local_bin_path — fish and nushell shells
# ---------------------------------------------------------------------------

@test "PATH marker — fish shell writes fish syntax to config.fish" {
  local fake_home
  fake_home=$(mktemp -d)
  HOME="$fake_home" SHELL="/usr/bin/fish" PATH="/usr/bin:/bin" ensure_local_bin_path
  [ -f "$fake_home/.config/fish/config.fish" ]
  grep -qF "set -gx PATH" "$fake_home/.config/fish/config.fish"
}

@test "PATH marker — nushell shell writes nu syntax to env.nu" {
  local fake_home
  fake_home=$(mktemp -d)
  HOME="$fake_home" SHELL="/usr/bin/nu" PATH="/usr/bin:/bin" ensure_local_bin_path
  [ -f "$fake_home/.config/nushell/env.nu" ]
  grep -qF '$env.PATH' "$fake_home/.config/nushell/env.nu"
}

@test "PATH marker — unknown shell uses step_skip and continues" {
  local fake_home
  fake_home=$(mktemp -d)
  HOME="$fake_home" SHELL="/some/exotic/shell" PATH="/usr/bin:/bin" ensure_local_bin_path
  [ ! -f "$fake_home/.bashrc" ]
  [ ! -f "$fake_home/.zshrc" ]
  [ ! -f "$fake_home/.config/fish/config.fish" ]
  [ ! -f "$fake_home/.config/nushell/env.nu" ]
}

# ---------------------------------------------------------------------------
# read-from-tty fallback — EOF stdin under set -e (regression)
# ---------------------------------------------------------------------------

@test "read-prompt-pattern: survives EOF stdin under set -e (regression)" {
  # printf "" | supplies EOF stdin without redirecting bats' own stdin (<<< "" causes bats to crash).
  # 2>/dev/null suppresses "Device not configured" from /dev/tty on CI-like environments.
  run bash -c '
    printf "" | bash -c '"'"'
      set -euo pipefail
      prompt() {
        read -r ans </dev/tty 2>/dev/null || ans=""
        echo "[ans=$ans]"
      }
      prompt
    '"'"' 2>/dev/null
  '
  [ "$status" -eq 0 ]
  [[ "$output" == "[ans=]" ]]
}

# ---------------------------------------------------------------------------
# install_node_via_manager — non-interactive defaults to fnm-new
# ---------------------------------------------------------------------------

@test "install_node_via_manager: no managers + non-interactive defaults to fnm-new" {
  local fake_home fake_bin
  fake_home=$(mktemp -d)
  fake_bin=$(mktemp -d)
  run bash -c "
    export LL_INSTALL_NO_TRAP=1
    source '${BATS_TEST_DIRNAME}/../../install.sh'
    install_via_manager() { echo \"PICKED:\$1\"; exit 0; }
    HOME='$fake_home' PATH='$fake_bin' PLATFORM='linux-x86_64' OLD_NODE_VERSION='' \
      install_node_via_manager </dev/null
  "
  [[ "$output" == *"PICKED:fnm-new"* ]]
}
