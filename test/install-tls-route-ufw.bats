#!/usr/bin/env bats
# Tests for the extracted greenfield TLS-route predicate, the shared effective
# bind and the UFW port list in install.sh.
#
# install.sh is sourced with INSTALL_SH_SOURCE_ONLY=1, so no Docker or root is
# needed. agent_relay_greenfield_tls_route, agent_relay_relay_bind and
# agent_relay_ufw_ports are defined above the source-only guard;
# agent_relay_write_relay_compose pins the relay compose port line for the
# staging / pebble-with-email TLS routes and must agree with
# agent_relay_relay_bind. The Step 7 summary and the UFW hint block live in the
# installer main body (below the guard) and are reached only through these
# functions. The call sites themselves cannot be executed here, so the last
# tests pin them textually: the Step 5 greenfield bootstrap calls, the UFW
# ports_needed call (mode, route flag, bind, port) and the banner's
# HTTPS_ROUTE_RC condition each appear exactly once, below the guard. What
# the lines do at run time (the empty-list skip, the banner text) stays
# unexecuted.

INSTALL_SH="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/install.sh"

setup() {
  COMPOSE_DIR="$(mktemp -d)"
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

# _bind_line <mode> <domain> <email> <ca> [bind-env-assignment...]
# One sourcing: prints the effective bind from agent_relay_relay_bind (as
# "BIND <value>") and the single published-ports entry the compose writer
# emits (as "LINE <entry>"), so each row asserts the function and the file
# agree. RELAY_BIND is passed in the environment because install.sh records at
# source time whether it was set explicitly; pass no assignment to leave it
# absent.
_bind_line() {
  local mode="$1" domain="$2" email="$3" ca="$4"
  shift 4
  run env -u RELAY_BIND "$@" MODE_FOR="$mode" DOM="$domain" EML="$email" CA="$ca" bash -c "
    INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'
    RELAY_MODE=\"\$MODE_FOR\"
    RELAY_DOMAIN=\"\$DOM\"
    TRAEFIK_EMAIL=\"\$EML\"
    TRAEFIK_CA=\"\$CA\"
    APPS_DIR=/home/deploy/apps
    RELAY_PORT=8222
    TRAEFIK_NETWORK=traefik-public
    TRAEFIK_CERTRESOLVER=letsencrypt
    echo \"BIND \$(agent_relay_relay_bind)\"
    agent_relay_write_relay_compose '${COMPOSE_DIR}'
    echo \"LINE \$(grep -E '^      - \"[0-9.:]*8222(:8222)?\"\$' '${COMPOSE_DIR}/docker-compose.yml')\"
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

# ─── agent_relay_relay_bind: effective-bind table ─────────────────────────────
# Each row pins the bind the function prints and the compose port line that
# agrees with it. Which input wins: an explicit non-empty RELAY_BIND always
# wins and is bind-qualified (even 0.0.0.0); with a TLS route and no explicit
# bind the default 127.0.0.1 wins over the fallback; without a TLS route and
# with RELAY_BIND absent or empty the all-interfaces fallback wins (printed as
# 0.0.0.0, emitted as the bare PORT:PORT line); outside greenfield RELAY_BIND
# always wins (port-only publishes exactly on it, default included).

@test "bind: greenfield no TLS route, RELAY_BIND absent -> 0.0.0.0, bare port line" {
  _bind_line greenfield "" "" letsencrypt
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "BIND 0.0.0.0" ]
  [ "${lines[1]}" = 'LINE       - "8222:8222"' ]
}

@test "bind: greenfield no TLS route, RELAY_BIND empty -> 0.0.0.0 (empty counts as unset), bare port line" {
  _bind_line greenfield "" "" letsencrypt RELAY_BIND=
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "BIND 0.0.0.0" ]
  [ "${lines[1]}" = 'LINE       - "8222:8222"' ]
}

@test "bind: greenfield no TLS route, RELAY_BIND=127.0.0.1 -> explicit bind wins, qualified port line" {
  _bind_line greenfield "" "" letsencrypt RELAY_BIND=127.0.0.1
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "BIND 127.0.0.1" ]
  [ "${lines[1]}" = 'LINE       - "127.0.0.1:8222:8222"' ]
}

@test "bind: greenfield no TLS route, RELAY_BIND=0.0.0.0 -> explicit bind wins over fallback, qualified port line" {
  _bind_line greenfield "" "" letsencrypt RELAY_BIND=0.0.0.0
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "BIND 0.0.0.0" ]
  [ "${lines[1]}" = 'LINE       - "0.0.0.0:8222:8222"' ]
}

@test "bind: greenfield with TLS route, RELAY_BIND absent -> default 127.0.0.1, qualified port line" {
  _bind_line greenfield relay.example.com admin@example.com letsencrypt
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "BIND 127.0.0.1" ]
  [ "${lines[1]}" = 'LINE       - "127.0.0.1:8222:8222"' ]
}

@test "bind: greenfield with TLS route, RELAY_BIND empty -> default 127.0.0.1, qualified port line" {
  _bind_line greenfield relay.example.com admin@example.com letsencrypt RELAY_BIND=
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "BIND 127.0.0.1" ]
  [ "${lines[1]}" = 'LINE       - "127.0.0.1:8222:8222"' ]
}

@test "bind: greenfield with TLS route, RELAY_BIND=127.0.0.1 -> explicit bind wins, qualified port line" {
  _bind_line greenfield relay.example.com admin@example.com letsencrypt RELAY_BIND=127.0.0.1
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "BIND 127.0.0.1" ]
  [ "${lines[1]}" = 'LINE       - "127.0.0.1:8222:8222"' ]
}

@test "bind: greenfield with TLS route, RELAY_BIND=0.0.0.0 -> explicit bind wins, qualified port line" {
  _bind_line greenfield relay.example.com admin@example.com letsencrypt RELAY_BIND=0.0.0.0
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "BIND 0.0.0.0" ]
  [ "${lines[1]}" = 'LINE       - "0.0.0.0:8222:8222"' ]
}

@test "bind: port-only, RELAY_BIND absent -> default 127.0.0.1 (no fallback outside greenfield), qualified port line" {
  _bind_line port-only "" "" letsencrypt
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "BIND 127.0.0.1" ]
  [ "${lines[1]}" = 'LINE       - "127.0.0.1:8222:8222"' ]
}

@test "bind: port-only, RELAY_BIND=0.0.0.0 -> RELAY_BIND, qualified port line" {
  _bind_line port-only "" "" letsencrypt RELAY_BIND=0.0.0.0
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "BIND 0.0.0.0" ]
  [ "${lines[1]}" = 'LINE       - "0.0.0.0:8222:8222"' ]
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

# Asserts that the exact line occurs once in install.sh, below the source-only
# guard (the functions above it are tested by sourcing).
_pin_below_guard() {
  local line="$1" guard_line call_line
  run grep -cxF -- "$line" "$INSTALL_SH"
  [ "$output" = "1" ]
  call_line="$(grep -nxF -- "$line" "$INSTALL_SH" | head -1 | cut -d: -f1)"
  guard_line="$(grep -n 'INSTALL_SH_SOURCE_ONLY:-}" = "1" \]' "$INSTALL_SH" | head -1 | cut -d: -f1)"
  [ -n "$call_line" ]
  [ -n "$guard_line" ]
  [ "$call_line" -gt "$guard_line" ]
}

@test "install.sh Step 5 calls the greenfield compat check and bootstrap once, below the guard" {
  _pin_below_guard '  agent_relay_check_greenfield_compat'
  _pin_below_guard '  agent_relay_bootstrap_traefik "/opt/traefik"'
}

@test "install.sh UFW hint asks agent_relay_ufw_ports with mode, route flag, shared bind and port, once, below the guard" {
  _pin_below_guard '  ports_needed="$(agent_relay_ufw_ports "$RELAY_MODE" "${GREENFIELD_TLS_ROUTE:-}" "$(agent_relay_relay_bind)" "$RELAY_PORT")"'
  _pin_below_guard '  if [ -n "$ports_needed" ]; then'
}

@test "install.sh Step 7 banner branches on HTTPS_ROUTE_RC once, below the guard" {
  _pin_below_guard 'HTTPS_ROUTE_RC=0'
  _pin_below_guard 'if [ "$HTTPS_ROUTE_RC" = "1" ]; then'
}
