#!/usr/bin/env bats
# Tests for the non-root install path in install.sh.
#
# All tests exercise the REAL install.sh via INSTALL_SH_SOURCE_ONLY=1:
# the source guard exposes agent_relay_detect_dirs() and
# agent_relay_check_greenfield_compat() without running the full installer
# (which requires Docker, VPS tools, etc.).  Mutations to install.sh will
# therefore be caught — inline re-implementations would not be.

INSTALL_SH="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/install.sh"

# ─── helpers ─────────────────────────────────────────────────────────────────

setup() {
  SHIM_DIR="$(mktemp -d)"
  FAKE_HOME="$(mktemp -d)"
}

teardown() {
  rm -rf "$SHIM_DIR" "$FAKE_HOME"
}

# Write minimal PATH shims for `id` and `docker`.
#   uid_val     numeric uid returned by `id -u`
#   docker_info "ok" = docker info exits 0; "fail" = exits 1
_make_shims() {
  local uid_val="$1" docker_info="$2"

  printf '#!/usr/bin/env bash\n[ "$1" = "-u" ] && echo %s && exit 0\nexec id "$@"\n' \
    "$uid_val" > "${SHIM_DIR}/id"

  if [ "$docker_info" = "ok" ]; then
    printf '#!/usr/bin/env bash\n[ "$1" = "info" ] && exit 0\ntrue\n' > "${SHIM_DIR}/docker"
  else
    printf '#!/usr/bin/env bash\n[ "$1" = "info" ] && exit 1\ntrue\n' > "${SHIM_DIR}/docker"
  fi

  chmod +x "${SHIM_DIR}/id" "${SHIM_DIR}/docker"
}

# Run a bash fragment in a subprocess with shims on PATH and a controlled HOME.
# The real install.sh is sourced under INSTALL_SH_SOURCE_ONLY=1 first, making
# agent_relay_detect_dirs() and agent_relay_check_greenfield_compat() available.
# stdout and stderr are merged so bats captures them in $output.
_run_with_shims() {
  local uid_val="$1" docker_info="$2" fragment="$3"
  _make_shims "$uid_val" "$docker_info"
  run bash -c "
    export PATH='${SHIM_DIR}:${PATH}'
    export HOME='${FAKE_HOME}'
    INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'
    ${fragment}
  " 2>&1
}

# ─── agent_relay_detect_dirs tests ───────────────────────────────────────────

@test "root mode: NONROOT=0, RELAY_DIR=/opt/agent-relay, APPS_DIR=/home/deploy/apps" {
  _run_with_shims 0 "ok" "
    unset RELAY_DIR APPS_DIR
    agent_relay_detect_dirs
    echo \"NONROOT=\${NONROOT}\"
    echo \"RELAY_DIR=\${RELAY_DIR}\"
    echo \"APPS_DIR=\${APPS_DIR}\"
  "
  [ "$status" -eq 0 ]
  [[ "$output" =~ "NONROOT=0" ]]
  [[ "$output" =~ "RELAY_DIR=/opt/agent-relay" ]]
  [[ "$output" =~ "APPS_DIR=/home/deploy/apps" ]]
}

@test "non-root + docker accessible: NONROOT=1, RELAY_DIR and APPS_DIR under HOME" {
  _run_with_shims 1000 "ok" "
    unset RELAY_DIR APPS_DIR
    agent_relay_detect_dirs
    echo \"NONROOT=\${NONROOT}\"
    echo \"RELAY_DIR=\${RELAY_DIR}\"
    echo \"APPS_DIR=\${APPS_DIR}\"
  "
  [ "$status" -eq 0 ]
  [[ "$output" =~ "NONROOT=1" ]]
  [[ "$output" =~ "RELAY_DIR=${FAKE_HOME}/.local/share/agent-relay" ]]
  [[ "$output" =~ "APPS_DIR=${FAKE_HOME}/.local/share/agent-relay/apps" ]]
}

@test "non-root + docker inaccessible: exits non-zero with error about docker group" {
  _run_with_shims 1000 "fail" "
    unset RELAY_DIR APPS_DIR
    agent_relay_detect_dirs
  "
  [ "$status" -ne 0 ]
  [[ "$output" =~ "docker group" ]]
}

@test "env RELAY_DIR honoured in non-root mode (not overridden)" {
  _run_with_shims 1000 "ok" "
    RELAY_DIR=/custom/relay
    unset APPS_DIR
    agent_relay_detect_dirs
    echo \"RELAY_DIR=\${RELAY_DIR}\"
    echo \"APPS_DIR=\${APPS_DIR}\"
  "
  [ "$status" -eq 0 ]
  [[ "$output" =~ "RELAY_DIR=/custom/relay" ]]
  [[ "$output" =~ "APPS_DIR=${FAKE_HOME}/.local/share/agent-relay/apps" ]]
}

@test "env APPS_DIR honoured in non-root mode (not overridden)" {
  _run_with_shims 1000 "ok" "
    unset RELAY_DIR
    APPS_DIR=/custom/apps
    agent_relay_detect_dirs
    echo \"APPS_DIR=\${APPS_DIR}\"
  "
  [ "$status" -eq 0 ]
  [[ "$output" =~ "APPS_DIR=/custom/apps" ]]
}

# ─── agent_relay_check_greenfield_compat tests ───────────────────────────────

@test "greenfield mode + NONROOT=1: exits non-zero with clear requires-root message" {
  _run_with_shims 1000 "ok" "
    unset RELAY_DIR APPS_DIR
    agent_relay_detect_dirs
    RELAY_MODE=greenfield
    agent_relay_check_greenfield_compat
    echo 'should not reach here'
  "
  [ "$status" -ne 0 ]
  [[ "$output" =~ "requires root" ]]
}

@test "existing-traefik mode + NONROOT=1: passes greenfield compat check" {
  _run_with_shims 1000 "ok" "
    unset RELAY_DIR APPS_DIR
    agent_relay_detect_dirs
    RELAY_MODE=existing-traefik
    agent_relay_check_greenfield_compat
    echo 'passed greenfield gate'
  "
  [ "$status" -eq 0 ]
  [[ "$output" =~ "passed greenfield gate" ]]
}

@test "port-only mode + NONROOT=1: passes greenfield compat check" {
  _run_with_shims 1000 "ok" "
    unset RELAY_DIR APPS_DIR
    agent_relay_detect_dirs
    RELAY_MODE=port-only
    agent_relay_check_greenfield_compat
    echo 'passed greenfield gate'
  "
  [ "$status" -eq 0 ]
  [[ "$output" =~ "passed greenfield gate" ]]
}
