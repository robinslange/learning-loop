#!/usr/bin/env bats

setup() {
  source "${BATS_TEST_DIRNAME}/../../install.sh"
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
