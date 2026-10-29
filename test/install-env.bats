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

# Portable file mode (octal): GNU stat first (on Linux `stat -f` reports the
# filesystem instead of failing), then BSD.
_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

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

# Set `seen` to the AUTH_TOKEN value `docker compose config` reads from the
# current $RELAY_DIR/.env. Skipped without docker compose.
_compose_value() {
  command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 || skip "docker compose not available"
  printf 'services:\n  x:\n    image: busybox\n    env_file: .env\n' > "$RELAY_DIR/c.yml"
  run docker compose -f "$RELAY_DIR/c.yml" config
  [ "$status" -eq 0 ]
  seen="$(printf '%s\n' "$output" | sed -n 's/^ *AUTH_TOKEN: *//p')"
  dq=0
  case "$seen" in '"'*'"') dq=1 ;; esac
  seen="${seen#\"}"; seen="${seen%\"}"
  seen="${seen#\'}"; seen="${seen%\'}"
  if [ "$dq" = 1 ]; then
    # YAML escapes a real tab as \t inside double quotes; the only control
    # character these tests put in a token is the tab.
    seen="${seen//\\t/$'\t'}"
  fi
  # `config` prints a literal `$` as `$$`.
  seen="${seen//\$\$/\$}"
}

# Assert compose reads $1 as the AUTH_TOKEN of the current $RELAY_DIR/.env.
_compose_sees_token() {
  _compose_value
  [ "$seen" = "$1" ]
}

# resolve_token returns the RAW value of the existing line (only `export `,
# spaces around `=` and trailing space are normalised), quotes and comment kept.
@test "resolve_token: double-quoted value is returned raw" {
  printf 'AUTH_TOKEN="qtok"\n' > "$RELAY_DIR/.env"
  _resolve
  [ "$output" = '"qtok"' ]
}

@test "resolve_token: single-quoted value is returned raw" {
  printf "AUTH_TOKEN='stok'\n" > "$RELAY_DIR/.env"
  _resolve
  [ "$output" = "'stok'" ]
}

@test "resolve_token: trailing comment is kept in the raw value" {
  printf 'AUTH_TOKEN=ctok # note\n' > "$RELAY_DIR/.env"
  _resolve
  [ "$output" = 'ctok # note' ]
}

@test "resolve_token: export form with spaces around = and trailing space is normalised, quotes kept" {
  printf 'export AUTH_TOKEN =  "a b"  \n' > "$RELAY_DIR/.env"
  _resolve
  [ "$output" = '"a b"' ]
}

@test "resolve_token: mismatched quote is returned raw" {
  printf 'AUTH_TOKEN="mismatch\n' > "$RELAY_DIR/.env"
  _resolve
  [ "$output" = '"mismatch' ]
}

# Re-run twice: the written AUTH_TOKEN line is byte-identical to the original
# line value both times, and compose reads the same value from the original
# file and from each rewritten file. $1 is the value after `AUTH_TOKEN=`; an
# empty $1 means no .env at all (generated token).
_rerun() {
  run bash -c "
    umask 022
    INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'
    AUTH_TOKEN=\$(agent_relay_resolve_token '${RELAY_DIR}' 2>/dev/null)
    RELAY_PORT=8222
    agent_relay_write_env '${RELAY_DIR}'
  "
  [ "$status" -eq 0 ]
}

_assert_rerun_stable() {
  local raw="$1" before_seen
  if [ -n "$raw" ]; then
    printf 'AUTH_TOKEN=%s\n' "$raw" > "$RELAY_DIR/.env"
    _compose_value
    before_seen="$seen"
  else
    _rerun
    raw="$(sed -n 's/^AUTH_TOKEN=//p' "$RELAY_DIR/.env")"
    [ "${#raw}" -eq 64 ]
    _compose_value
    before_seen="$seen"
  fi
  local i
  for i in 1 2; do
    _rerun
    [ "$(grep -c '^AUTH_TOKEN=' "$RELAY_DIR/.env")" = "1" ]
    grep -Fqx "AUTH_TOKEN=$raw" "$RELAY_DIR/.env"
    _compose_value
    [ "$seen" = "$before_seen" ]
  done
}

@test "re-run: plain token line is byte-identical, twice" {
  _assert_rerun_stable 'tok123'
}

@test "re-run: generated hex token line is byte-identical, twice" {
  _assert_rerun_stable ''
}

@test "re-run: \"a #b\" line is byte-identical, twice" {
  _assert_rerun_stable '"a #b"'
}

@test "re-run: \" lead\" line is byte-identical, twice" {
  _assert_rerun_stable '" lead"'
}

@test "re-run: 'x\"y' line is byte-identical, twice" {
  _assert_rerun_stable "'x\"y'"
}

@test "re-run: \"p=q\" line is byte-identical, twice" {
  _assert_rerun_stable '"p=q"'
}

@test "re-run: 'a\$b' line is byte-identical, twice" {
  _assert_rerun_stable "'a\$b'"
}

@test "re-run: \"a\\\\b'c\" line is byte-identical, twice" {
  _assert_rerun_stable "\"a\\\\b'c\""
}

@test "re-run: \"to'k\" line is byte-identical, twice" {
  _assert_rerun_stable "\"to'k\""
}

@test "re-run: unquoted trailing comment line is byte-identical, twice" {
  _assert_rerun_stable 'tok # note'
}

@test "re-run: tab before # line is byte-identical, twice" {
  _assert_rerun_stable $'a\t#c'
}

@test "write_env: the AUTH_TOKEN value is written exactly as given, never quoted" {
  run env AUTH_TOKEN=$'x\'y"z\\w #q' RELAY_PORT=8222 bash -c "
    INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'
    agent_relay_write_env '${RELAY_DIR}'
  "
  [ "$status" -eq 0 ]
  grep -Fqx 'AUTH_TOKEN=x'\''y"z\w #q' "$RELAY_DIR/.env"
}

# agent_relay_display_token: $1 raw value, $2 the banner value; when compose
# accepts the line it must read the same value as the banner shows.
_display() {
  run bash -c "
    INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'
    agent_relay_display_token \"\$1\"
  " _ "$1"
  [ "$status" -eq 0 ]
  [ "$output" = "$2" ]
  printf 'AUTH_TOKEN=%s\n' "$1" > "$RELAY_DIR/.env"
  _compose_sees_token "$2"
}

@test "display_token: plain token" {
  _display 'tok123' 'tok123'
}

@test "display_token: double-quoted value loses its quotes, keeps # and space" {
  _display '"a #b"' 'a #b'
}

@test "display_token: double-quoted leading space is kept" {
  _display '" lead"' ' lead'
}

@test "display_token: single-quoted value keeps a double quote" {
  _display "'x\"y'" 'x"y'
}

@test "display_token: = inside quotes" {
  _display '"p=q"' 'p=q'
}

@test "display_token: single quotes are literal, \$ stays" {
  _display "'a\$b'" 'a$b'
}

@test "display_token: double quotes unescape backslash pairs" {
  _display "\"a\\\\b'c\"" "a\\b'c"
}

@test "display_token: single quote inside double quotes" {
  _display "\"to'k\"" "to'k"
}

@test "display_token: unquoted trailing comment stripped" {
  _display 'tok # note' 'tok'
}

@test "display_token: quoted value plus trailing comment" {
  _display '"qtok" # note' 'qtok'
}

@test "display_token: tab before # is part of the value" {
  _display $'a\t#c' $'a\t#c'
}

@test "display_token: # without a leading space is part of the value" {
  _display 'tok#nocomment' 'tok#nocomment'
}

@test "display_token: escaped quote and dollar inside double quotes" {
  _display '"a\"b\$c"' 'a"b$c'
}

@test "display_token: mismatched quote is left alone" {
  run bash -c "
    INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'
    agent_relay_display_token '\"mismatch'
  "
  [ "$status" -eq 0 ]
  [ "$output" = '"mismatch' ]
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

@test "env: a grep read error on the old .env fails the write and keeps the file" {
  printf 'AUTH_TOKEN=keep\nCUSTOM=1\n' > "$RELAY_DIR/.env"
  chmod 600 "$RELAY_DIR/.env"
  STUB_DIR="$(mktemp -d)"
  printf '#!/bin/sh\necho "grep: read error" >&2\nexit 2\n' > "$STUB_DIR/grep"
  chmod 755 "$STUB_DIR/grep"
  run bash -c "
    INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'
    AUTH_TOKEN=new RELAY_PORT=8222
    PATH='${STUB_DIR}':\"\$PATH\" agent_relay_write_env '${RELAY_DIR}'
  "
  rm -rf "$STUB_DIR"
  [ "$status" -ne 0 ]
  [ "$(cat "$RELAY_DIR/.env")" = "$(printf 'AUTH_TOKEN=keep\nCUSTOM=1')" ]
  [ -z "$(ls -A "$RELAY_DIR" | grep '^\.env\.')" ]
}
