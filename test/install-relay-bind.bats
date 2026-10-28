#!/usr/bin/env bats
# Tests for the plain-HTTP port binding that agent_relay_write_relay_compose
# writes in greenfield, existing-traefik and port-only modes.
#
# install.sh is sourced with INSTALL_SH_SOURCE_ONLY=1 so no Docker or root is
# needed. RELAY_BIND is passed in the environment (not set inside the fragment)
# because install.sh records at source time whether it was set explicitly.
# The Step 7 banner lives in the installer's main body and cannot be reached
# source-only, so it is not tested here.

INSTALL_SH="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/install.sh"

setup() {
  COMPOSE_DIR="$(mktemp -d)"
}

teardown() {
  rm -rf "$COMPOSE_DIR"
}

# _port_line <mode> <domain> <email> <ca> [bind-env-assignment...]
# Writes the relay compose and prints the single ports entry. Extra args are
# env assignments (e.g. RELAY_BIND=0.0.0.0) placed in the sourcing process's
# environment; pass none to leave RELAY_BIND absent.
_port_line() {
  local mode="$1" domain="$2" email="$3" ca="$4"
  shift 4
  run env -u RELAY_BIND "$@" \
    RELAY_MODE_FOR_TEST="$mode" DOMAIN_FOR_TEST="$domain" EMAIL_FOR_TEST="$email" CA_FOR_TEST="$ca" \
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
      grep -E '^      - \"[0-9.:]*8222(:8222)?\"\$' '${COMPOSE_DIR}/docker-compose.yml'
    " 2>&1
}

# ─── greenfield, TLS route via Let's Encrypt (domain + email) ────────────────

@test "greenfield TLS (domain+email), RELAY_BIND absent: default 127.0.0.1 wins" {
  _port_line greenfield relay.example.com admin@example.com letsencrypt
  [ "$status" -eq 0 ]
  [ "$output" = '      - "127.0.0.1:8222:8222"' ]
}

@test "greenfield TLS (domain+email), RELAY_BIND=0.0.0.0: explicit bind wins" {
  _port_line greenfield relay.example.com admin@example.com letsencrypt RELAY_BIND=0.0.0.0
  [ "$status" -eq 0 ]
  [ "$output" = '      - "0.0.0.0:8222:8222"' ]
}

@test "greenfield TLS (domain+email), RELAY_BIND empty: counts as unset, 127.0.0.1" {
  _port_line greenfield relay.example.com admin@example.com letsencrypt RELAY_BIND=
  [ "$status" -eq 0 ]
  [ "$output" = '      - "127.0.0.1:8222:8222"' ]
}

# ─── greenfield, TLS route via self-signed (domain, no email) ────────────────

@test "greenfield TLS (domain+self-signed), RELAY_BIND absent: default 127.0.0.1 wins" {
  _port_line greenfield relay.example.com "" self-signed
  [ "$status" -eq 0 ]
  [ "$output" = '      - "127.0.0.1:8222:8222"' ]
}

@test "greenfield TLS (domain+self-signed), RELAY_BIND=0.0.0.0: explicit bind wins" {
  _port_line greenfield relay.example.com "" self-signed RELAY_BIND=0.0.0.0
  [ "$status" -eq 0 ]
  [ "$output" = '      - "0.0.0.0:8222:8222"' ]
}

@test "greenfield TLS (domain+self-signed), RELAY_BIND empty: counts as unset, 127.0.0.1" {
  _port_line greenfield relay.example.com "" self-signed RELAY_BIND=
  [ "$status" -eq 0 ]
  [ "$output" = '      - "127.0.0.1:8222:8222"' ]
}

# ─── greenfield, no domain: no TLS route ─────────────────────────────────────

@test "greenfield no domain, RELAY_BIND absent: all interfaces (only access path)" {
  _port_line greenfield "" "" letsencrypt
  [ "$status" -eq 0 ]
  [ "$output" = '      - "8222:8222"' ]
}

@test "greenfield no domain, RELAY_BIND=0.0.0.0: explicit bind wins" {
  _port_line greenfield "" "" letsencrypt RELAY_BIND=0.0.0.0
  [ "$status" -eq 0 ]
  [ "$output" = '      - "0.0.0.0:8222:8222"' ]
}

@test "greenfield no domain, RELAY_BIND=127.0.0.1: explicit loopback wins over all-interfaces" {
  _port_line greenfield "" "" letsencrypt RELAY_BIND=127.0.0.1
  [ "$status" -eq 0 ]
  [ "$output" = '      - "127.0.0.1:8222:8222"' ]
}

@test "greenfield no domain, RELAY_BIND empty: counts as unset, all interfaces" {
  _port_line greenfield "" "" letsencrypt RELAY_BIND=
  [ "$status" -eq 0 ]
  [ "$output" = '      - "8222:8222"' ]
}

# ─── greenfield, domain without email and not self-signed: no TLS route ──────

@test "greenfield domain without email/self-signed, RELAY_BIND absent: all interfaces" {
  _port_line greenfield relay.example.com "" letsencrypt
  [ "$status" -eq 0 ]
  [ "$output" = '      - "8222:8222"' ]
}

@test "greenfield domain without email/self-signed, RELAY_BIND=0.0.0.0: explicit bind wins" {
  _port_line greenfield relay.example.com "" letsencrypt RELAY_BIND=0.0.0.0
  [ "$status" -eq 0 ]
  [ "$output" = '      - "0.0.0.0:8222:8222"' ]
}

@test "greenfield domain without email/self-signed, RELAY_BIND empty: counts as unset, all interfaces" {
  _port_line greenfield relay.example.com "" letsencrypt RELAY_BIND=
  [ "$status" -eq 0 ]
  [ "$output" = '      - "8222:8222"' ]
}

# ─── other modes unchanged ───────────────────────────────────────────────────

@test "port-only, RELAY_BIND absent: 127.0.0.1 default" {
  _port_line port-only "" "" letsencrypt
  [ "$status" -eq 0 ]
  [ "$output" = '      - "127.0.0.1:8222:8222"' ]
}

@test "port-only, RELAY_BIND=0.0.0.0: explicit bind wins" {
  _port_line port-only "" "" letsencrypt RELAY_BIND=0.0.0.0
  [ "$status" -eq 0 ]
  [ "$output" = '      - "0.0.0.0:8222:8222"' ]
}

@test "existing-traefik: expose only, no published host port" {
  run env -u RELAY_BIND RELAY_BIND=0.0.0.0 bash -c "
    INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'
    RELAY_MODE=existing-traefik
    RELAY_DOMAIN=relay.example.com
    APPS_DIR=/home/deploy/apps
    RELAY_PORT=8222
    TRAEFIK_NETWORK=traefik-public
    TRAEFIK_CERTRESOLVER=letsencrypt
    agent_relay_write_relay_compose '${COMPOSE_DIR}'
    cat '${COMPOSE_DIR}/docker-compose.yml'
  " 2>&1
  [ "$status" -eq 0 ]
  [[ "$output" =~ 'expose:' ]]
  [[ "$output" =~ '- "8222"' ]]
  ! [[ "$output" =~ 'ports:' ]]
}
