#!/usr/bin/env bats
# Tests for the TRAEFIK_CA env var in install.sh.
#
# Two test patterns are used:
#
#   A) INSTALL_SH_SOURCE_ONLY=1 sourcing — exercises agent_relay_write_traefik_compose()
#      and agent_relay_write_relay_compose() (and validate_value) without running
#      the full installer. No Docker or root required.
#
#   B) Full bash invocation with id/docker/ss shims — tests script-level validation
#      behaviors that live in the main body (e.g. pebble + PEBBLE_URL unset exit).

INSTALL_SH="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/install.sh"

# ─── helpers ─────────────────────────────────────────────────────────────────

setup() {
  COMPOSE_DIR="$(mktemp -d)"
  SHIM_DIR="$(mktemp -d)"
}

teardown() {
  rm -rf "$COMPOSE_DIR" "$SHIM_DIR"
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

# Create id/docker/ss shims that simulate a root environment with Docker available
# and no process on port 80.
_make_root_shims() {
  # id shim: id -u returns 0 (root); fall through for other uses
  printf '#!/usr/bin/env bash\n[ "$1" = "-u" ] && echo 0 && exit 0\nexec id "$@"\n' \
    > "${SHIM_DIR}/id"

  # docker shim: answers the minimal set of docker commands the script calls
  # before reaching Step 4 validation.
  cat > "${SHIM_DIR}/docker" <<'DOCKER_SHIM'
#!/usr/bin/env bash
case "$1" in
  --version)  echo "Docker version 24.0.0, build abc123"; exit 0 ;;
  compose)    echo "Docker Compose version v2.20.0"; exit 0 ;;
  ps)         exit 0 ;;  # empty — no containers on :80
  info)       exit 0 ;;
  network)    exit 1 ;;  # network does not exist (OK in greenfield)
  *)          exit 0 ;;
esac
DOCKER_SHIM

  # ss shim: no listeners — port 80 is free
  printf '#!/usr/bin/env bash\necho ""\n' > "${SHIM_DIR}/ss"

  chmod +x "${SHIM_DIR}/id" "${SHIM_DIR}/docker" "${SHIM_DIR}/ss"
}

# ─── agent_relay_write_traefik_compose: Traefik compose content tests ────────

@test "letsencrypt: Traefik compose has no caserver line" {
  _run_sourced "
    TRAEFIK_CA=letsencrypt
    TRAEFIK_EMAIL=admin@example.com
    PEBBLE_URL=
    agent_relay_write_traefik_compose '${COMPOSE_DIR}'
    cat '${COMPOSE_DIR}/docker-compose.yml'
  "
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "caserver" ]]
  [[ "$output" =~ "acme.json" ]]
  [[ "$output" =~ "certificatesresolvers.letsencrypt.acme" ]]
}

@test "staging: Traefik compose has LE staging caserver URL" {
  _run_sourced "
    TRAEFIK_CA=staging
    TRAEFIK_EMAIL=admin@example.com
    PEBBLE_URL=
    agent_relay_write_traefik_compose '${COMPOSE_DIR}'
    cat '${COMPOSE_DIR}/docker-compose.yml'
  "
  [ "$status" -eq 0 ]
  [[ "$output" =~ "acme-staging-v02.api.letsencrypt.org" ]]
  [[ "$output" =~ "acme.json" ]]
}

@test "pebble: Traefik compose has caserver set to PEBBLE_URL value" {
  _run_sourced "
    TRAEFIK_CA=pebble
    TRAEFIK_EMAIL=admin@example.com
    PEBBLE_URL=https://pebble:14000/dir
    agent_relay_write_traefik_compose '${COMPOSE_DIR}'
    cat '${COMPOSE_DIR}/docker-compose.yml'
  "
  [ "$status" -eq 0 ]
  [[ "$output" =~ "caserver=https://pebble:14000/dir" ]]
  [[ "$output" =~ "acme.json" ]]
}

@test "self-signed: Traefik compose has no ACME block and no acme.json mount" {
  _run_sourced "
    TRAEFIK_CA=self-signed
    TRAEFIK_EMAIL=admin@example.com
    PEBBLE_URL=
    agent_relay_write_traefik_compose '${COMPOSE_DIR}'
    cat '${COMPOSE_DIR}/docker-compose.yml'
  "
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "acme" ]]
  ! [[ "$output" =~ "acme.json" ]]
  ! [[ "$output" =~ "certificatesresolvers" ]]
}

# ─── agent_relay_write_relay_compose: relay label tests ──────────────────────

@test "letsencrypt: relay compose labels include certresolver=letsencrypt" {
  _run_sourced "
    RELAY_MODE=greenfield
    TRAEFIK_CA=letsencrypt
    TRAEFIK_EMAIL=admin@example.com
    RELAY_DOMAIN=relay.example.com
    APPS_DIR=/home/deploy/apps
    RELAY_PORT=8222
    PEBBLE_URL=
    TRAEFIK_NETWORK=traefik-public
    TRAEFIK_CERTRESOLVER=letsencrypt
    RELAY_BIND=127.0.0.1
    agent_relay_write_relay_compose '${COMPOSE_DIR}'
    cat '${COMPOSE_DIR}/docker-compose.yml'
  "
  [ "$status" -eq 0 ]
  [[ "$output" =~ "certresolver=letsencrypt" ]]
  [[ "$output" =~ "traefik.enable=true" ]]
}

@test "staging: relay compose labels include certresolver (resolver name unchanged)" {
  _run_sourced "
    RELAY_MODE=greenfield
    TRAEFIK_CA=staging
    TRAEFIK_EMAIL=admin@example.com
    RELAY_DOMAIN=relay.example.com
    APPS_DIR=/home/deploy/apps
    RELAY_PORT=8222
    PEBBLE_URL=
    TRAEFIK_NETWORK=traefik-public
    TRAEFIK_CERTRESOLVER=letsencrypt
    RELAY_BIND=127.0.0.1
    agent_relay_write_relay_compose '${COMPOSE_DIR}'
    cat '${COMPOSE_DIR}/docker-compose.yml'
  "
  [ "$status" -eq 0 ]
  [[ "$output" =~ "certresolver=letsencrypt" ]]
}

@test "self-signed: relay compose labels omit certresolver line" {
  _run_sourced "
    RELAY_MODE=greenfield
    TRAEFIK_CA=self-signed
    TRAEFIK_EMAIL=
    RELAY_DOMAIN=relay.example.com
    APPS_DIR=/home/deploy/apps
    RELAY_PORT=8222
    PEBBLE_URL=
    TRAEFIK_NETWORK=traefik-public
    TRAEFIK_CERTRESOLVER=letsencrypt
    RELAY_BIND=127.0.0.1
    agent_relay_write_relay_compose '${COMPOSE_DIR}'
    cat '${COMPOSE_DIR}/docker-compose.yml'
  "
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "certresolver" ]]
  [[ "$output" =~ "traefik.enable=true" ]]
  [[ "$output" =~ "relay.example.com" ]]
}

# ─── validate_value PEBBLE_URL injection guard ───────────────────────────────

@test "validate_value: PEBBLE_URL with double-quote rejected" {
  _run_sourced "
    validate_value PEBBLE_URL 'https://bad\"inject' '[A-Za-z0-9._:/~?=&%-]+'
  "
  [ "$status" -ne 0 ]
  [[ "$output" =~ "invalid characters" ]]
}

@test "validate_value: PEBBLE_URL with embedded newline rejected" {
  _run_sourced "
    val=\"\$(printf 'https://pebble:14000/dir\nextra')\"
    validate_value PEBBLE_URL \"\$val\" '[A-Za-z0-9._:/~?=&%-]+'
  "
  [ "$status" -ne 0 ]
}

@test "validate_value: valid PEBBLE_URL with path and query accepted" {
  _run_sourced "
    validate_value PEBBLE_URL 'https://pebble:14000/dir?foo=bar' '[A-Za-z0-9._:/~?=&%-]+'
    echo 'validation passed'
  "
  [ "$status" -eq 0 ]
  [[ "$output" =~ "validation passed" ]]
}

@test "validate_value: empty PEBBLE_URL accepted (validation skips empty)" {
  _run_sourced "
    validate_value PEBBLE_URL '' '[A-Za-z0-9._:/~?=&%-]+'
    echo 'empty ok'
  "
  [ "$status" -eq 0 ]
  [[ "$output" =~ "empty ok" ]]
}

# ─── Script-level: pebble + missing PEBBLE_URL exits non-zero ────────────────

@test "pebble without PEBBLE_URL: script exits non-zero with clear error" {
  _make_root_shims
  run bash -c "
    export PATH='${SHIM_DIR}:${PATH}'
    RELAY_MODE=greenfield TRAEFIK_CA=pebble PEBBLE_URL= bash '${INSTALL_SH}'
  " 2>&1
  [ "$status" -ne 0 ]
  [[ "$output" =~ "PEBBLE_URL" ]]
}

# ─── existing-traefik / port-only: TRAEFIK_CA and PEBBLE_URL ignored (warn) ──

@test "port-only + TRAEFIK_CA=staging: warn that env vars are ignored" {
  _make_root_shims
  run bash -c "
    export PATH='${SHIM_DIR}:${PATH}'
    RELAY_MODE=port-only TRAEFIK_CA=staging bash '${INSTALL_SH}'
  " 2>&1
  # Script may fail on docker pull, but the warn must appear before that
  [[ "$output" =~ "only affect greenfield mode" ]]
}
