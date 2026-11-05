#!/usr/bin/env bats
# Tests for the extracted greenfield TLS-route predicate and the UFW port list
# in install.sh.
#
# install.sh is sourced with INSTALL_SH_SOURCE_ONLY=1, so no Docker or root is
# needed. agent_relay_greenfield_tls_route and agent_relay_ufw_ports are defined
# above the source-only guard; agent_relay_write_relay_compose pins the relay
# compose port line for the staging / pebble-with-email TLS routes. The Step 7
# summary and the UFW hint block live in the installer main body (below the
# guard) and are reached only through these two functions.

INSTALL_SH="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/install.sh"

setup() {
  # Temp dir inside the worktree: a bare mktemp targets /var/folders, which the
  # sandbox denies (Operation not permitted).
  COMPOSE_DIR="$(mktemp -d "${BATS_TEST_DIRNAME}/.tls-ufw-tmp.XXXXXX")"
}

teardown() {
  rm -rf "$COMPOSE_DIR"
}

# _tls_route <domain> <email> <ca>: sources install.sh and echoes ROUTE /
# NO_ROUTE for agent_relay_greenfield_tls_route (the && / || branch of an if is
# exempt from the sourced set -e, so both outcomes are captured cleanly).
_tls_route() {
  run env DOM="$1" EML="$2" CA="$3" bash -c "
    INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'
    RELAY_DOMAIN=\"\$DOM\"
    TRAEFIK_EMAIL=\"\$EML\"
    TRAEFIK_CA=\"\$CA\"
    if agent_relay_greenfield_tls_route; then echo ROUTE; else echo NO_ROUTE; fi
  " 2>&1
}

# _ufw <mode> <tls_route 0|1> <bind> <port>: prints the space-separated port
# list agent_relay_ufw_ports produces (empty for nothing to open).
_ufw() {
  run env M="$1" T="$2" B="$3" P="$4" bash -c "
    INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'
    agent_relay_ufw_ports \"\$M\" \"\$T\" \"\$B\" \"\$P\"
  " 2>&1
}

# _port_line <mode> <domain> <email> <ca>: writes the relay compose with
# RELAY_BIND absent and prints the single published-ports entry.
_port_line() {
  local mode="$1" domain="$2" email="$3" ca="$4"
  run env -u RELAY_BIND MODE_FOR="$mode" DOM="$domain" EML="$email" CA="$ca" bash -c "
    INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'
    RELAY_MODE=\"\$MODE_FOR\"
    RELAY_DOMAIN=\"\$DOM\"
    TRAEFIK_EMAIL=\"\$EML\"
    TRAEFIK_CA=\"\$CA\"
    APPS_DIR=/home/deploy/apps
    RELAY_PORT=8222
    TRAEFIK_NETWORK=traefik-public
    TRAEFIK_CERTRESOLVER=letsencrypt
    agent_relay_write_relay_compose '${COMPOSE_DIR}'
    grep -E '^      - \"[0-9.:]*8222(:8222)?\"\$' '${COMPOSE_DIR}/docker-compose.yml'
  " 2>&1
}

# ─── agent_relay_greenfield_tls_route: predicate table ───────────────────────

@test "predicate: domain unset -> no route" {
  _tls_route "" "" letsencrypt
  [ "$status" -eq 0 ]
  [ "$output" = "NO_ROUTE" ]
}

@test "predicate: domain + email -> route" {
  _tls_route relay.example.com admin@example.com letsencrypt
  [ "$status" -eq 0 ]
  [ "$output" = "ROUTE" ]
}

@test "predicate: domain + self-signed (no email) -> route" {
  _tls_route relay.example.com "" self-signed
  [ "$status" -eq 0 ]
  [ "$output" = "ROUTE" ]
}

@test "predicate: domain + staging without email -> no route" {
  _tls_route relay.example.com "" staging
  [ "$status" -eq 0 ]
  [ "$output" = "NO_ROUTE" ]
}

@test "predicate: domain + pebble without email -> no route" {
  _tls_route relay.example.com "" pebble
  [ "$status" -eq 0 ]
  [ "$output" = "NO_ROUTE" ]
}

@test "predicate: domain + staging + email -> route" {
  _tls_route relay.example.com admin@example.com staging
  [ "$status" -eq 0 ]
  [ "$output" = "ROUTE" ]
}

@test "predicate: domain unset but email + self-signed set -> no route (domain is required)" {
  _tls_route "" admin@example.com self-signed
  [ "$status" -eq 0 ]
  [ "$output" = "NO_ROUTE" ]
}

# ─── relay compose port line pinned for staging / pebble with email ───────────

@test "relay compose port line: greenfield staging + email -> TLS route, loopback bind" {
  _port_line greenfield relay.example.com admin@example.com staging
  [ "$status" -eq 0 ]
  [ "$output" = '      - "127.0.0.1:8222:8222"' ]
}

@test "relay compose port line: greenfield pebble + email -> TLS route, loopback bind" {
  _port_line greenfield relay.example.com admin@example.com pebble
  [ "$status" -eq 0 ]
  [ "$output" = '      - "127.0.0.1:8222:8222"' ]
}

# ─── agent_relay_ufw_ports: UFW port table ────────────────────────────────────

@test "ufw: greenfield with TLS route -> 80/tcp 443/tcp" {
  _ufw greenfield 1 127.0.0.1 8222
  [ "$status" -eq 0 ]
  [ "$output" = "80/tcp 443/tcp" ]
}

@test "ufw: greenfield no route, bind unset -> 8222/tcp (compose rule: effective bind is all interfaces)" {
  # Ground the row in the compose rule first: greenfield + no route + RELAY_BIND
  # unset publishes on all interfaces (no leading IP), so the effective bind the
  # port line uses is not 127.0.0.1. Feed the function that effective bind.
  _port_line greenfield "" "" letsencrypt
  [ "$status" -eq 0 ]
  [ "$output" = '      - "8222:8222"' ]
  _ufw greenfield 0 0.0.0.0 8222
  [ "$output" = "8222/tcp" ]
}

@test "ufw: greenfield no route, bind 0.0.0.0 -> 8222/tcp" {
  _ufw greenfield 0 0.0.0.0 8222
  [ "$status" -eq 0 ]
  [ "$output" = "8222/tcp" ]
}

@test "ufw: greenfield no route, bind 127.0.0.1 -> empty (loopback only, nothing to open)" {
  _ufw greenfield 0 127.0.0.1 8222
  [ "$status" -eq 0 ]
  [ "$output" = "" ]
}

@test "ufw: existing-traefik -> 80/tcp 443/tcp (existing proxy fronts the relay)" {
  _ufw existing-traefik 0 127.0.0.1 8222
  [ "$status" -eq 0 ]
  [ "$output" = "80/tcp 443/tcp" ]
}

@test "ufw: port-only bind 127.0.0.1 -> empty" {
  _ufw port-only 0 127.0.0.1 8222
  [ "$status" -eq 0 ]
  [ "$output" = "" ]
}

@test "ufw: port-only bind 0.0.0.0 port 9000 -> 9000/tcp" {
  _ufw port-only 0 0.0.0.0 9000
  [ "$status" -eq 0 ]
  [ "$output" = "9000/tcp" ]
}
