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
  [ "$(cat "$RELAY_DIR/.env")" = "$(printf '# my note\nFOO=bar\n\nBAZ=a=b\nLAST=1\nAUTH_TOKEN=tok123\nAPPS_DIR=/apps\nPORT=8222')" ]
}

@test "env: duplicate managed keys in the old file are dropped, installer value wins" {
  printf 'PORT=9999\nAPPS_DIR=/srv/apps\nAUTH_TOKEN=old\nFOO=bar\nPORT=1111\n' > "$RELAY_DIR/.env"
  _write_env
  [ "$(cat "$RELAY_DIR/.env")" = "$(printf 'FOO=bar\nAUTH_TOKEN=tok123\nAPPS_DIR=/apps\nPORT=8222')" ]
  [ "$(grep -c '^PORT=' "$RELAY_DIR/.env")" = "1" ]
  [ "$(grep -c '^APPS_DIR=' "$RELAY_DIR/.env")" = "1" ]
}


# Count lines that set a managed key in any form compose accepts.
_count_key() {
  grep -cE "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=" "$RELAY_DIR/.env"
}

@test "env: 'export KEY=' forms of managed keys are dropped, installer value is the only one" {
  printf 'export PORT=9999\nexport APPS_DIR=/srv\nexport AUTH_TOKEN=evil\nFOO=bar\n' > "$RELAY_DIR/.env"
  _write_env
  [ "$(cat "$RELAY_DIR/.env")" = "$(printf 'FOO=bar\nAUTH_TOKEN=tok123\nAPPS_DIR=/apps\nPORT=8222')" ]
  [ "$(_count_key PORT)" = "1" ]
  [ "$(_count_key APPS_DIR)" = "1" ]
  [ "$(_count_key AUTH_TOKEN)" = "1" ]
}

@test "env: 'KEY = value' with spaces around = is dropped" {
  printf 'PORT = 9999\nAPPS_DIR\t= /srv\nFOO=bar\n' > "$RELAY_DIR/.env"
  _write_env
  [ "$(cat "$RELAY_DIR/.env")" = "$(printf 'FOO=bar\nAUTH_TOKEN=tok123\nAPPS_DIR=/apps\nPORT=8222')" ]
  [ "$(_count_key PORT)" = "1" ]
  [ "$(_count_key APPS_DIR)" = "1" ]
}

@test "env: leading-space managed key is dropped" {
  printf '  AUTH_TOKEN=evil\n  PORT=9999\nFOO=bar\n' > "$RELAY_DIR/.env"
  _write_env
  [ "$(cat "$RELAY_DIR/.env")" = "$(printf 'FOO=bar\nAUTH_TOKEN=tok123\nAPPS_DIR=/apps\nPORT=8222')" ]
  [ "$(_count_key AUTH_TOKEN)" = "1" ]
}

@test "env: managed keys come last so last-wins parsing yields the installer values" {
  printf 'FOO=bar\nPORT:9999\n' > "$RELAY_DIR/.env"
  _write_env
  [ "$(tail -n 3 "$RELAY_DIR/.env")" = "$(printf 'AUTH_TOKEN=tok123\nAPPS_DIR=/apps\nPORT=8222')" ]
}

@test "env: two AUTH_TOKEN lines: the last one is read back, written once" {
  printf 'AUTH_TOKEN=first\nFOO=bar\nexport AUTH_TOKEN = second \n' > "$RELAY_DIR/.env"
  run bash -c "
    INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'
    AUTH_TOKEN=\$(agent_relay_resolve_token '${RELAY_DIR}' 2>/dev/null)
    RELAY_PORT=8222
    agent_relay_write_env '${RELAY_DIR}'
  " 2>&1
  [ "$status" -eq 0 ]
  [ "$(_count_key AUTH_TOKEN)" = "1" ]
  grep -qx 'AUTH_TOKEN=second' "$RELAY_DIR/.env"
}

_resolve() {
  run bash -c "
    INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'
    agent_relay_resolve_token '${RELAY_DIR}' 2>/dev/null
  "
  [ "$status" -eq 0 ]
}

@test "resolve_token: plain AUTH_TOKEN line is read back" {
  printf 'AUTH_TOKEN=keepme\nFOO=bar\n' > "$RELAY_DIR/.env"
  _resolve
  [ "$output" = "keepme" ]
}

@test "resolve_token: 'export AUTH_TOKEN =' form is read back" {
  printf 'export AUTH_TOKEN = keepme\n' > "$RELAY_DIR/.env"
  _resolve
  [ "$output" = "keepme" ]
}

@test "resolve_token: two lines, the last wins" {
  printf 'AUTH_TOKEN=first\nAUTH_TOKEN=last\n' > "$RELAY_DIR/.env"
  _resolve
  [ "$output" = "last" ]
}

@test "resolve_token: no .env generates a non-empty token" {
  _resolve
  [ -n "$output" ]
  [ "${#output}" -eq 64 ]
}

@test "resolve_token: .env without AUTH_TOKEN, and empty value, generate a token" {
  printf 'FOO=bar\n' > "$RELAY_DIR/.env"
  _resolve
  [ "${#output}" -eq 64 ]
  printf 'AUTH_TOKEN=\n' > "$RELAY_DIR/.env"
  _resolve
  [ "${#output}" -eq 64 ]
}

@test "env: symlink at .env is replaced by a regular 600 file, target untouched, no temp files left" {
  printf 'SECRET=target\n' > "$RELAY_DIR/target"
  chmod 644 "$RELAY_DIR/target"
  ln -s "$RELAY_DIR/target" "$RELAY_DIR/.env"
  _write_env
  [ ! -L "$RELAY_DIR/.env" ]
  [ -f "$RELAY_DIR/.env" ]
  [ "$(_mode "$RELAY_DIR/.env")" = "600" ]
  [ "$(cat "$RELAY_DIR/target")" = "SECRET=target" ]
  [ "$(_mode "$RELAY_DIR/target")" = "644" ]
  _write_env
  [ -z "$(ls -A "$RELAY_DIR" | grep '^\.env\.')" ]
}

@test "install.sh main flow calls agent_relay_resolve_token and agent_relay_write_env after the source-only guard" {
  body="$(sed -n '/^if \[ "\${INSTALL_SH_SOURCE_ONLY:-}" = "1" \]/,$p' "$INSTALL_SH")"
  echo "$body" | grep -qE '^AUTH_TOKEN="\$\(agent_relay_resolve_token "\$RELAY_DIR"\)"$'
  echo "$body" | grep -qE '^agent_relay_write_env "\$RELAY_DIR"$'
}

@test "env: docker compose sees the installer values (skipped without docker compose)" {
  command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 || skip "docker compose not available"
  printf 'export PORT=9999\nAPPS_DIR = /srv\n  AUTH_TOKEN=evil\nFOO=bar\n' > "$RELAY_DIR/.env"
  _write_env
  printf 'services:\n  x:\n    image: busybox\n    env_file: .env\n' > "$RELAY_DIR/c.yml"
  run docker compose -f "$RELAY_DIR/c.yml" config
  [ "$status" -eq 0 ]
  echo "$output" | grep -q 'AUTH_TOKEN: tok123'
  echo "$output" | grep -q 'APPS_DIR: /apps'
  echo "$output" | grep -q 'PORT: "8222"'
}

@test "env: an unreadable existing .env stops the run and is left untouched" {
  [ "$(id -u)" -ne 0 ] || skip "root can read a mode 000 file"
  printf 'AUTH_TOKEN=keep\nCUSTOM=1\n' > "$RELAY_DIR/.env"
  chmod 000 "$RELAY_DIR/.env"
  run bash -c "
    INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'
    agent_relay_resolve_token '${RELAY_DIR}'
  "
  [ "$status" -ne 0 ]
  [[ "$output" == *"cannot read"* ]]
  run bash -c "
    INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'
    AUTH_TOKEN=new RELAY_PORT=8222
    agent_relay_write_env '${RELAY_DIR}'
  "
  [ "$status" -ne 0 ]
  [[ "$output" == *"cannot read"* ]]
  chmod 600 "$RELAY_DIR/.env"
  [ "$(cat "$RELAY_DIR/.env")" = "$(printf 'AUTH_TOKEN=keep\nCUSTOM=1')" ]
  [ -z "$(ls -A "$RELAY_DIR" | grep '^\.env\.')" ]
}
