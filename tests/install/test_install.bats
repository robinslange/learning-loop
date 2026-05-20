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
