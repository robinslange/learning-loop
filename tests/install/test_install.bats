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

@test "manager detection — nvm only" {
  local fake_home
  fake_home=$(mktemp -d)
  mkdir -p "$fake_home/.nvm"
  echo "echo '0.39.0'" >"$fake_home/.nvm/nvm.sh"
  chmod +x "$fake_home/.nvm/nvm.sh"
  local managers=()
  HOME="$fake_home"
  [ -s "$HOME/.nvm/nvm.sh" ] && managers+=("nvm")
  [ "${managers[*]}" = "nvm" ]
}

@test "manager detection — fnm only via PATH" {
  local fake_bin
  fake_bin=$(mktemp -d)
  cat >"$fake_bin/fnm" <<'EOF'
#!/usr/bin/env bash
echo "fnm 1.38.0"
EOF
  chmod +x "$fake_bin/fnm"
  local managers=()
  PATH="$fake_bin:$PATH" HOME="$(mktemp -d)"
  command -v fnm >/dev/null 2>&1 && managers+=("fnm")
  [ "${managers[*]}" = "fnm" ]
}

@test "manager detection — multi-manager populates array in priority order" {
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
  local managers=()
  HOME="$fake_home" PATH="$fake_bin:/usr/bin:/bin"
  [ -s "$HOME/.nvm/nvm.sh" ] && managers+=("nvm")
  command -v fnm >/dev/null 2>&1 && managers+=("fnm")
  command -v volta >/dev/null 2>&1 && managers+=("volta")
  [ "${managers[0]}" = "nvm" ]
  [ "${managers[1]}" = "fnm" ]
  [ "${managers[2]}" = "volta" ]
  [ "${#managers[@]}" -eq 3 ]
}
