#!/usr/bin/env bats
# Tests for agent_relay_probe_https_route() in install.sh — the warn-only host
# probe of the public HTTPS route that runs after the in-container /health
# probe.
#
# Source-only pattern only: the function lives above the INSTALL_SH_SOURCE_ONLY
# guard, so these tests source install.sh and call it directly with curl/wget
# shims on PATH (a fast interval and a 1 s window keep it quick).

INSTALL_SH="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/install.sh"

setup() {
  SHIM_DIR="$(mktemp -d)"
  ARGV="${SHIM_DIR}/argv"
  COUNT="${SHIM_DIR}/count"
}

teardown() {
  rm -rf "$SHIM_DIR"
}

# Run a bash fragment after sourcing install.sh with INSTALL_SH_SOURCE_ONLY=1.
# Both stdout and stderr are merged so bats captures them in $output.
_run_sourced() {
  local fragment="$1"
  run bash -c "
    INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'
    ${fragment}
  " 2>&1
}

# Write <name> (curl or wget) into the shim dir. Every call appends its argv to
# $ARGV and bumps $COUNT. Mode: always-ok (exit 0), always-fail (exit 22), or
# fail-twice (first two calls exit 22, later calls exit 0).
_make_shim() {
  local name="$1" mode="$2"
  {
    printf '#!/bin/sh\n'
    printf 'echo "$*" >> "%s"\n' "$ARGV"
    printf 'n=0; [ -f "%s" ] && n=$(cat "%s")\n' "$COUNT" "$COUNT"
    printf 'n=$((n + 1)); echo "$n" > "%s"\n' "$COUNT"
    case "$mode" in
      always-ok) printf 'exit 0\n' ;;
      always-fail) printf 'exit 22\n' ;;
      fail-twice) printf '[ "$n" -ge 3 ] && exit 0\nexit 22\n' ;;
    esac
  } > "${SHIM_DIR}/${name}"
  chmod +x "${SHIM_DIR}/${name}"
}

# A PATH holding only what the probe needs besides curl/wget (date, sleep), so
# a test that removes curl/wget cannot be passing through a system binary.
_make_min_bin() {
  MIN_BIN="${SHIM_DIR}/minbin"
  mkdir -p "$MIN_BIN"
  ln -s "$(command -v date)" "${MIN_BIN}/date"
  ln -s "$(command -v sleep)" "${MIN_BIN}/sleep"
}

_calls() {
  if [ -f "$ARGV" ]; then
    wc -l < "$ARGV" | tr -d '[:space:]'
  else
    echo 0
  fi
}

# ─── curl path ───────────────────────────────────────────────────────────────

@test "curl answers on the first call: returns 0 after exactly one request" {
  _make_shim curl always-ok
  _run_sourced "
    PATH='${SHIM_DIR}':\$PATH
    agent_relay_probe_https_route https://relay.example.com/health 0 30 0
  "
  [ "$status" -eq 0 ]
  [ "$(_calls)" -eq 1 ]
}

@test "curl fails twice then answers: returns 0 after three requests" {
  _make_shim curl fail-twice
  _run_sourced "
    PATH='${SHIM_DIR}':\$PATH
    agent_relay_probe_https_route https://relay.example.com/health 0 30 0
  "
  [ "$status" -eq 0 ]
  [ "$(_calls)" -eq 3 ]
}

@test "curl never answers: returns 1 within the 1s window" {
  _make_shim curl always-fail
  local start=$SECONDS
  _run_sourced "
    PATH='${SHIM_DIR}':\$PATH
    agent_relay_probe_https_route https://relay.example.com/health 0 1 0
  "
  [ "$status" -eq 1 ]
  # Retried (more than one request) but stopped at the window, not ran forever.
  [ "$(_calls)" -ge 2 ]
  [ $(( SECONDS - start )) -le 6 ]
}

@test "interval defaults to 3s when the 4th argument is omitted" {
  _make_shim curl always-fail
  local start=$SECONDS
  _run_sourced "
    PATH='${SHIM_DIR}':\$PATH
    agent_relay_probe_https_route https://relay.example.com/health 0 1
  "
  [ "$status" -eq 1 ]
  # One request before the window, one after the 3s sleep: an interval of 0
  # would have hammered the route hundreds of times instead.
  [ "$(_calls)" -eq 2 ]
  [ $(( SECONDS - start )) -ge 3 ]
  [ $(( SECONDS - start )) -le 8 ]
}

@test "insecure=0 asks curl to verify the certificate" {
  _make_shim curl always-ok
  _run_sourced "
    PATH='${SHIM_DIR}':\$PATH
    agent_relay_probe_https_route https://relay.example.com/health 0 30 0
  "
  [ "$status" -eq 0 ]
  run grep -q -- '-k' "$ARGV"
  [ "$status" -ne 0 ]
  run grep -q -- '-fsS --max-time 5 https://relay.example.com/health' "$ARGV"
  [ "$status" -eq 0 ]
}

@test "insecure=1 passes -k to curl" {
  _make_shim curl always-ok
  _run_sourced "
    PATH='${SHIM_DIR}':\$PATH
    agent_relay_probe_https_route https://relay.example.com/health 1 30 0
  "
  [ "$status" -eq 0 ]
  run grep -q -- '-k' "$ARGV"
  [ "$status" -eq 0 ]
}

# ─── wget fallback ───────────────────────────────────────────────────────────

@test "no curl, wget answers: falls back to wget and returns 0" {
  _make_min_bin
  _make_shim wget always-ok
  _run_sourced "
    PATH='${MIN_BIN}:${SHIM_DIR}'
    agent_relay_probe_https_route https://relay.example.com/health 0 30 0
  "
  [ "$status" -eq 0 ]
  [ "$(_calls)" -eq 1 ]
  run grep -q -- '-q -O /dev/null https://relay.example.com/health' "$ARGV"
  [ "$status" -eq 0 ]
}

@test "wget fallback with insecure=1 passes --no-check-certificate" {
  _make_min_bin
  _make_shim wget always-ok
  _run_sourced "
    PATH='${MIN_BIN}:${SHIM_DIR}'
    agent_relay_probe_https_route https://relay.example.com/health 1 30 0
  "
  [ "$status" -eq 0 ]
  run grep -q -- '--no-check-certificate' "$ARGV"
  [ "$status" -eq 0 ]
}

# ─── no client on the host ───────────────────────────────────────────────────

@test "no curl and no wget on PATH: returns 2 with a note" {
  _make_min_bin
  _run_sourced "
    PATH='${MIN_BIN}'
    agent_relay_probe_https_route https://relay.example.com/health 0 30 0
  "
  [ "$status" -eq 2 ]
  [[ "$output" == *"Neither curl nor wget"* ]]
  [ "$(_calls)" -eq 0 ]
}
