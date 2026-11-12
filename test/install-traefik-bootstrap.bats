#!/usr/bin/env bats
# Tests for agent_relay_bootstrap_traefik() and the Traefik compose writer in
# install.sh (greenfield Step 5).
#
# install.sh is sourced with INSTALL_SH_SOURCE_ONLY=1 and a `docker` PATH shim
# that appends its argv to a log file and answers `docker ps --format` from the
# variable SHIM_PS_OUTPUT. No daemon is touched.

INSTALL_SH="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/install.sh"

setup() {
  TRAEFIK_ROOT="$(mktemp -d)"
  TRAEFIK_DIR="$TRAEFIK_ROOT"
  SHIM_DIR="$(mktemp -d)"
  DOCKER_LOG="${SHIM_DIR}/docker.log"
  : > "$DOCKER_LOG"

  cat > "${SHIM_DIR}/docker" <<'DOCKER_SHIM'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
case "$1" in
  ps)      printf '%s' "${SHIM_PS_OUTPUT:-}"; exit 0 ;;
  network) [ "$2" = "inspect" ] && exit 0; exit 0 ;;
  *)       exit 0 ;;
esac
DOCKER_SHIM
  chmod +x "${SHIM_DIR}/docker"
}

teardown() {
  rm -rf "$TRAEFIK_ROOT" "$SHIM_DIR"
}

# Run agent_relay_bootstrap_traefik on $TRAEFIK_DIR with the docker shim.
#   $1  value for `docker ps --format` (newline separated container names)
#   $2  TRAEFIK_CA
#   $3  TRAEFIK_EMAIL
# stdout and stderr are merged into $output.
_bootstrap() {
  local ps_output="$1" ca="$2" email="$3"
  SHIM_PS_OUTPUT="$ps_output" DOCKER_LOG="$DOCKER_LOG" run bash -c "
    export PATH='${SHIM_DIR}:${PATH}'
    INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'
    TRAEFIK_CA='${ca}'
    TRAEFIK_EMAIL='${email}'
    PEBBLE_URL=
    agent_relay_bootstrap_traefik '${TRAEFIK_DIR}'
  " 2>&1
}

_up_calls() {
  grep -c "^compose -f ${TRAEFIK_DIR}/docker-compose.yml up -d\$" "$DOCKER_LOG" || true
}

# Fail the test when the pattern matches. A bare `! grep` in the middle of a
# test never fails it (set -e ignores negated commands).
_refute_grep() {
  if grep -q "$@"; then
    echo "unexpected match: $*" >&2
    return 1
  fi
}

# The entries of the "ports:" list of the Traefik service, one per line.
_ports_entries() {
  awk '
    /^    ports:$/ { inports = 1; next }
    inports && /^      - / { print; next }
    inports { inports = 0 }
  ' "$1"
}

_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

# ─── running + installer's own compose file: converge ────────────────────────

@test "traefik running + own compose file: file rewritten and up -d called" {
  printf 'stale: true\n' > "${TRAEFIK_DIR}/docker-compose.yml"
  touch "${TRAEFIK_DIR}/acme.json"

  _bootstrap $'traefik\nagent-relay' letsencrypt admin@example.com

  [ "$status" -eq 0 ]
  [[ "$output" =~ "already running, converging compose" ]]
  _refute_grep 'stale' "${TRAEFIK_DIR}/docker-compose.yml"
  grep -q 'max-size: "10m"' "${TRAEFIK_DIR}/docker-compose.yml"
  grep -q 'healthcheck:' "${TRAEFIK_DIR}/docker-compose.yml"
  [ "$(_up_calls)" -eq 1 ]
}

@test "traefik running + own compose file, letsencrypt, no acme.json: acme.json created with mode 600" {
  printf 'stale: true\n' > "${TRAEFIK_DIR}/docker-compose.yml"

  _bootstrap 'traefik' letsencrypt admin@example.com

  [ "$status" -eq 0 ]
  [ -f "${TRAEFIK_DIR}/acme.json" ]
  [ "$(_mode "${TRAEFIK_DIR}/acme.json")" = "600" ]
}

@test "traefik running + own compose file: an existing acme.json keeps its content" {
  printf 'stale: true\n' > "${TRAEFIK_DIR}/docker-compose.yml"
  printf 'CERTDATA' > "${TRAEFIK_DIR}/acme.json"
  chmod 600 "${TRAEFIK_DIR}/acme.json"

  _bootstrap 'traefik' letsencrypt admin@example.com

  [ "$status" -eq 0 ]
  [ "$(cat "${TRAEFIK_DIR}/acme.json")" = "CERTDATA" ]
}

@test "traefik running + own compose file: an existing acme.json with mode 644 is tightened to 600" {
  printf 'stale: true\n' > "${TRAEFIK_DIR}/docker-compose.yml"
  printf 'CERTDATA' > "${TRAEFIK_DIR}/acme.json"
  chmod 644 "${TRAEFIK_DIR}/acme.json"

  _bootstrap 'traefik' letsencrypt admin@example.com

  [ "$status" -eq 0 ]
  [ "$(_mode "${TRAEFIK_DIR}/acme.json")" = "600" ]
  [ "$(cat "${TRAEFIK_DIR}/acme.json")" = "CERTDATA" ]
}

@test "letsencrypt: acme.json that is a directory is not chmod'ed" {
  printf 'stale: true\n' > "${TRAEFIK_DIR}/docker-compose.yml"
  mkdir "${TRAEFIK_DIR}/acme.json"
  chmod 755 "${TRAEFIK_DIR}/acme.json"

  _bootstrap 'traefik' letsencrypt admin@example.com

  [ "$status" -eq 0 ]
  [ "$(_mode "${TRAEFIK_DIR}/acme.json")" = "755" ]
}

@test "self-signed: an existing acme.json is left alone" {
  printf 'stale: true\n' > "${TRAEFIK_DIR}/docker-compose.yml"
  printf 'CERTDATA' > "${TRAEFIK_DIR}/acme.json"
  chmod 644 "${TRAEFIK_DIR}/acme.json"

  _bootstrap 'traefik' self-signed ''

  [ "$status" -eq 0 ]
  [ "$(_mode "${TRAEFIK_DIR}/acme.json")" = "644" ]
}

# ─── converge guard: never drop an ACME resolver by accident ─────────────────

# An existing file as the first install (letsencrypt, email set) wrote it.
_seed_acme_compose() {
  _write_traefik letsencrypt admin@example.com
  touch "${TRAEFIK_DIR}/acme.json"
  chmod 600 "${TRAEFIK_DIR}/acme.json"
  cp "${TRAEFIK_DIR}/docker-compose.yml" "${SHIM_DIR}/original.yml"
}

# _bootstrap with TRAEFIK_REWRITE set to $4 (exported before the run).
_bootstrap_rewrite() {
  TRAEFIK_REWRITE="$4" _bootstrap "$1" "$2" "$3"
}

@test "guard: existing resolver + empty TRAEFIK_EMAIL: refused, file unchanged, no up, names the variables" {
  _seed_acme_compose

  _bootstrap 'traefik' letsencrypt ''

  [ "$status" -eq 1 ]
  [[ "$output" =~ "TRAEFIK_EMAIL" ]]
  [[ "$output" =~ "TRAEFIK_CA" ]]
  [[ "$output" =~ "TRAEFIK_REWRITE=1" ]]
  cmp "${TRAEFIK_DIR}/docker-compose.yml" "${SHIM_DIR}/original.yml"
  [ ! -e "${TRAEFIK_DIR}/docker-compose.yml.bak" ]
  [ "$(_up_calls)" -eq 0 ]
}

@test "guard: existing resolver + TRAEFIK_CA=self-signed: refused, file unchanged, no up" {
  _seed_acme_compose

  _bootstrap 'traefik' self-signed 'admin@example.com'

  [ "$status" -eq 1 ]
  [[ "$output" =~ "TRAEFIK_REWRITE=1" ]]
  cmp "${TRAEFIK_DIR}/docker-compose.yml" "${SHIM_DIR}/original.yml"
  [ "$(_up_calls)" -eq 0 ]
}

@test "guard: refusal does not depend on whether traefik runs" {
  _seed_acme_compose

  _bootstrap '' letsencrypt ''

  [ "$status" -eq 1 ]
  cmp "${TRAEFIK_DIR}/docker-compose.yml" "${SHIM_DIR}/original.yml"
  [ "$(_up_calls)" -eq 0 ]
}

@test "guard: TRAEFIK_REWRITE=1 overrides: backup written, file rewritten, up called" {
  _seed_acme_compose

  _bootstrap_rewrite 'traefik' letsencrypt '' 1

  [ "$status" -eq 0 ]
  cmp "${TRAEFIK_DIR}/docker-compose.yml.bak" "${SHIM_DIR}/original.yml"
  _refute_grep 'certificatesresolvers' "${TRAEFIK_DIR}/docker-compose.yml"
  [ "$(_up_calls)" -eq 1 ]
}

@test "guard: TRAEFIK_REWRITE with another value than 1 does not override" {
  _seed_acme_compose

  _bootstrap_rewrite 'traefik' letsencrypt '' yes

  [ "$status" -eq 1 ]
  cmp "${TRAEFIK_DIR}/docker-compose.yml" "${SHIM_DIR}/original.yml"
  [ "$(_up_calls)" -eq 0 ]
}

@test "guard: existing resolver + email set + letsencrypt: no refusal, rewritten" {
  _seed_acme_compose

  _bootstrap 'traefik' staging admin@example.com

  [ "$status" -eq 0 ]
  grep -q 'acme-staging' "${TRAEFIK_DIR}/docker-compose.yml"
  [ "$(_up_calls)" -eq 1 ]
}

@test "guard: existing file without a resolver + empty email: rewritten, no refusal" {
  printf 'services:\n  traefik:\n    image: traefik:v3\n' > "${TRAEFIK_DIR}/docker-compose.yml"

  _bootstrap 'traefik' letsencrypt ''

  [ "$status" -eq 0 ]
  grep -q 'healthcheck:' "${TRAEFIK_DIR}/docker-compose.yml"
  [ "$(_up_calls)" -eq 1 ]
}

# ─── backup before a rewrite ─────────────────────────────────────────────────

@test "backup: an existing file is kept as docker-compose.yml.bak and the path is logged" {
  printf 'hand: edited\n' > "${TRAEFIK_DIR}/docker-compose.yml"

  _bootstrap 'traefik' letsencrypt admin@example.com

  [ "$status" -eq 0 ]
  [ "$(cat "${TRAEFIK_DIR}/docker-compose.yml.bak")" = "hand: edited" ]
  [[ "$output" =~ "${TRAEFIK_DIR}/docker-compose.yml.bak" ]]
}

@test "backup: a previous .bak is overwritten" {
  printf 'newer\n' > "${TRAEFIK_DIR}/docker-compose.yml"
  printf 'older\n' > "${TRAEFIK_DIR}/docker-compose.yml.bak"

  _bootstrap '' letsencrypt admin@example.com

  [ "$status" -eq 0 ]
  [ "$(cat "${TRAEFIK_DIR}/docker-compose.yml.bak")" = "newer" ]
}

@test "backup: a first install (no existing file) writes no .bak" {
  _bootstrap '' letsencrypt admin@example.com

  [ "$status" -eq 0 ]
  [ ! -e "${TRAEFIK_DIR}/docker-compose.yml.bak" ]
}

# ─── running + no compose file: not ours, leave alone ────────────────────────

@test "traefik running + no compose file: nothing written, no up, warning names the path" {
  _bootstrap $'agent-relay\ntraefik' letsencrypt admin@example.com

  [ "$status" -eq 0 ]
  [[ "$output" =~ "not managed by the installer" ]]
  [[ "$output" =~ "${TRAEFIK_DIR}/docker-compose.yml" ]]
  [ ! -e "${TRAEFIK_DIR}/docker-compose.yml" ]
  [ ! -e "${TRAEFIK_DIR}/acme.json" ]
  [ "$(_up_calls)" -eq 0 ]
  _refute_grep '^compose ' "$DOCKER_LOG"
}

@test "a container merely named like traefik does not count as running" {
  _bootstrap $'traefik-old\nmy-traefik' letsencrypt admin@example.com

  [ "$status" -eq 0 ]
  [[ "$output" =~ "Starting Traefik" ]]
  [ -f "${TRAEFIK_DIR}/docker-compose.yml" ]
  [ "$(_up_calls)" -eq 1 ]
}

# ─── not running: start ──────────────────────────────────────────────────────

@test "traefik not running: compose written, up -d called, acme.json mode 600" {
  _bootstrap '' letsencrypt admin@example.com

  [ "$status" -eq 0 ]
  [[ "$output" =~ "Starting Traefik" ]]
  grep -q 'healthcheck:' "${TRAEFIK_DIR}/docker-compose.yml"
  [ "$(_up_calls)" -eq 1 ]
  [ -f "${TRAEFIK_DIR}/acme.json" ]
  [ "$(_mode "${TRAEFIK_DIR}/acme.json")" = "600" ]
}

@test "traefik not running, self-signed: compose written, up -d called, no acme.json" {
  _bootstrap '' self-signed ''

  [ "$status" -eq 0 ]
  [ -f "${TRAEFIK_DIR}/docker-compose.yml" ]
  [ "$(_up_calls)" -eq 1 ]
  [ ! -e "${TRAEFIK_DIR}/acme.json" ]
}

@test "traefik running + own compose file, self-signed: no acme.json created" {
  printf 'stale: true\n' > "${TRAEFIK_DIR}/docker-compose.yml"

  _bootstrap 'traefik' self-signed ''

  [ "$status" -eq 0 ]
  [ "$(_up_calls)" -eq 1 ]
  [ ! -e "${TRAEFIK_DIR}/acme.json" ]
}

@test "traefik not running, directory missing: directory created before the compose file is written" {
  TRAEFIK_DIR="${TRAEFIK_DIR}/nested/traefik"

  _bootstrap '' letsencrypt admin@example.com

  [ "$status" -eq 0 ]
  [ -f "${TRAEFIK_DIR}/docker-compose.yml" ]
  [ -f "${TRAEFIK_DIR}/acme.json" ]
}

# ─── Traefik compose writer: ping healthcheck ────────────────────────────────

_write_traefik() {
  local ca="$1" email="$2"
  CA_FOR_TEST="$ca" EMAIL_FOR_TEST="$email" bash -c "
    INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'
    TRAEFIK_EMAIL=\"\$EMAIL_FOR_TEST\"
    TRAEFIK_CA=\"\$CA_FOR_TEST\"
    PEBBLE_URL=
    agent_relay_write_traefik_compose '${TRAEFIK_DIR}'
  "
}

_assert_ping_healthcheck() {
  local f="${TRAEFIK_DIR}/docker-compose.yml"
  # Whole-line matches: the healthcheck test line repeats two of these flags.
  grep -qxF -- '      - "--ping=true"' "$f"
  grep -qxF -- '      - "--ping.entrypoint=ping"' "$f"
  grep -qxF -- '      - "--entrypoints.ping.address=:8082"' "$f"
  grep -qF -- 'test: ["CMD", "traefik", "healthcheck", "--ping", "--ping.entrypoint=ping", "--entrypoints.ping.address=:8082"]' "$f"
  grep -q 'interval: 30s' "$f"
  grep -q 'timeout: 5s' "$f"
  grep -q 'retries: 3' "$f"
  grep -q 'start_period: 20s' "$f"
  # The ping entrypoint is internal: only 80 and 443 are published.
  [ "$(_ports_entries "$f" | wc -l | tr -d ' ')" -eq 2 ]
  [ "$(_ports_entries "$f" | grep -cxF -e '      - "80:80"' -e '      - "443:443"')" -eq 2 ]
  _refute_grep 8082 <(_ports_entries "$f")
  # Routers without explicit entrypoints must not attach to ping.
  grep -qxF -- '      - "--entrypoints.web.asdefault=true"' "$f"
  grep -qxF -- '      - "--entrypoints.websecure.asdefault=true"' "$f"
}

@test "traefik compose (letsencrypt) has the ping healthcheck" {
  _write_traefik letsencrypt admin@example.com
  _assert_ping_healthcheck
}

@test "traefik compose (staging) has the ping healthcheck" {
  _write_traefik staging admin@example.com
  _assert_ping_healthcheck
}

@test "traefik compose (self-signed) has the ping healthcheck" {
  _write_traefik self-signed ""
  _assert_ping_healthcheck
}

@test "traefik compose validates with docker compose config for every CA" {
  command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 \
    || skip "docker compose not available"
  # The shim dir is not on PATH here, so this uses the real docker.
  local ca email
  for ca in letsencrypt staging self-signed; do
    email=admin@example.com
    [ "$ca" = self-signed ] && email=""
    _write_traefik "$ca" "$email"
    run docker compose -f "${TRAEFIK_DIR}/docker-compose.yml" config -q
    [ "$status" -eq 0 ]
  done
}

# ─── Step 5 wiring ───────────────────────────────────────────────────────────

@test "greenfield Step 5 delegates to agent_relay_bootstrap_traefik below the source-only guard" {
  # Steps 5 to 7 run only in a full install (root, daemon), which these tests
  # do not drive; pin that the main body calls the function rather than
  # carrying its own skip-if-running copy.
  local guard_line call_line
  guard_line="$(grep -n 'INSTALL_SH_SOURCE_ONLY:-}" = "1" \]' "$INSTALL_SH" | head -1 | cut -d: -f1)"
  call_line="$(grep -n '^  agent_relay_bootstrap_traefik "/opt/traefik"$' "$INSTALL_SH" | head -1 | cut -d: -f1)"
  [ -n "$guard_line" ]
  [ -n "$call_line" ]
  [ "$call_line" -gt "$guard_line" ]
  _refute_grep 'Traefik already running"' "$INSTALL_SH"
}

# ─── Traefik image: pinned default, TRAEFIK_IMAGE override, validation ───────

# Write the Traefik compose after sourcing install.sh with TRAEFIK_IMAGE=$1
# already in the environment; $1 = UNSET leaves the variable unset so the
# installer's own default applies. install.sh assigns ${TRAEFIK_IMAGE-default},
# so a set-but-empty value survives the source instead of falling back.
_write_traefik_image() {
  local pre='unset TRAEFIK_IMAGE'
  if [ "$1" != UNSET ]; then
    pre="export TRAEFIK_IMAGE='$1'"
  fi
  bash -c "
    ${pre}
    INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'
    TRAEFIK_EMAIL=admin@example.com
    TRAEFIK_CA=letsencrypt
    PEBBLE_URL=
    agent_relay_write_traefik_compose '${TRAEFIK_DIR}'
  " 2>&1
}

# Source install.sh, run the bash fragment $1 (assigns TRAEFIK_IMAGE), then the
# validator; stdout+stderr merged into $output.
_run_image_validation() {
  run bash -c "
    INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'
    ${1}
    agent_relay_validate_traefik_image
    echo 'validation passed'
  " 2>&1
}

@test "traefik compose pins image traefik:v3.7.18 by default (no floating :v3 tag)" {
  _write_traefik_image UNSET
  grep -qxF -- '    image: traefik:v3.7.18' "${TRAEFIK_DIR}/docker-compose.yml"
  _refute_grep -E '^    image: traefik:v3$' "${TRAEFIK_DIR}/docker-compose.yml"
}

@test "TRAEFIK_IMAGE=traefik:v3.7.17 is written to the compose as given" {
  _write_traefik_image traefik:v3.7.17
  grep -qxF -- '    image: traefik:v3.7.17' "${TRAEFIK_DIR}/docker-compose.yml"
  _refute_grep 'traefik:v3.7.18' "${TRAEFIK_DIR}/docker-compose.yml"
}

@test "image default: TRAEFIK_IMAGE unset -> source applies traefik:v3.7.18" {
  run bash -c "unset TRAEFIK_IMAGE; INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'; echo TRAEFIK_IMAGE=\$TRAEFIK_IMAGE"
  [ "$status" -eq 0 ]
  [[ "$output" == "TRAEFIK_IMAGE=traefik:v3.7.18" ]]
}

@test "image default: TRAEFIK_IMAGE set -> env value wins over the default" {
  run bash -c "export TRAEFIK_IMAGE=traefik:v3.7.17; INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'; echo TRAEFIK_IMAGE=\$TRAEFIK_IMAGE"
  [ "$status" -eq 0 ]
  [[ "$output" == "TRAEFIK_IMAGE=traefik:v3.7.17" ]]
}

@test "image default: TRAEFIK_IMAGE set empty -> stays empty (no silent fallback to the default)" {
  run bash -c "export TRAEFIK_IMAGE=; INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'; echo \"[\$TRAEFIK_IMAGE]\""
  [ "$status" -eq 0 ]
  [[ "$output" == "[]" ]]
}

@test "validate TRAEFIK_IMAGE: default accepted" {
  _run_image_validation "true"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "validation passed" ]]
}

@test "validate TRAEFIK_IMAGE: plain image reference accepted" {
  _run_image_validation "TRAEFIK_IMAGE=traefik:v3.7.17"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "validation passed" ]]
}

@test "validate TRAEFIK_IMAGE: empty rejected with a clear message" {
  _run_image_validation "TRAEFIK_IMAGE=''"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "TRAEFIK_IMAGE must not be empty" ]]
}

@test "validate TRAEFIK_IMAGE: value with a space rejected" {
  _run_image_validation "TRAEFIK_IMAGE='traefik: latest'"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "whitespace" ]]
}

@test "validate TRAEFIK_IMAGE: YAML-significant or interpolating values rejected" {
  for v in '*x' '!tag' '&a' '{a:b}' '%x' '@x' '-x' 'x${HOME}' 'traefik:v3#c'; do
    _run_image_validation "TRAEFIK_IMAGE='$v'"
    [ "$status" -eq 1 ] || { echo "accepted: $v"; return 1; }
    [[ "$output" =~ "is not an image reference" ]] || { echo "wrong message for $v: $output"; return 1; }
  done
}

@test "validate TRAEFIK_IMAGE: registry, digest and port forms accepted" {
  for v in 'docker.io/library/traefik:v3.7.18' 'registry.example.com:5000/traefik:v3.7.18' 'traefik@sha256:0123abcd'; do
    _run_image_validation "TRAEFIK_IMAGE='$v'"
    [ "$status" -eq 0 ] || { echo "rejected: $v: $output"; return 1; }
  done
}

@test "validate TRAEFIK_IMAGE: value with a newline rejected" {
  _run_image_validation "TRAEFIK_IMAGE=\$'traefik:v3.7.18\nlatest'"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "whitespace" ]]
}

# ─── greenfield empty-TRAEFIK_EMAIL warning text (Step 4, main body) ─────────

# Run the full installer with a non-root id shim (uid 1000, docker info ok →
# NONROOT=1), RELAY_MODE=greenfield, RELAY_DOMAIN set and TRAEFIK_EMAIL empty:
# it prints the Step 4 warnings and then stops at the Step 5 requires-root
# check, so nothing is written anywhere.
_greenfield_email_warning_run() {
  printf '#!/usr/bin/env bash\n[ "$1" = "-u" ] && echo 1000 && exit 0\nexec id "$@"\n' \
    > "${SHIM_DIR}/id"
  chmod +x "${SHIM_DIR}/id"
  run bash -c "
    export PATH='${SHIM_DIR}:${PATH}'
    export HOME='${SHIM_DIR}/home'
    export DOCKER_LOG='${DOCKER_LOG}'
    RELAY_MODE=greenfield RELAY_DOMAIN=relay.example.com TRAEFIK_EMAIL= \
      bash '${INSTALL_SH}'
  " 2>&1
}

@test "greenfield + RELAY_DOMAIN + empty TRAEFIK_EMAIL: warning names RELAY_MODE=port-only and the plain-HTTP trap" {
  _greenfield_email_warning_run
  [ "$status" -eq 1 ]
  [[ "$output" =~ "requires root" ]]
  [[ "$output" =~ "TRAEFIK_EMAIL is empty" ]]
  [[ "$output" =~ "use RELAY_MODE=port-only" ]]
  [[ "$output" =~ "plain HTTP on all interfaces" ]]
}

@test "the false advice to leave RELAY_DOMAIN unset for port-only mode is gone" {
  _refute_grep "leave RELAY_DOMAIN unset" "$INSTALL_SH"
  _refute_grep "unset for port-only" "$INSTALL_SH"
}

@test "installer run: invalid TRAEFIK_IMAGE fails in the main body before Step 1" {
  printf '#!/usr/bin/env bash\n[ "$1" = "-u" ] && echo 1000 && exit 0\nexec id "$@"\n' \
    > "${SHIM_DIR}/id"
  chmod +x "${SHIM_DIR}/id"
  run bash -c "
    export PATH='${SHIM_DIR}:${PATH}'
    export HOME='${SHIM_DIR}/home'
    export DOCKER_LOG='${DOCKER_LOG}'
    RELAY_MODE=port-only TRAEFIK_IMAGE='traefik: latest' bash '${INSTALL_SH}'
  " 2>&1
  [ "$status" -eq 1 ]
  [[ "$output" =~ "must not contain whitespace" ]]
  # Validation runs in the pre-checks, before the Docker step even starts.
  _refute_grep 'Docker already installed' <<<"$output"
}
