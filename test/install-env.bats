#!/usr/bin/env bats
# Tests for agent_relay_write_env in install.sh (mode and re-run key merge).
# The real install.sh is sourced via INSTALL_SH_SOURCE_ONLY=1.

INSTALL_SH="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/install.sh"

setup() {
  RELAY_DIR="$(mktemp -d)"
  chmod 755 "$RELAY_DIR"
}

teardown() {
  rm -rf "$RELAY_DIR"
}

# Run agent_relay_write_env under umask 022 (the typical root default).
_write_env() {
  run bash -c "
    umask 022
    INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'
    AUTH_TOKEN=tok123
    RELAY_PORT=8222
    agent_relay_write_env '${RELAY_DIR}'
  " 2>&1
  [ "$status" -eq 0 ]
}

# Portable file mode (octal): BSD stat first, then GNU.
_mode() { stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"; }

@test "env: first install writes the three managed keys with mode 600" {
  _write_env
  [ "$(_mode "$RELAY_DIR/.env")" = "600" ]
  [ "$(cat "$RELAY_DIR/.env")" = "$(printf 'AUTH_TOKEN=tok123\nAPPS_DIR=/apps\nPORT=8222')" ]
}

@test "env: RELAY_DIR is mode 700" {
  _write_env
  [ "$(_mode "$RELAY_DIR")" = "700" ]
}

@test "env: re-run over an existing mode 644 file ends at mode 600" {
  printf 'AUTH_TOKEN=tok123\nAPPS_DIR=/apps\nPORT=8222\n' > "$RELAY_DIR/.env"
  chmod 644 "$RELAY_DIR/.env"
  _write_env
  [ "$(_mode "$RELAY_DIR/.env")" = "600" ]
}

@test "env: re-run over an empty old file writes the three keys" {
  : > "$RELAY_DIR/.env"
  _write_env
  [ "$(cat "$RELAY_DIR/.env")" = "$(printf 'AUTH_TOKEN=tok123\nAPPS_DIR=/apps\nPORT=8222')" ]
}

@test "env: re-run over an old file with only managed keys adds nothing" {
  printf 'AUTH_TOKEN=tok123\nAPPS_DIR=/apps\nPORT=8222\n' > "$RELAY_DIR/.env"
  _write_env
  [ "$(cat "$RELAY_DIR/.env")" = "$(printf 'AUTH_TOKEN=tok123\nAPPS_DIR=/apps\nPORT=8222')" ]
}

@test "env: re-run keeps custom keys, comments and blank lines in order" {
  printf 'AUTH_TOKEN=tok123\n# my note\nFOO=bar\n\nBAZ=a=b\nAPPS_DIR=/apps\nPORT=8222\nLAST=1\n' > "$RELAY_DIR/.env"
  _write_env
  [ "$(cat "$RELAY_DIR/.env")" = "$(printf 'AUTH_TOKEN=tok123\nAPPS_DIR=/apps\nPORT=8222\n# my note\nFOO=bar\n\nBAZ=a=b\nLAST=1')" ]
}

@test "env: duplicate managed keys in the old file are dropped, installer value wins" {
  printf 'PORT=9999\nAPPS_DIR=/srv/apps\nAUTH_TOKEN=old\nFOO=bar\nPORT=1111\n' > "$RELAY_DIR/.env"
  _write_env
  [ "$(cat "$RELAY_DIR/.env")" = "$(printf 'AUTH_TOKEN=tok123\nAPPS_DIR=/apps\nPORT=8222\nFOO=bar')" ]
  [ "$(grep -c '^PORT=' "$RELAY_DIR/.env")" = "1" ]
  [ "$(grep -c '^APPS_DIR=' "$RELAY_DIR/.env")" = "1" ]
}

@test "env: AUTH_TOKEN is preserved across a re-run (install.sh reads it back)" {
  printf 'AUTH_TOKEN=keepme\nFOO=bar\n' > "$RELAY_DIR/.env"
  run bash -c "
    INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'
    AUTH_TOKEN=\$(grep '^AUTH_TOKEN=' '${RELAY_DIR}/.env' | cut -d= -f2-)
    RELAY_PORT=8222
    agent_relay_write_env '${RELAY_DIR}'
    grep '^AUTH_TOKEN=' '${RELAY_DIR}/.env'
  " 2>&1
  [ "$status" -eq 0 ]
  [ "$output" = "AUTH_TOKEN=keepme" ]
}
