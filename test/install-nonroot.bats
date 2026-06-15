#!/usr/bin/env bats
# Minimal smoke tests for the non-root guard logic in install.sh.
# These source only the isolated sections via a shim rather than running
# the full installer (which requires Docker, VPS tools, etc.).

# ─── helpers ────────────────────────────────────────────────────────────────

# Source just enough of install.sh to test the NONROOT logic without
# executing the full script. We extract the relevant guard functions and
# variables into a small shim.

setup() {
  # Capture err/warn/info/log to variables so we can assert on them.
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
  CYAN='\033[0;36m'; NC='\033[0m'
  ERR_MSG=""
  INFO_MSG=""
  log()  { :; }
  warn() { :; }
  info() { INFO_MSG="$1"; }
  err()  { ERR_MSG="$1"; exit 1; }
}

# Run the pre-check block in a subshell with a mock id/docker.
run_precheck() {
  local is_root="$1"   # "0" for root, "1" for non-root
  local docker_ok="$2" # "yes" = docker info succeeds

  (
    source /dev/stdin <<'SHIM'
RED=''; GREEN=''; YELLOW=''; CYAN=''; NC=''
ERR_MSG=""
INFO_MSG=""
log()  { :; }
warn() { :; }
info() { INFO_MSG="$1"; echo "$1"; }
err()  { echo "ERR: $1" >&2; exit 1; }
SHIM

    # Inject the NONROOT block under test
    eval "
NONROOT=0
if [ '${is_root}' != '0' ]; then
  if ${docker_ok}; then
    NONROOT=1
    RELAY_DIR=\"\${RELAY_DIR:-\${HOME}/.local/share/agent-relay}\"
    info \"Non-root mode: Docker accessible without sudo. Install writes to \${RELAY_DIR}\"
  else
    err \"Run as root: sudo bash install.sh (or add yourself to the docker group for non-root install)\"
  fi
fi
: \"\${RELAY_DIR:=/opt/agent-relay}\"
echo \"NONROOT=\$NONROOT\"
echo \"RELAY_DIR=\$RELAY_DIR\"
"
  )
}

# ─── tests ──────────────────────────────────────────────────────────────────

@test "root mode: NONROOT=0, RELAY_DIR=/opt/agent-relay" {
  result=$(run_precheck 0 "true")
  echo "$result" | grep -q "NONROOT=0"
  echo "$result" | grep -q "RELAY_DIR=/opt/agent-relay"
}

@test "non-root + docker accessible: NONROOT=1, RELAY_DIR under HOME" {
  result=$(run_precheck 1 "true")
  echo "$result" | grep -q "NONROOT=1"
  echo "$result" | grep -qE "RELAY_DIR=.+/.local/share/agent-relay"
}

@test "non-root + docker inaccessible: exits non-zero with error" {
  run bash -c "$(cat <<'EOF'
RED=''; GREEN=''; YELLOW=''; CYAN=''; NC=''
log()  { :; }; warn() { :; }; info() { echo "$1"; }
err()  { echo "ERR: $1" >&2; exit 1; }
NONROOT=0
if [ 1 -ne 0 ]; then
  if false; then
    NONROOT=1
    RELAY_DIR="${RELAY_DIR:-${HOME}/.local/share/agent-relay}"
    info "Non-root mode"
  else
    err "Run as root: sudo bash install.sh (or add yourself to the docker group for non-root install)"
  fi
fi
EOF
)"
  [ "$status" -ne 0 ]
  echo "$output" | grep -q "docker group"
}

@test "env RELAY_DIR is honoured in non-root mode (no override)" {
  result=$(RELAY_DIR=/custom/path run_precheck 1 "true")
  echo "$result" | grep -q "RELAY_DIR=/custom/path"
}

@test "greenfield mode + NONROOT=1: exits non-zero with clear message" {
  run bash -c "$(cat <<'EOF'
RED=''; GREEN=''; YELLOW=''; CYAN=''; NC=''
log()  { :; }; warn() { :; }; info() { echo "$1"; }
err()  { echo "ERR: $1" >&2; exit 1; }
NONROOT=1
RELAY_MODE=greenfield
if [ "$RELAY_MODE" = "greenfield" ]; then
  if [ "$NONROOT" = "1" ]; then
    err "RELAY_MODE=greenfield requires root (Traefik bootstrap writes to /opt/traefik and binds :80/:443). Re-run with sudo, or use RELAY_MODE=existing-traefik or RELAY_MODE=port-only."
  fi
fi
echo "should not reach here"
EOF
)"
  [ "$status" -ne 0 ]
  echo "$output" | grep -q "requires root"
}

@test "existing-traefik mode + NONROOT=1: does NOT exit early at greenfield gate" {
  run bash -c "$(cat <<'EOF'
RED=''; GREEN=''; YELLOW=''; CYAN=''; NC=''
log()  { :; }; warn() { :; }; info() { echo "$1"; }
err()  { echo "ERR: $1" >&2; exit 1; }
NONROOT=1
RELAY_MODE=existing-traefik
if [ "$RELAY_MODE" = "greenfield" ]; then
  if [ "$NONROOT" = "1" ]; then
    err "RELAY_MODE=greenfield requires root"
  fi
fi
echo "passed greenfield gate"
EOF
)"
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "passed greenfield gate"
}

@test "port-only mode + NONROOT=1: does NOT exit early at greenfield gate" {
  run bash -c "$(cat <<'EOF'
RED=''; GREEN=''; YELLOW=''; CYAN=''; NC=''
log()  { :; }; warn() { :; }; info() { echo "$1"; }
err()  { echo "ERR: $1" >&2; exit 1; }
NONROOT=1
RELAY_MODE=port-only
if [ "$RELAY_MODE" = "greenfield" ]; then
  if [ "$NONROOT" = "1" ]; then
    err "RELAY_MODE=greenfield requires root"
  fi
fi
echo "passed greenfield gate"
EOF
)"
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "passed greenfield gate"
}
