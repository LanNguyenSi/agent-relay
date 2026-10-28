#!/usr/bin/env bats
# Log rotation on every compose file, the image HEALTHCHECK, and the production
# example's alignment with the installer (network name, required apps mount).
#
# install.sh is sourced with INSTALL_SH_SOURCE_ONLY=1, no Docker or root needed.
# `docker compose config` validation runs only when the compose plugin exists.

ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
INSTALL_SH="${ROOT}/install.sh"

setup() {
  COMPOSE_DIR="$(mktemp -d)"
}

teardown() {
  rm -rf "$COMPOSE_DIR"
}

# Assert the four logging lines appear in order, with exact indentation.
_assert_logging_block() {
  local file="$1"
  grep -qxF '    logging:' "$file"
  grep -qxF '      driver: json-file' "$file"
  grep -qxF '        max-size: "10m"' "$file"
  grep -qxF '        max-file: "3"' "$file"
  # Order check: the block is contiguous.
  run grep -A4 -xF '    logging:' "$file"
  [ "$output" = '    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"' ]
}

# _write_relay <mode> <domain> <email> <ca>
_write_relay() {
  RELAY_MODE_FOR_TEST="$1" DOMAIN_FOR_TEST="$2" EMAIL_FOR_TEST="$3" CA_FOR_TEST="$4" \
    bash -c "
      INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'
      RELAY_MODE=\"\$RELAY_MODE_FOR_TEST\"
      RELAY_DOMAIN=\"\$DOMAIN_FOR_TEST\"
      TRAEFIK_EMAIL=\"\$EMAIL_FOR_TEST\"
      TRAEFIK_CA=\"\$CA_FOR_TEST\"
      APPS_DIR=/home/deploy/apps
      RELAY_PORT=8222
      TRAEFIK_NETWORK=traefik-public
      TRAEFIK_CERTRESOLVER=letsencrypt
      agent_relay_write_relay_compose '${COMPOSE_DIR}'
    "
}

_write_traefik() {
  CA_FOR_TEST="$1" EMAIL_FOR_TEST="$2" \
    bash -c "
      INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'
      TRAEFIK_EMAIL=\"\$EMAIL_FOR_TEST\"
      TRAEFIK_CA=\"\$CA_FOR_TEST\"
      agent_relay_write_traefik_compose '${COMPOSE_DIR}'
    "
}

_have_compose() {
  command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1
}

# ─── installer-written compose files ─────────────────────────────────────────

@test "greenfield relay compose has the log rotation block" {
  _write_relay greenfield relay.example.com admin@example.com letsencrypt
  _assert_logging_block "${COMPOSE_DIR}/docker-compose.yml"
}

@test "existing-traefik relay compose has the log rotation block" {
  _write_relay existing-traefik relay.example.com admin@example.com letsencrypt
  _assert_logging_block "${COMPOSE_DIR}/docker-compose.yml"
}

@test "port-only relay compose has the log rotation block" {
  _write_relay port-only "" "" ""
  _assert_logging_block "${COMPOSE_DIR}/docker-compose.yml"
}

@test "traefik compose (letsencrypt) has the log rotation block" {
  _write_traefik letsencrypt admin@example.com
  _assert_logging_block "${COMPOSE_DIR}/docker-compose.yml"
}

@test "traefik compose (self-signed) has the log rotation block" {
  _write_traefik self-signed ""
  _assert_logging_block "${COMPOSE_DIR}/docker-compose.yml"
}

@test "every installer-written compose validates with docker compose config" {
  _have_compose || skip "docker compose not available"
  touch "${COMPOSE_DIR}/.env"
  local mode
  for mode in greenfield existing-traefik port-only; do
    _write_relay "$mode" relay.example.com admin@example.com letsencrypt
    run docker compose -f "${COMPOSE_DIR}/docker-compose.yml" config -q
    [ "$status" -eq 0 ]
  done
  _write_traefik letsencrypt admin@example.com
  run docker compose -f "${COMPOSE_DIR}/docker-compose.yml" config -q
  [ "$status" -eq 0 ]
}

# ─── repo compose files ──────────────────────────────────────────────────────

@test "docker-compose.yml has the log rotation block" {
  _assert_logging_block "${ROOT}/docker-compose.yml"
}

@test "docker-compose.prod.example.yml has the log rotation block" {
  _assert_logging_block "${ROOT}/docker-compose.prod.example.yml"
}

@test "prod example joins the traefik-public network like the installer" {
  grep -qxF '      - traefik-public' "${ROOT}/docker-compose.prod.example.yml"
  grep -qxF '  traefik-public:' "${ROOT}/docker-compose.prod.example.yml"
  run grep -E '^      - traefik$|^  traefik:$' "${ROOT}/docker-compose.prod.example.yml"
  [ "$status" -ne 0 ]
}

@test "prod example requires APPS_HOST_DIR for the apps mount" {
  grep -qF '      - ${APPS_HOST_DIR:?set APPS_HOST_DIR to the host directory of your app repos (see docs/operations.md)}:/apps' \
    "${ROOT}/docker-compose.prod.example.yml"
  run grep -F '/path/to/apps:/apps' "${ROOT}/docker-compose.prod.example.yml"
  [ "$status" -ne 0 ]
}

@test "prod example validates with APPS_HOST_DIR set and fails with the hint when unset" {
  _have_compose || skip "docker compose not available"
  cp "${ROOT}/docker-compose.prod.example.yml" "${COMPOSE_DIR}/docker-compose.yml"
  touch "${COMPOSE_DIR}/.env"
  run env APPS_HOST_DIR=/tmp/x docker compose -f "${COMPOSE_DIR}/docker-compose.yml" config -q
  [ "$status" -eq 0 ]
  run env -u APPS_HOST_DIR docker compose -f "${COMPOSE_DIR}/docker-compose.yml" config -q
  [ "$status" -ne 0 ]
  [[ "$output" == *"set APPS_HOST_DIR to the host directory of your app repos"* ]]
}

@test "dev docker-compose.yml validates with docker compose config" {
  _have_compose || skip "docker compose not available"
  run docker compose -f "${ROOT}/docker-compose.yml" config -q
  [ "$status" -eq 0 ]
}

# ─── Dockerfile HEALTHCHECK ──────────────────────────────────────────────────

@test "Dockerfile declares the HEALTHCHECK against /health" {
  grep -qxF 'HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=2s --retries=3 CMD wget -qO- "http://127.0.0.1:${PORT:-8222}/health" >/dev/null || exit 1' \
    "${ROOT}/Dockerfile"
}
