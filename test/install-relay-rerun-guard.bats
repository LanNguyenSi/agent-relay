#!/usr/bin/env bats
# Tests for the relay compose re-run guard and the UFW hint text in install.sh.
#
# install.sh is sourced with INSTALL_SH_SOURCE_ONLY=1, so no Docker or root is
# needed. agent_relay_relay_compose_guard and agent_relay_ufw_hint are defined
# above the source-only guard; their call sites (Step 5 and the UFW block) sit
# below it and are pinned textually at the end.
#
# The guard is driven against compose files the installer itself wrote (through
# agent_relay_write_relay_compose with the variables of the "first install")
# and against hand-built files. Each run passes its variables through the
# environment because install.sh records at source time whether RELAY_BIND was
# set explicitly.

bats_require_minimum_version 1.11.0

INSTALL_SH="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/install.sh"

setup() {
  RELAY_TEST_DIR="$(mktemp -d)"
  COMPOSE="${RELAY_TEST_DIR}/docker-compose.yml"
}

teardown() {
  rm -rf "$RELAY_TEST_DIR"
}

# _first_install <domain> <email> <ca> [env assignment...]: writes the relay
# compose a first greenfield install with these variables would write.
_first_install() {
  local domain="$1" email="$2" ca="$3"
  shift 3
  run env -u RELAY_BIND -u RELAY_REWRITE "$@" DOM="$domain" EML="$email" CA="$ca" bash -c "
    INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'
    RELAY_MODE=greenfield
    RELAY_DOMAIN=\"\$DOM\"
    TRAEFIK_EMAIL=\"\$EML\"
    TRAEFIK_CA=\"\$CA\"
    APPS_DIR=/home/deploy/apps
    RELAY_PORT=8222
    agent_relay_write_relay_compose '${RELAY_TEST_DIR}'
  " 2>&1
  [ "$status" -eq 0 ]
}

# _guard <domain> <email> <ca> [env assignment...]: runs the guard, then the
# compose write the installer does next, for a re-run with these variables
# against ${RELAY_TEST_DIR} (mode greenfield unless MODE_FOR is passed). A
# refusal exits before the write, as install.sh does; a pass prints GUARD_OK
# after the file was rewritten (GUARD_ONLY=1 skips the write).
_guard() {
  local domain="$1" email="$2" ca="$3"
  shift 3
  run env -u RELAY_BIND -u RELAY_REWRITE "$@" DOM="$domain" EML="$email" CA="$ca" bash -c "
    INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'
    RELAY_MODE=\"\${MODE_FOR-greenfield}\"
    RELAY_DOMAIN=\"\$DOM\"
    TRAEFIK_EMAIL=\"\$EML\"
    TRAEFIK_CA=\"\$CA\"
    APPS_DIR=/home/deploy/apps
    RELAY_PORT=8222
    TRAEFIK_NETWORK=traefik-public
    TRAEFIK_CERTRESOLVER=letsencrypt
    agent_relay_relay_compose_guard '${RELAY_TEST_DIR}'
    [ "\${GUARD_ONLY:-}" = 1 ] || agent_relay_write_relay_compose '${RELAY_TEST_DIR}'
    echo GUARD_OK
  " 2>&1
}

# _guard_split <domain> <email> <ca> [env assignment...]: as _guard, but stdout
# and stderr are captured apart ($output is stdout, $stderr is stderr). The
# guard writes only GUARD_OK to stdout; its warning and its refusal text go to
# stderr.
_guard_split() {
  local domain="$1" email="$2" ca="$3"
  shift 3
  run --separate-stderr env -u RELAY_BIND -u RELAY_REWRITE "$@" DOM="$domain" EML="$email" CA="$ca" bash -c "
    INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'
    RELAY_MODE=\"\${MODE_FOR-greenfield}\"
    RELAY_DOMAIN=\"\$DOM\"
    TRAEFIK_EMAIL=\"\$EML\"
    TRAEFIK_CA=\"\$CA\"
    APPS_DIR=/home/deploy/apps
    RELAY_PORT=8222
    TRAEFIK_NETWORK=traefik-public
    TRAEFIK_CERTRESOLVER=letsencrypt
    agent_relay_relay_compose_guard '${RELAY_TEST_DIR}'
    [ \"\${GUARD_ONLY:-}\" = 1 ] || agent_relay_write_relay_compose '${RELAY_TEST_DIR}'
    echo GUARD_OK
  "
}

# ─── refusals: nothing changed ───────────────────────────────────────────────

@test "guard: self-signed TLS compose + bare re-run -> refused, file byte-identical" {
  _first_install relay.example.com "" self-signed
  cp "$COMPOSE" "${RELAY_TEST_DIR}/before"
  _guard "" "" letsencrypt
  [ "$status" -ne 0 ]
  [[ "$output" == *"would drop the TLS route for the relay"* ]]
  [[ "$output" == *"RELAY_DOMAIN and TRAEFIK_EMAIL (or TRAEFIK_CA=self-signed)"* ]]
  [[ "$output" == *"RELAY_REWRITE=1"* ]]
  [[ "$output" == *"Nothing was changed."* ]]
  [[ "$output" != *GUARD_OK* ]]
  cmp "$COMPOSE" "${RELAY_TEST_DIR}/before"
}

@test "guard: ACME TLS compose + bare re-run -> refused, file byte-identical" {
  _first_install relay.example.com admin@example.com letsencrypt
  cp "$COMPOSE" "${RELAY_TEST_DIR}/before"
  _guard "" "" letsencrypt
  [ "$status" -ne 0 ]
  [[ "$output" == *"would drop the TLS route for the relay"* ]]
  cmp "$COMPOSE" "${RELAY_TEST_DIR}/before"
}

@test "guard: ACME TLS compose + domain but no email -> refused (no route this run)" {
  _first_install relay.example.com admin@example.com letsencrypt
  _guard relay.example.com "" letsencrypt
  [ "$status" -ne 0 ]
  [[ "$output" == *"would drop the TLS route for the relay"* ]]
}

@test "guard: self-signed TLS compose + same domain with ACME email -> passes (route kept)" {
  _first_install relay.example.com "" self-signed
  _guard relay.example.com admin@example.com letsencrypt
  [ "$status" -eq 0 ]
  [[ "$output" == *GUARD_OK* ]]
}

@test "guard: loopback bind compose, no TLS route, no RELAY_BIND -> refused (would widen to all interfaces)" {
  _first_install "" "" letsencrypt RELAY_BIND=127.0.0.1
  grep -q '"127.0.0.1:8222:8222"' "$COMPOSE"
  cp "$COMPOSE" "${RELAY_TEST_DIR}/before"
  _guard "" "" letsencrypt
  [ "$status" -ne 0 ]
  [[ "$output" == *"the existing bind 127.0.0.1 of the plain-HTTP port"* ]]
  [[ "$output" == *"publish it on 0.0.0.0"* ]]
  [[ "$output" == *"Re-run with RELAY_BIND=127.0.0.1, or with the RELAY_MODE of the first install if it was not greenfield"* ]]
  [[ "$output" != *"values of the first install"* ]]
  [[ "$output" != *"TLS route for the relay"* ]]
  cmp "$COMPOSE" "${RELAY_TEST_DIR}/before"
}

@test "guard: TLS compose with loopback bind + TLS re-run with explicit RELAY_BIND=0.0.0.0 -> refused (widening needs the override)" {
  _first_install relay.example.com admin@example.com letsencrypt
  _guard relay.example.com admin@example.com letsencrypt RELAY_BIND=0.0.0.0
  [ "$status" -ne 0 ]
  [[ "$output" == *"the existing bind 127.0.0.1"* ]]
  [[ "$output" != *"TLS route for the relay"* ]]
}

@test "guard: bare re-run against a TLS compose names both losses" {
  _first_install relay.example.com admin@example.com letsencrypt
  _guard "" "" letsencrypt
  [ "$status" -ne 0 ]
  [[ "$output" == *"the TLS route for the relay"* ]]
  [[ "$output" == *"and the existing bind 127.0.0.1"* ]]
  [[ "$output" == *"values of the first install and RELAY_BIND=127.0.0.1"* ]]
  [[ "$output" == *"the RELAY_MODE of the first install if it was not greenfield"* ]]
}

# ─── passes ──────────────────────────────────────────────────────────────────

@test "guard: re-run with the original TLS variables -> passes" {
  _first_install relay.example.com admin@example.com letsencrypt
  _guard relay.example.com admin@example.com letsencrypt
  [ "$status" -eq 0 ]
  [[ "$output" == *GUARD_OK* ]]
}

@test "guard: re-run with the original self-signed variables -> passes and the file is rewritten with the route" {
  _first_install relay.example.com "" self-signed
  printf '# hand edit\n' >> "$COMPOSE"
  _guard relay.example.com "" self-signed
  [ "$status" -eq 0 ]
  [[ "$output" == *GUARD_OK* ]]
  ! grep -q 'hand edit' "$COMPOSE"
  grep -q 'traefik.http.routers.relay.tls=true' "$COMPOSE"
  grep -q '"127.0.0.1:8222:8222"' "$COMPOSE"
}

@test "guard: loopback compose + re-run with explicit RELAY_BIND=127.0.0.1 -> passes" {
  _first_install "" "" letsencrypt RELAY_BIND=127.0.0.1
  _guard "" "" letsencrypt RELAY_BIND=127.0.0.1
  [ "$status" -eq 0 ]
  [[ "$output" == *GUARD_OK* ]]
}

@test "guard: all-interfaces compose + bare re-run -> passes (nothing to lose)" {
  _first_install "" "" letsencrypt
  grep -q '"8222:8222"' "$COMPOSE"
  _guard "" "" letsencrypt
  [ "$status" -eq 0 ]
  [[ "$output" == *GUARD_OK* ]]
}

@test "guard: no existing compose file -> passes and the file is written" {
  [ ! -e "$COMPOSE" ]
  _guard "" "" letsencrypt
  [ "$status" -eq 0 ]
  [[ "$output" == *GUARD_OK* ]]
  [ -f "$COMPOSE" ]
}

@test "guard: compose path is a directory -> passes (not a file the installer wrote)" {
  mkdir "$COMPOSE"
  _guard "" "" letsencrypt GUARD_ONLY=1
  [ "$status" -eq 0 ]
  [[ "$output" == *GUARD_OK* ]]
}

@test "guard: unreadable compose file -> passes" {
  _first_install relay.example.com "" self-signed
  chmod 000 "$COMPOSE"
  if [ -r "$COMPOSE" ]; then
    chmod 600 "$COMPOSE"
    skip "file stays readable (running as root)"
  fi
  _guard "" "" letsencrypt GUARD_ONLY=1
  chmod 600 "$COMPOSE"
  [ "$status" -eq 0 ]
  [[ "$output" == *GUARD_OK* ]]
}

@test "guard: other modes are never refused" {
  _first_install relay.example.com "" self-signed
  _guard "" "" letsencrypt MODE_FOR=port-only
  [ "$status" -eq 0 ]
  [[ "$output" == *GUARD_OK* ]]
  _guard "" "" letsencrypt MODE_FOR=existing-traefik
  [ "$status" -eq 0 ]
  [[ "$output" == *GUARD_OK* ]]
}

# ─── amended bind rule: any specific address is protected ────────────────────

@test "guard: loopback compose + RELAY_BIND=10.0.0.5 -> refused, names both addresses" {
  _first_install "" "" letsencrypt RELAY_BIND=127.0.0.1
  cp "$COMPOSE" "${RELAY_TEST_DIR}/before"
  _guard "" "" letsencrypt RELAY_BIND=10.0.0.5
  [ "$status" -ne 0 ]
  [[ "$output" == *"the existing bind 127.0.0.1"* ]]
  [[ "$output" == *"publish it on 10.0.0.5"* ]]
  cmp "$COMPOSE" "${RELAY_TEST_DIR}/before"
}

@test "guard: loopback compose + RELAY_BIND=:: -> refused (widening to all IPv6 interfaces)" {
  _first_install "" "" letsencrypt RELAY_BIND=127.0.0.1
  _guard "" "" letsencrypt RELAY_BIND=::
  [ "$status" -ne 0 ]
  [[ "$output" == *"publish it on ::"* ]]
}

@test "guard: loopback compose + RELAY_BIND=0.0.0.0 -> refused" {
  _first_install "" "" letsencrypt RELAY_BIND=127.0.0.1
  _guard "" "" letsencrypt RELAY_BIND=0.0.0.0
  [ "$status" -ne 0 ]
}

@test "guard: Tailscale-style bind 100.64.1.2 + bare re-run -> refused" {
  _first_install "" "" letsencrypt RELAY_BIND=100.64.1.2
  grep -q '"100.64.1.2:8222:8222"' "$COMPOSE"
  cp "$COMPOSE" "${RELAY_TEST_DIR}/before"
  _guard "" "" letsencrypt
  [ "$status" -ne 0 ]
  [[ "$output" == *"the existing bind 100.64.1.2"* ]]
  [[ "$output" == *"RELAY_BIND=100.64.1.2"* ]]
  cmp "$COMPOSE" "${RELAY_TEST_DIR}/before"
}

@test "guard: Tailscale-style bind 100.64.1.2 + same RELAY_BIND -> passes and rewrites" {
  _first_install "" "" letsencrypt RELAY_BIND=100.64.1.2
  _guard "" "" letsencrypt RELAY_BIND=100.64.1.2
  [ "$status" -eq 0 ]
  [[ "$output" == *GUARD_OK* ]]
}

@test "guard: IPv6 loopback bind ::1 (as the installer writes it) + bare re-run -> refused" {
  _first_install "" "" letsencrypt RELAY_BIND=::1
  grep -q '"::1:8222:8222"' "$COMPOSE"
  cp "$COMPOSE" "${RELAY_TEST_DIR}/before"
  _guard "" "" letsencrypt
  [ "$status" -ne 0 ]
  [[ "$output" == *"the existing bind ::1"* ]]
  [[ "$output" == *"RELAY_BIND=::1"* ]]
  cmp "$COMPOSE" "${RELAY_TEST_DIR}/before"
}

@test "guard: IPv6 loopback bind ::1 + same RELAY_BIND -> passes" {
  _first_install "" "" letsencrypt RELAY_BIND=::1
  _guard "" "" letsencrypt RELAY_BIND=::1
  [ "$status" -eq 0 ]
  [[ "$output" == *GUARD_OK* ]]
}

@test "guard: IPv6 address compares case-insensitively" {
  _first_install "" "" letsencrypt RELAY_BIND=FD00::A
  _guard "" "" letsencrypt RELAY_BIND=fd00::a
  [ "$status" -eq 0 ]
  [[ "$output" == *GUARD_OK* ]]
}

@test "guard: bracketed IPv6 port line [::1]:8222:8222 + bare re-run -> refused" {
  printf 'services:\n  relay:\n    ports:\n      - "[::1]:8222:8222"\n' > "$COMPOSE"
  _guard "" "" letsencrypt GUARD_ONLY=1
  [ "$status" -ne 0 ]
  [[ "$output" == *"the existing bind ::1"* ]]
}

@test "guard: bracketed IPv6 port line + same RELAY_BIND=::1 -> passes" {
  printf 'services:\n  relay:\n    ports:\n      - "[::1]:8222:8222"\n' > "$COMPOSE"
  _guard "" "" letsencrypt GUARD_ONLY=1 RELAY_BIND=::1
  [ "$status" -eq 0 ]
  [[ "$output" == *GUARD_OK* ]]
}

@test "guard: existing 0.0.0.0 port line (explicit) + bare re-run -> passes" {
  _first_install "" "" letsencrypt RELAY_BIND=0.0.0.0
  grep -q '"0.0.0.0:8222:8222"' "$COMPOSE"
  _guard "" "" letsencrypt
  [ "$status" -eq 0 ]
  [[ "$output" == *GUARD_OK* ]]
}

@test "guard: existing 0.0.0.0 port line + RELAY_BIND=127.0.0.1 -> passes (narrowing)" {
  _first_install "" "" letsencrypt RELAY_BIND=0.0.0.0
  _guard "" "" letsencrypt RELAY_BIND=127.0.0.1
  [ "$status" -eq 0 ]
  [[ "$output" == *GUARD_OK* ]]
}

@test "guard: existing :: port line + bare re-run -> passes" {
  _first_install "" "" letsencrypt RELAY_BIND=::
  grep -q '":::8222:8222"' "$COMPOSE"
  _guard "" "" letsencrypt
  [ "$status" -eq 0 ]
  [[ "$output" == *GUARD_OK* ]]
}

@test "guard: existing bare PORT:PORT line + bare re-run -> passes" {
  printf 'services:\n  relay:\n    ports:\n      - "8222:8222"\n' > "$COMPOSE"
  _guard "" "" letsencrypt GUARD_ONLY=1
  [ "$status" -eq 0 ]
  [[ "$output" == *GUARD_OK* ]]
}

@test "guard: unquoted port line - 127.0.0.1:8222:8222 + bare re-run -> refused" {
  printf 'services:\n  relay:\n    ports:\n      - 127.0.0.1:8222:8222\n' > "$COMPOSE"
  _guard "" "" letsencrypt GUARD_ONLY=1
  [ "$status" -ne 0 ]
  [[ "$output" == *"the existing bind 127.0.0.1"* ]]
}

@test "guard: single-quoted port line + bare re-run -> refused" {
  printf "services:\n  relay:\n    ports:\n      - '127.0.0.1:8222:8222'\n" > "$COMPOSE"
  _guard "" "" letsencrypt GUARD_ONLY=1
  [ "$status" -ne 0 ]
  [[ "$output" == *"the existing bind 127.0.0.1"* ]]
}

@test "guard: port line with a /tcp suffix is recognised" {
  printf 'services:\n  relay:\n    ports:\n      - "127.0.0.1:8222:8222/tcp"\n' > "$COMPOSE"
  _guard "" "" letsencrypt GUARD_ONLY=1
  [ "$status" -ne 0 ]
}

@test "guard: a volume line with colons is not read as a port line" {
  printf 'services:\n  relay:\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n      - /home/deploy/apps:/apps\n' > "$COMPOSE"
  _guard "" "" letsencrypt GUARD_ONLY=1
  [ "$status" -eq 0 ]
  [[ "$output" == *GUARD_OK* ]]
}

@test "guard: empty compose file -> passes (no abort under set -e)" {
  : > "$COMPOSE"
  _guard "" "" letsencrypt GUARD_ONLY=1
  [ "$status" -eq 0 ]
  [[ "$output" == *GUARD_OK* ]]
}

@test "guard: comment-only compose file -> passes (no abort under set -e)" {
  printf '# nothing\n   # here\n' > "$COMPOSE"
  _guard "" "" letsencrypt GUARD_ONLY=1
  [ "$status" -eq 0 ]
  [[ "$output" == *GUARD_OK* ]]
}

@test "guard: refusal advice offers the RELAY_MODE of the first install" {
  _first_install relay.example.com "" self-signed
  _guard "" "" letsencrypt
  [ "$status" -ne 0 ]
  [[ "$output" == *"the RELAY_DOMAIN and TRAEFIK_EMAIL (or TRAEFIK_CA=self-signed) values of the first install"* ]]
  [[ "$output" == *"or with the RELAY_MODE of the first install if it was not greenfield"* ]]
}

# ─── override ────────────────────────────────────────────────────────────────

@test "guard: RELAY_REWRITE=1 -> warns and lets the rewrite proceed" {
  _first_install relay.example.com "" self-signed
  _guard "" "" letsencrypt RELAY_REWRITE=1
  [ "$status" -eq 0 ]
  [[ "$output" == *"RELAY_REWRITE=1: rewriting"* ]]
  [[ "$output" == *"the TLS route for the relay"* ]]
  [[ "$output" == *GUARD_OK* ]]
  ! grep -q 'traefik.http.routers.relay.tls' "$COMPOSE"
  grep -q '^      - "8222:8222"$' "$COMPOSE"
}

@test "guard: RELAY_REWRITE other than 1 does not override" {
  _first_install relay.example.com "" self-signed
  _guard "" "" letsencrypt RELAY_REWRITE=true
  [ "$status" -ne 0 ]
  _guard "" "" letsencrypt RELAY_REWRITE=
  [ "$status" -ne 0 ]
}

@test "guard: RELAY_REWRITE=1 without a loss prints no warning" {
  _first_install relay.example.com "" self-signed
  _guard relay.example.com "" self-signed RELAY_REWRITE=1
  [ "$status" -eq 0 ]
  [[ "$output" != *"rewriting"* ]]
}

# ─── streams: warning and refusal on stderr, GUARD_OK on stdout ──────────────

@test "guard streams: the RELAY_REWRITE=1 warning is on stderr and stdout is exactly GUARD_OK" {
  _first_install relay.example.com "" self-signed
  _guard_split "" "" letsencrypt RELAY_REWRITE=1 GUARD_ONLY=1
  [ "$status" -eq 0 ]
  [ "$output" = "GUARD_OK" ]
  [[ "$stderr" == *"RELAY_REWRITE=1: rewriting"* ]]
}

@test "guard streams: a refusal writes its text to stderr and nothing to stdout" {
  _first_install relay.example.com "" self-signed
  _guard_split "" "" letsencrypt GUARD_ONLY=1
  [ "$status" -ne 0 ]
  [ -z "$output" ]
  [[ "$stderr" == *"would drop the TLS route for the relay"* ]]
  [[ "$stderr" == *"RELAY_REWRITE=1"* ]]
}

@test "guard streams: a pass without a loss writes nothing to stderr" {
  _first_install relay.example.com "" self-signed
  _guard_split relay.example.com "" self-signed GUARD_ONLY=1
  [ "$status" -eq 0 ]
  [ "$output" = "GUARD_OK" ]
  [ -z "$stderr" ]
}

# ─── hand-built files ────────────────────────────────────────────────────────

@test "guard: commented-out TLS label and port line do not count" {
  cat > "$COMPOSE" <<'YML'
services:
  relay:
    ports:
      #  - "127.0.0.1:8222:8222"
      - "8222:8222"
    labels:
      # - traefik.http.routers.relay.tls=true
      - traefik.enable=true
YML
  _guard "" "" letsencrypt
  [ "$status" -eq 0 ]
  [[ "$output" == *GUARD_OK* ]]
}

@test "guard: labels of another router name do not count" {
  cat > "$COMPOSE" <<'YML'
services:
  relay:
    ports:
      - "8222:8222"
    labels:
      - traefik.http.routers.relay2.tls=true
      - traefik.http.routers.other.tls.certresolver=letsencrypt
YML
  _guard "" "" letsencrypt
  [ "$status" -eq 0 ]
  [[ "$output" == *GUARD_OK* ]]
}

@test "guard: hand-edited file with a relay TLS router and a quoted label is refused" {
  cat > "$COMPOSE" <<'YML'
services:
  relay:
    ports:
      - "8222:8222"
    labels:
      - "traefik.http.routers.relay.tls.certresolver=myresolver"
YML
  _guard "" "" letsencrypt
  [ "$status" -ne 0 ]
  [[ "$output" == *"the TLS route for the relay"* ]]
}

@test "guard: a compose without markers (hand-written) is not refused" {
  printf 'services:\n  relay:\n    image: x\n' > "$COMPOSE"
  _guard "" "" letsencrypt
  [ "$status" -eq 0 ]
  [[ "$output" == *GUARD_OK* ]]
}

# ─── UFW hint text ───────────────────────────────────────────────────────────

# _hint <mode> <bind> <port> <missing>: output of agent_relay_ufw_hint.
_hint() {
  run env M="$1" B="$2" P="$3" MISS="$4" bash -c "
    INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'
    agent_relay_ufw_hint \"\$M\" \"\$B\" \"\$P\" \"\$MISS\"
  " 2>&1
}

@test "hint: leads with the bypass statement and never says the port is closed" {
  _hint greenfield 0.0.0.0 8222 "8222/tcp"
  [ "$status" -eq 0 ]
  [[ "$output" == *"bypass UFW's INPUT rules"* ]]
  [[ "$output" == *"reachable from the network whether or not UFW allows them"* ]]
  [[ "$output" != *"not allowed"* ]]
  [[ "$output" != *"Run this to open them:"* ]]
  first="$(printf '%s\n' "$output" | head -1)"
  [[ "$first" == *"UFW is active and does not list these port(s): 8222/tcp"* ]]
}

@test "hint: plain port on a non-loopback bind names RELAY_BIND=127.0.0.1 and DOCKER-USER (greenfield)" {
  _hint greenfield 0.0.0.0 8222 "8222/tcp"
  [[ "$output" == *"published on 0.0.0.0"* ]]
  [[ "$output" == *"RELAY_BIND=127.0.0.1"* ]]
  [[ "$output" == *"DOCKER-USER"* ]]
}

@test "hint: plain port on a non-loopback bind names RELAY_BIND and DOCKER-USER (port-only)" {
  _hint port-only 10.0.0.5 9000 "9000/tcp"
  [[ "$output" == *"9000/tcp is published on 10.0.0.5"* ]]
  [[ "$output" == *"RELAY_BIND=127.0.0.1"* ]]
  [[ "$output" == *"DOCKER-USER"* ]]
}

@test "hint: TLS route ports with a loopback plain bind name neither RELAY_BIND nor DOCKER-USER" {
  _hint greenfield 127.0.0.1 8222 "80/tcp 443/tcp"
  [[ "$output" == *"bypass UFW's INPUT rules"* ]]
  [[ "$output" != *"RELAY_BIND"* ]]
  [[ "$output" != *"DOCKER-USER"* ]]
}

@test "hint: existing-traefik publishes no plain port, so no RELAY_BIND or DOCKER-USER advice" {
  _hint existing-traefik 0.0.0.0 8222 "80/tcp 443/tcp"
  [[ "$output" == *"bypass UFW's INPUT rules"* ]]
  [[ "$output" != *"RELAY_BIND"* ]]
  [[ "$output" != *"DOCKER-USER"* ]]
}

@test "hint: ufw allow line is offered only for a daemon with iptables integration off, one command per port" {
  _hint greenfield 127.0.0.1 8222 "80/tcp 443/tcp"
  [[ "$output" == *'"iptables": false'* ]]
  [[ "$output" == *"Docker runs rootless, or the proxy uses host networking, UFW gates these ports"* ]]
  [[ "$output" == *"sudo ufw allow 80/tcp; sudo ufw allow 443/tcp;"* ]]
  iptables_line="$(printf '%s\n' "$output" | grep -n 'iptables": false' | head -1 | cut -d: -f1)"
  allow_line="$(printf '%s\n' "$output" | grep -n 'sudo ufw allow' | head -1 | cut -d: -f1)"
  [ "$iptables_line" -lt "$allow_line" ]
}

# ─── decision table ──────────────────────────────────────────────────────────
#
# The guard's tests below are derived from its decision inputs, not from past
# findings. Every value of every dimension appears in at least one row; every
# comparison (TLS-marker match, address exemption, address equality in both
# case directions, each early return) has a row on each side.
#
# Dimension                          Values
# ---------------------------------  ------------------------------------------
# existing TLS marker (labels)       none; relay.tls=true; relay.tls.certresolver=
#                                    (plain and quoted); tls=false; router relay2;
#                                    another router's certresolver; a commented-out
#                                    label (space and tab indent)
# this run's TLS route               yes (domain+email, domain+self-signed, domain+
#                                    staging+email); no (no domain, email only,
#                                    domain without email for letsencrypt, staging,
#                                    pebble; self-signed without domain)
# existing port-line address         none (no ports section); bare PORT:PORT; 0.0.0.0;
#                                    ::; 127.0.0.1; 10.0.0.5; 100.64.1.2; ::1;
#                                    [::1]; FD00::A and fd00::a; ABCD:EF::1 and
#                                    abcd:ef::1 (every hex letter A-F)
# port-line form                     double-quoted; single-quoted; unquoted; /tcp
#                                    suffix; CRLF file; tab separators; trailing
#                                    comment; no blank after the dash (still read, the
#                                    safe side); no dash at all (not a list item, not
#                                    read); several port lines in one file
# this run's effective bind          absent (no route: 0.0.0.0; TLS route: 127.0.0.1);
#                                    empty (counts as absent); explicit same address;
#                                    explicit different address; explicit :: and
#                                    0.0.0.0; the same address in the other case
#                                    (both directions, via FD00::A/fd00::a and
#                                    ABCD:EF::1/abcd:ef::1 as existing address)
# RELAY_REWRITE                      unset; 1; true; empty; 0; yes; 11
# RELAY_MODE                         greenfield; port-only; existing-traefik; auto;
#                                    empty
# file state                         missing; empty; comment-only; directory;
#                                    unreadable; hand-written without markers
#
# Row format (fields separated by "|"):
#   id | marker | ports | form | domain | email | ca | bind | rewrite | mode | expect | texts
# "-" is an empty or absent value (domain, email, bind, rewrite, ports), EMPTY
# an empty-string value that is set. "ports" is bare, an address ("A@80" for
# another published port), "A+B" for
# several lines, or @missing @empty @comments @dir @unreadable @handwritten.
# "texts" are " ;; "-free items separated by ";;": "+x" must appear in the
# output, "-x" must not. A refusal row also asserts the file is byte-identical
# and that GUARD_OK is not printed; an "ok" row asserts GUARD_OK.

_port_line() {
  local addr="$1" form="$2" spec port=8222
  # "addr@port" publishes another port than the default 8222.
  if [ "${addr#*@}" != "$addr" ]; then port="${addr#*@}"; addr="${addr%@*}"; fi
  if [ "$addr" = "bare" ]; then spec="${port}:${port}"; else spec="${addr}:${port}:${port}"; fi
  case "$form" in
    sq)  printf "      - '%s'\n" "$spec" ;;
    uq)  printf '      - %s\n' "$spec" ;;
    tcp) printf '      - "%s/tcp"\n' "$spec" ;;
    tab) printf '\t-\t"%s"\n' "$spec" ;;
    cmt) printf '      - "%s"  # published port\n' "$spec" ;;
    nosp)   printf '      -"%s"\n' "$spec" ;;
    nodash) printf '      "%s"\n' "$spec" ;;
    *)   printf '      - "%s"\n' "$spec" ;;
  esac
}

_marker_line() {
  case "$1" in
    tls)        printf '      - traefik.http.routers.relay.tls=true\n' ;;
    cert)       printf '      - traefik.http.routers.relay.tls.certresolver=letsencrypt\n' ;;
    quotedcert) printf '      - "traefik.http.routers.relay.tls.certresolver=myresolver"\n' ;;
    tlsfalse)   printf '      - traefik.http.routers.relay.tls=false\n' ;;
    relay2)     printf '      - traefik.http.routers.relay2.tls=true\n' ;;
    other)      printf '      - traefik.http.routers.other.tls.certresolver=x\n' ;;
    commented)  printf '      # - traefik.http.routers.relay.tls=true\n' ;;
    tabcomment) printf '\t# - traefik.http.routers.relay.tls=true\n' ;;
  esac
}

# _build_fixture <marker> <ports> <form>: writes ${COMPOSE} for one row.
_build_fixture() {
  local marker="$1" ports="$2" form="$3" a rest
  case "$ports" in
    @missing)     return 0 ;;
    @empty)       : > "$COMPOSE"; return 0 ;;
    @comments)    printf '# nothing\n   # here\n' > "$COMPOSE"; return 0 ;;
    @dir)         mkdir "$COMPOSE"; return 0 ;;
    @handwritten) printf 'services:\n  relay:\n    image: x\n' > "$COMPOSE"; return 0 ;;
    @unreadable)  printf 'services:\n  relay:\n    ports:\n      - "127.0.0.1:8222:8222"\n' > "$COMPOSE"
                  chmod 000 "$COMPOSE"; return 0 ;;
  esac
  {
    printf 'services:\n  relay:\n    image: x\n'
    if [ "$ports" != "-" ]; then
      printf '    ports:\n'
      rest="$ports"
      while [ -n "$rest" ]; do
        a="${rest%%+*}"
        if [ "$a" = "$rest" ]; then rest=""; else rest="${rest#*+}"; fi
        _port_line "$a" "$form"
      done
    fi
    printf '    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n      - /home/deploy/apps:/apps\n'
    printf '    labels:\n      - traefik.enable=true\n'
    _marker_line "$marker"
  } > "$COMPOSE"
  if [ "$form" = "crlf" ]; then
    awk '{printf "%s\r\n", $0}' "$COMPOSE" > "${COMPOSE}.crlf"
    mv "${COMPOSE}.crlf" "$COMPOSE"
  fi
}

# _check_texts <texts>: "+x" must be in $output, "-x" must not.
_check_texts() {
  local rest="$1" item mark text
  while [ -n "$rest" ]; do
    item="${rest%%;;*}"
    if [ "$item" = "$rest" ]; then rest=""; else rest="${rest#*;;}"; fi
    mark="${item:0:1}"
    text="${item:1}"
    if [ "$mark" = "+" ]; then
      if [[ "$output" != *"$text"* ]]; then echo "missing in output: $text"; echo "$output"; return 1; fi
    else
      if [[ "$output" == *"$text"* ]]; then echo "unexpected in output: $text"; echo "$output"; return 1; fi
    fi
  done
}

_row_run() {
  local row="${GUARD_ROWS[$1]}" id marker ports form dom eml ca bind rewrite mode expect texts
  local envs=()
  IFS='|' read -r id marker ports form dom eml ca bind rewrite mode expect texts <<<"$row"
  if [ "$dom" = "-" ]; then dom=""; fi
  if [ "$eml" = "-" ]; then eml=""; fi
  if [ "$bind" = "EMPTY" ]; then envs+=("RELAY_BIND="); elif [ "$bind" != "-" ]; then envs+=("RELAY_BIND=${bind}"); fi
  if [ "$rewrite" = "EMPTY" ]; then envs+=("RELAY_REWRITE="); elif [ "$rewrite" != "-" ]; then envs+=("RELAY_REWRITE=${rewrite}"); fi
  if [ "$mode" = "EMPTY" ]; then envs+=("MODE_FOR="); else envs+=("MODE_FOR=${mode}"); fi
  _build_fixture "$marker" "$ports" "$form"
  if [ "$ports" = "@unreadable" ] && [ -r "$COMPOSE" ]; then
    chmod 600 "$COMPOSE"
    skip "file stays readable (running as root)"
  fi
  if [ -f "$COMPOSE" ] && [ -r "$COMPOSE" ]; then cp "$COMPOSE" "${RELAY_TEST_DIR}/before"; fi
  _guard_split "$dom" "$eml" "$ca" "${envs[@]}" GUARD_ONLY=1
  if [ "$ports" = "@unreadable" ]; then chmod 600 "$COMPOSE"; fi
  local out_stdout="$output"
  if [ "$expect" = "ok" ]; then
    [ "$status" -eq 0 ] || { echo "row ${id}: expected a pass, got status ${status}"; echo "$stderr"; return 1; }
    [ "$out_stdout" = "GUARD_OK" ] || { echo "row ${id}: stdout is not exactly GUARD_OK: ${out_stdout}"; return 1; }
  else
    [ "$status" -ne 0 ] || { echo "row ${id}: expected a refusal, got a pass"; echo "$out_stdout"; return 1; }
    [ -z "$out_stdout" ] || { echo "row ${id}: stdout not empty on a refusal: ${out_stdout}"; return 1; }
    cmp "$COMPOSE" "${RELAY_TEST_DIR}/before" || { echo "row ${id}: file changed on a refusal"; return 1; }
  fi
  # Texts are checked against both streams (warnings and refusals are on stderr).
  output="${out_stdout}"$'\n'"${stderr}"
  _check_texts "$texts"
}

GUARD_ROWS=()
while IFS= read -r _row; do
  [ -n "$_row" ] || continue
  GUARD_ROWS+=("$_row")
  _idx=$(( ${#GUARD_ROWS[@]} - 1 ))
  eval "_guard_row_${_idx}() { _row_run ${_idx}; }"
  bats_test_function --description "guard table: ${_row%%|*}" -- "_guard_row_${_idx}"
done <<'GUARD_TABLE'
T01 no marker, no route|none|bare|dq|-|-|letsencrypt|-|-|greenfield|ok|
T02 tls=true, no route|tls|bare|dq|-|-|letsencrypt|-|-|greenfield|refuse|+the TLS route for the relay;;-the existing bind;;+the RELAY_DOMAIN and TRAEFIK_EMAIL (or TRAEFIK_CA=self-signed) values of the first install;;+or with the RELAY_MODE of the first install if it was not greenfield;;+RELAY_REWRITE=1
T03 certresolver, no route|cert|bare|dq|-|-|letsencrypt|-|-|greenfield|refuse|+the TLS route for the relay;;-the existing bind;;+the RELAY_DOMAIN and TRAEFIK_EMAIL (or TRAEFIK_CA=self-signed) values of the first install;;+or with the RELAY_MODE of the first install if it was not greenfield;;+RELAY_REWRITE=1
T04 quoted certresolver label, no route|quotedcert|bare|dq|-|-|letsencrypt|-|-|greenfield|refuse|+the TLS route for the relay;;-the existing bind;;+the RELAY_DOMAIN and TRAEFIK_EMAIL (or TRAEFIK_CA=self-signed) values of the first install;;+or with the RELAY_MODE of the first install if it was not greenfield;;+RELAY_REWRITE=1
T05 tls=true, domain+email|tls|bare|dq|relay.example.com|admin@example.com|letsencrypt|-|-|greenfield|ok|
T06 certresolver, domain+email|cert|bare|dq|relay.example.com|admin@example.com|letsencrypt|-|-|greenfield|ok|
T07 tls=true, domain+self-signed|tls|bare|dq|relay.example.com|-|self-signed|-|-|greenfield|ok|
T08 certresolver, domain+self-signed|cert|bare|dq|relay.example.com|-|self-signed|-|-|greenfield|ok|
T09 tls=true, domain without email|tls|bare|dq|relay.example.com|-|letsencrypt|-|-|greenfield|refuse|+the TLS route for the relay;;-the existing bind;;+the RELAY_DOMAIN and TRAEFIK_EMAIL (or TRAEFIK_CA=self-signed) values of the first install;;+or with the RELAY_MODE of the first install if it was not greenfield;;+RELAY_REWRITE=1
T10 tls=true, domain+staging without email|tls|bare|dq|relay.example.com|-|staging|-|-|greenfield|refuse|+the TLS route for the relay;;-the existing bind;;+the RELAY_DOMAIN and TRAEFIK_EMAIL (or TRAEFIK_CA=self-signed) values of the first install;;+or with the RELAY_MODE of the first install if it was not greenfield;;+RELAY_REWRITE=1
T11 tls=true, domain+pebble without email|tls|bare|dq|relay.example.com|-|pebble|-|-|greenfield|refuse|+the TLS route for the relay;;-the existing bind;;+the RELAY_DOMAIN and TRAEFIK_EMAIL (or TRAEFIK_CA=self-signed) values of the first install;;+or with the RELAY_MODE of the first install if it was not greenfield;;+RELAY_REWRITE=1
T12 tls=true, email without domain|tls|bare|dq|-|admin@example.com|letsencrypt|-|-|greenfield|refuse|+the TLS route for the relay;;-the existing bind;;+the RELAY_DOMAIN and TRAEFIK_EMAIL (or TRAEFIK_CA=self-signed) values of the first install;;+or with the RELAY_MODE of the first install if it was not greenfield;;+RELAY_REWRITE=1
T13 tls=true, self-signed without domain|tls|bare|dq|-|-|self-signed|-|-|greenfield|refuse|+the TLS route for the relay;;-the existing bind;;+the RELAY_DOMAIN and TRAEFIK_EMAIL (or TRAEFIK_CA=self-signed) values of the first install;;+or with the RELAY_MODE of the first install if it was not greenfield;;+RELAY_REWRITE=1
T14 tls=true, domain+email+staging|tls|bare|dq|relay.example.com|admin@example.com|staging|-|-|greenfield|ok|
T15 another router name relay2|relay2|bare|dq|-|-|letsencrypt|-|-|greenfield|ok|
T16 other router certresolver|other|bare|dq|-|-|letsencrypt|-|-|greenfield|ok|
T17 tls=false|tlsfalse|bare|dq|-|-|letsencrypt|-|-|greenfield|ok|
T18 commented-out label (space indent)|commented|bare|dq|-|-|letsencrypt|-|-|greenfield|ok|
T19 commented-out label (tab indent)|tabcomment|bare|dq|-|-|letsencrypt|-|-|greenfield|ok|
T20 tls=true, no route, with RELAY_BIND=0.0.0.0|tls|bare|dq|-|-|letsencrypt|0.0.0.0|-|greenfield|refuse|+the TLS route for the relay;;-the existing bind;;+the RELAY_DOMAIN and TRAEFIK_EMAIL (or TRAEFIK_CA=self-signed) values of the first install;;+or with the RELAY_MODE of the first install if it was not greenfield;;+RELAY_REWRITE=1
B 127.0.0.1 no route, bind absent (effective 0.0.0.0)|none|127.0.0.1|dq|-|-|letsencrypt|-|-|greenfield|refuse|+the existing bind 127.0.0.1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=127.0.0.1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B 127.0.0.1 no route, bind empty counts as absent|none|127.0.0.1|dq|-|-|letsencrypt|EMPTY|-|greenfield|refuse|+the existing bind 127.0.0.1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=127.0.0.1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B 127.0.0.1 no route, explicit same bind|none|127.0.0.1|dq|-|-|letsencrypt|127.0.0.1|-|greenfield|ok|
B 127.0.0.1 no route, explicit different bind 10.9.9.9|none|127.0.0.1|dq|-|-|letsencrypt|10.9.9.9|-|greenfield|refuse|+the existing bind 127.0.0.1 of the plain-HTTP port;;+publish it on 10.9.9.9;;+Re-run with RELAY_BIND=127.0.0.1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B 127.0.0.1 no route, explicit bind ::|none|127.0.0.1|dq|-|-|letsencrypt|::|-|greenfield|refuse|+the existing bind 127.0.0.1 of the plain-HTTP port;;+publish it on ::;;+Re-run with RELAY_BIND=127.0.0.1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B 127.0.0.1 no route, explicit bind 0.0.0.0|none|127.0.0.1|dq|-|-|letsencrypt|0.0.0.0|-|greenfield|refuse|+the existing bind 127.0.0.1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=127.0.0.1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B 127.0.0.1 TLS route, bind absent (effective 127.0.0.1)|none|127.0.0.1|dq|relay.example.com|admin@example.com|letsencrypt|-|-|greenfield|ok|
B 127.0.0.1 TLS route, explicit same bind|none|127.0.0.1|dq|relay.example.com|admin@example.com|letsencrypt|127.0.0.1|-|greenfield|ok|
B 127.0.0.1 TLS route, explicit different bind 10.9.9.9|none|127.0.0.1|dq|relay.example.com|admin@example.com|letsencrypt|10.9.9.9|-|greenfield|refuse|+the existing bind 127.0.0.1 of the plain-HTTP port;;+publish it on 10.9.9.9;;+Re-run with RELAY_BIND=127.0.0.1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B 10.0.0.5 no route, bind absent (effective 0.0.0.0)|none|10.0.0.5|dq|-|-|letsencrypt|-|-|greenfield|refuse|+the existing bind 10.0.0.5 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=10.0.0.5, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B 10.0.0.5 no route, bind empty counts as absent|none|10.0.0.5|dq|-|-|letsencrypt|EMPTY|-|greenfield|refuse|+the existing bind 10.0.0.5 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=10.0.0.5, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B 10.0.0.5 no route, explicit same bind|none|10.0.0.5|dq|-|-|letsencrypt|10.0.0.5|-|greenfield|ok|
B 10.0.0.5 no route, explicit different bind 10.9.9.9|none|10.0.0.5|dq|-|-|letsencrypt|10.9.9.9|-|greenfield|refuse|+the existing bind 10.0.0.5 of the plain-HTTP port;;+publish it on 10.9.9.9;;+Re-run with RELAY_BIND=10.0.0.5, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B 10.0.0.5 no route, explicit bind ::|none|10.0.0.5|dq|-|-|letsencrypt|::|-|greenfield|refuse|+the existing bind 10.0.0.5 of the plain-HTTP port;;+publish it on ::;;+Re-run with RELAY_BIND=10.0.0.5, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B 10.0.0.5 no route, explicit bind 0.0.0.0|none|10.0.0.5|dq|-|-|letsencrypt|0.0.0.0|-|greenfield|refuse|+the existing bind 10.0.0.5 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=10.0.0.5, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B 10.0.0.5 TLS route, bind absent (effective 127.0.0.1)|none|10.0.0.5|dq|relay.example.com|admin@example.com|letsencrypt|-|-|greenfield|refuse|+the existing bind 10.0.0.5 of the plain-HTTP port;;+publish it on 127.0.0.1;;+Re-run with RELAY_BIND=10.0.0.5, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B 10.0.0.5 TLS route, explicit same bind|none|10.0.0.5|dq|relay.example.com|admin@example.com|letsencrypt|10.0.0.5|-|greenfield|ok|
B 10.0.0.5 TLS route, explicit different bind 10.9.9.9|none|10.0.0.5|dq|relay.example.com|admin@example.com|letsencrypt|10.9.9.9|-|greenfield|refuse|+the existing bind 10.0.0.5 of the plain-HTTP port;;+publish it on 10.9.9.9;;+Re-run with RELAY_BIND=10.0.0.5, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B 100.64.1.2 no route, bind absent (effective 0.0.0.0)|none|100.64.1.2|dq|-|-|letsencrypt|-|-|greenfield|refuse|+the existing bind 100.64.1.2 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=100.64.1.2, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B 100.64.1.2 no route, bind empty counts as absent|none|100.64.1.2|dq|-|-|letsencrypt|EMPTY|-|greenfield|refuse|+the existing bind 100.64.1.2 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=100.64.1.2, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B 100.64.1.2 no route, explicit same bind|none|100.64.1.2|dq|-|-|letsencrypt|100.64.1.2|-|greenfield|ok|
B 100.64.1.2 no route, explicit different bind 10.9.9.9|none|100.64.1.2|dq|-|-|letsencrypt|10.9.9.9|-|greenfield|refuse|+the existing bind 100.64.1.2 of the plain-HTTP port;;+publish it on 10.9.9.9;;+Re-run with RELAY_BIND=100.64.1.2, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B 100.64.1.2 no route, explicit bind ::|none|100.64.1.2|dq|-|-|letsencrypt|::|-|greenfield|refuse|+the existing bind 100.64.1.2 of the plain-HTTP port;;+publish it on ::;;+Re-run with RELAY_BIND=100.64.1.2, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B 100.64.1.2 no route, explicit bind 0.0.0.0|none|100.64.1.2|dq|-|-|letsencrypt|0.0.0.0|-|greenfield|refuse|+the existing bind 100.64.1.2 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=100.64.1.2, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B 100.64.1.2 TLS route, bind absent (effective 127.0.0.1)|none|100.64.1.2|dq|relay.example.com|admin@example.com|letsencrypt|-|-|greenfield|refuse|+the existing bind 100.64.1.2 of the plain-HTTP port;;+publish it on 127.0.0.1;;+Re-run with RELAY_BIND=100.64.1.2, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B 100.64.1.2 TLS route, explicit same bind|none|100.64.1.2|dq|relay.example.com|admin@example.com|letsencrypt|100.64.1.2|-|greenfield|ok|
B 100.64.1.2 TLS route, explicit different bind 10.9.9.9|none|100.64.1.2|dq|relay.example.com|admin@example.com|letsencrypt|10.9.9.9|-|greenfield|refuse|+the existing bind 100.64.1.2 of the plain-HTTP port;;+publish it on 10.9.9.9;;+Re-run with RELAY_BIND=100.64.1.2, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B ::1 no route, bind absent (effective 0.0.0.0)|none|::1|dq|-|-|letsencrypt|-|-|greenfield|refuse|+the existing bind ::1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B ::1 no route, bind empty counts as absent|none|::1|dq|-|-|letsencrypt|EMPTY|-|greenfield|refuse|+the existing bind ::1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B ::1 no route, explicit same bind|none|::1|dq|-|-|letsencrypt|::1|-|greenfield|ok|
B ::1 no route, explicit different bind 10.9.9.9|none|::1|dq|-|-|letsencrypt|10.9.9.9|-|greenfield|refuse|+the existing bind ::1 of the plain-HTTP port;;+publish it on 10.9.9.9;;+Re-run with RELAY_BIND=::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B ::1 no route, explicit bind ::|none|::1|dq|-|-|letsencrypt|::|-|greenfield|refuse|+the existing bind ::1 of the plain-HTTP port;;+publish it on ::;;+Re-run with RELAY_BIND=::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B ::1 no route, explicit bind 0.0.0.0|none|::1|dq|-|-|letsencrypt|0.0.0.0|-|greenfield|refuse|+the existing bind ::1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B ::1 TLS route, bind absent (effective 127.0.0.1)|none|::1|dq|relay.example.com|admin@example.com|letsencrypt|-|-|greenfield|refuse|+the existing bind ::1 of the plain-HTTP port;;+publish it on 127.0.0.1;;+Re-run with RELAY_BIND=::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B ::1 TLS route, explicit same bind|none|::1|dq|relay.example.com|admin@example.com|letsencrypt|::1|-|greenfield|ok|
B ::1 TLS route, explicit different bind 10.9.9.9|none|::1|dq|relay.example.com|admin@example.com|letsencrypt|10.9.9.9|-|greenfield|refuse|+the existing bind ::1 of the plain-HTTP port;;+publish it on 10.9.9.9;;+Re-run with RELAY_BIND=::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B [::1] no route, bind absent (effective 0.0.0.0)|none|[::1]|dq|-|-|letsencrypt|-|-|greenfield|refuse|+the existing bind ::1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B [::1] no route, bind empty counts as absent|none|[::1]|dq|-|-|letsencrypt|EMPTY|-|greenfield|refuse|+the existing bind ::1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B [::1] no route, explicit same bind|none|[::1]|dq|-|-|letsencrypt|::1|-|greenfield|ok|
B [::1] no route, explicit different bind 10.9.9.9|none|[::1]|dq|-|-|letsencrypt|10.9.9.9|-|greenfield|refuse|+the existing bind ::1 of the plain-HTTP port;;+publish it on 10.9.9.9;;+Re-run with RELAY_BIND=::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B [::1] no route, explicit bind ::|none|[::1]|dq|-|-|letsencrypt|::|-|greenfield|refuse|+the existing bind ::1 of the plain-HTTP port;;+publish it on ::;;+Re-run with RELAY_BIND=::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B [::1] no route, explicit bind 0.0.0.0|none|[::1]|dq|-|-|letsencrypt|0.0.0.0|-|greenfield|refuse|+the existing bind ::1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B [::1] TLS route, bind absent (effective 127.0.0.1)|none|[::1]|dq|relay.example.com|admin@example.com|letsencrypt|-|-|greenfield|refuse|+the existing bind ::1 of the plain-HTTP port;;+publish it on 127.0.0.1;;+Re-run with RELAY_BIND=::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B [::1] TLS route, explicit same bind|none|[::1]|dq|relay.example.com|admin@example.com|letsencrypt|::1|-|greenfield|ok|
B [::1] TLS route, explicit different bind 10.9.9.9|none|[::1]|dq|relay.example.com|admin@example.com|letsencrypt|10.9.9.9|-|greenfield|refuse|+the existing bind ::1 of the plain-HTTP port;;+publish it on 10.9.9.9;;+Re-run with RELAY_BIND=::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B FD00::A no route, bind absent (effective 0.0.0.0)|none|FD00::A|dq|-|-|letsencrypt|-|-|greenfield|refuse|+the existing bind FD00::A of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=FD00::A, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B FD00::A no route, bind empty counts as absent|none|FD00::A|dq|-|-|letsencrypt|EMPTY|-|greenfield|refuse|+the existing bind FD00::A of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=FD00::A, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B FD00::A no route, explicit same bind|none|FD00::A|dq|-|-|letsencrypt|FD00::A|-|greenfield|ok|
B FD00::A no route, explicit different bind 10.9.9.9|none|FD00::A|dq|-|-|letsencrypt|10.9.9.9|-|greenfield|refuse|+the existing bind FD00::A of the plain-HTTP port;;+publish it on 10.9.9.9;;+Re-run with RELAY_BIND=FD00::A, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B FD00::A no route, explicit bind ::|none|FD00::A|dq|-|-|letsencrypt|::|-|greenfield|refuse|+the existing bind FD00::A of the plain-HTTP port;;+publish it on ::;;+Re-run with RELAY_BIND=FD00::A, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B FD00::A no route, explicit bind 0.0.0.0|none|FD00::A|dq|-|-|letsencrypt|0.0.0.0|-|greenfield|refuse|+the existing bind FD00::A of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=FD00::A, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B FD00::A no route, same address other case|none|FD00::A|dq|-|-|letsencrypt|fd00::a|-|greenfield|ok|
B FD00::A TLS route, bind absent (effective 127.0.0.1)|none|FD00::A|dq|relay.example.com|admin@example.com|letsencrypt|-|-|greenfield|refuse|+the existing bind FD00::A of the plain-HTTP port;;+publish it on 127.0.0.1;;+Re-run with RELAY_BIND=FD00::A, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B FD00::A TLS route, explicit same bind|none|FD00::A|dq|relay.example.com|admin@example.com|letsencrypt|FD00::A|-|greenfield|ok|
B FD00::A TLS route, explicit different bind 10.9.9.9|none|FD00::A|dq|relay.example.com|admin@example.com|letsencrypt|10.9.9.9|-|greenfield|refuse|+the existing bind FD00::A of the plain-HTTP port;;+publish it on 10.9.9.9;;+Re-run with RELAY_BIND=FD00::A, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B fd00::a no route, bind absent (effective 0.0.0.0)|none|fd00::a|dq|-|-|letsencrypt|-|-|greenfield|refuse|+the existing bind fd00::a of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=fd00::a, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B fd00::a no route, bind empty counts as absent|none|fd00::a|dq|-|-|letsencrypt|EMPTY|-|greenfield|refuse|+the existing bind fd00::a of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=fd00::a, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B fd00::a no route, explicit same bind|none|fd00::a|dq|-|-|letsencrypt|fd00::a|-|greenfield|ok|
B fd00::a no route, explicit different bind 10.9.9.9|none|fd00::a|dq|-|-|letsencrypt|10.9.9.9|-|greenfield|refuse|+the existing bind fd00::a of the plain-HTTP port;;+publish it on 10.9.9.9;;+Re-run with RELAY_BIND=fd00::a, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B fd00::a no route, explicit bind ::|none|fd00::a|dq|-|-|letsencrypt|::|-|greenfield|refuse|+the existing bind fd00::a of the plain-HTTP port;;+publish it on ::;;+Re-run with RELAY_BIND=fd00::a, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B fd00::a no route, explicit bind 0.0.0.0|none|fd00::a|dq|-|-|letsencrypt|0.0.0.0|-|greenfield|refuse|+the existing bind fd00::a of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=fd00::a, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B fd00::a no route, same address other case|none|fd00::a|dq|-|-|letsencrypt|FD00::A|-|greenfield|ok|
B fd00::a TLS route, bind absent (effective 127.0.0.1)|none|fd00::a|dq|relay.example.com|admin@example.com|letsencrypt|-|-|greenfield|refuse|+the existing bind fd00::a of the plain-HTTP port;;+publish it on 127.0.0.1;;+Re-run with RELAY_BIND=fd00::a, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B fd00::a TLS route, explicit same bind|none|fd00::a|dq|relay.example.com|admin@example.com|letsencrypt|fd00::a|-|greenfield|ok|
B fd00::a TLS route, explicit different bind 10.9.9.9|none|fd00::a|dq|relay.example.com|admin@example.com|letsencrypt|10.9.9.9|-|greenfield|refuse|+the existing bind fd00::a of the plain-HTTP port;;+publish it on 10.9.9.9;;+Re-run with RELAY_BIND=fd00::a, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B ABCD:EF::1 no route, bind absent (effective 0.0.0.0)|none|ABCD:EF::1|dq|-|-|letsencrypt|-|-|greenfield|refuse|+the existing bind ABCD:EF::1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=ABCD:EF::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B ABCD:EF::1 no route, bind empty counts as absent|none|ABCD:EF::1|dq|-|-|letsencrypt|EMPTY|-|greenfield|refuse|+the existing bind ABCD:EF::1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=ABCD:EF::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B ABCD:EF::1 no route, explicit same bind|none|ABCD:EF::1|dq|-|-|letsencrypt|ABCD:EF::1|-|greenfield|ok|
B ABCD:EF::1 no route, explicit different bind 10.9.9.9|none|ABCD:EF::1|dq|-|-|letsencrypt|10.9.9.9|-|greenfield|refuse|+the existing bind ABCD:EF::1 of the plain-HTTP port;;+publish it on 10.9.9.9;;+Re-run with RELAY_BIND=ABCD:EF::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B ABCD:EF::1 no route, explicit bind ::|none|ABCD:EF::1|dq|-|-|letsencrypt|::|-|greenfield|refuse|+the existing bind ABCD:EF::1 of the plain-HTTP port;;+publish it on ::;;+Re-run with RELAY_BIND=ABCD:EF::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B ABCD:EF::1 no route, explicit bind 0.0.0.0|none|ABCD:EF::1|dq|-|-|letsencrypt|0.0.0.0|-|greenfield|refuse|+the existing bind ABCD:EF::1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=ABCD:EF::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B ABCD:EF::1 no route, same address other case|none|ABCD:EF::1|dq|-|-|letsencrypt|abcd:ef::1|-|greenfield|ok|
B ABCD:EF::1 TLS route, bind absent (effective 127.0.0.1)|none|ABCD:EF::1|dq|relay.example.com|admin@example.com|letsencrypt|-|-|greenfield|refuse|+the existing bind ABCD:EF::1 of the plain-HTTP port;;+publish it on 127.0.0.1;;+Re-run with RELAY_BIND=ABCD:EF::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B ABCD:EF::1 TLS route, explicit same bind|none|ABCD:EF::1|dq|relay.example.com|admin@example.com|letsencrypt|ABCD:EF::1|-|greenfield|ok|
B ABCD:EF::1 TLS route, explicit different bind 10.9.9.9|none|ABCD:EF::1|dq|relay.example.com|admin@example.com|letsencrypt|10.9.9.9|-|greenfield|refuse|+the existing bind ABCD:EF::1 of the plain-HTTP port;;+publish it on 10.9.9.9;;+Re-run with RELAY_BIND=ABCD:EF::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B abcd:ef::1 no route, bind absent (effective 0.0.0.0)|none|abcd:ef::1|dq|-|-|letsencrypt|-|-|greenfield|refuse|+the existing bind abcd:ef::1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=abcd:ef::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B abcd:ef::1 no route, bind empty counts as absent|none|abcd:ef::1|dq|-|-|letsencrypt|EMPTY|-|greenfield|refuse|+the existing bind abcd:ef::1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=abcd:ef::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B abcd:ef::1 no route, explicit same bind|none|abcd:ef::1|dq|-|-|letsencrypt|abcd:ef::1|-|greenfield|ok|
B abcd:ef::1 no route, explicit different bind 10.9.9.9|none|abcd:ef::1|dq|-|-|letsencrypt|10.9.9.9|-|greenfield|refuse|+the existing bind abcd:ef::1 of the plain-HTTP port;;+publish it on 10.9.9.9;;+Re-run with RELAY_BIND=abcd:ef::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B abcd:ef::1 no route, explicit bind ::|none|abcd:ef::1|dq|-|-|letsencrypt|::|-|greenfield|refuse|+the existing bind abcd:ef::1 of the plain-HTTP port;;+publish it on ::;;+Re-run with RELAY_BIND=abcd:ef::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B abcd:ef::1 no route, explicit bind 0.0.0.0|none|abcd:ef::1|dq|-|-|letsencrypt|0.0.0.0|-|greenfield|refuse|+the existing bind abcd:ef::1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=abcd:ef::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B abcd:ef::1 no route, same address other case|none|abcd:ef::1|dq|-|-|letsencrypt|ABCD:EF::1|-|greenfield|ok|
B abcd:ef::1 TLS route, bind absent (effective 127.0.0.1)|none|abcd:ef::1|dq|relay.example.com|admin@example.com|letsencrypt|-|-|greenfield|refuse|+the existing bind abcd:ef::1 of the plain-HTTP port;;+publish it on 127.0.0.1;;+Re-run with RELAY_BIND=abcd:ef::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B abcd:ef::1 TLS route, explicit same bind|none|abcd:ef::1|dq|relay.example.com|admin@example.com|letsencrypt|abcd:ef::1|-|greenfield|ok|
B abcd:ef::1 TLS route, explicit different bind 10.9.9.9|none|abcd:ef::1|dq|relay.example.com|admin@example.com|letsencrypt|10.9.9.9|-|greenfield|refuse|+the existing bind abcd:ef::1 of the plain-HTTP port;;+publish it on 10.9.9.9;;+Re-run with RELAY_BIND=abcd:ef::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
B 0.0.0.0 no route, bind absent (effective 0.0.0.0)|none|0.0.0.0|dq|-|-|letsencrypt|-|-|greenfield|ok|
B 0.0.0.0 no route, bind empty counts as absent|none|0.0.0.0|dq|-|-|letsencrypt|EMPTY|-|greenfield|ok|
B 0.0.0.0 no route, explicit same bind|none|0.0.0.0|dq|-|-|letsencrypt|0.0.0.0|-|greenfield|ok|
B 0.0.0.0 no route, explicit different bind 10.9.9.9|none|0.0.0.0|dq|-|-|letsencrypt|10.9.9.9|-|greenfield|ok|
B 0.0.0.0 no route, explicit bind ::|none|0.0.0.0|dq|-|-|letsencrypt|::|-|greenfield|ok|
B 0.0.0.0 no route, explicit bind 0.0.0.0|none|0.0.0.0|dq|-|-|letsencrypt|0.0.0.0|-|greenfield|ok|
B 0.0.0.0 TLS route, bind absent (effective 127.0.0.1)|none|0.0.0.0|dq|relay.example.com|admin@example.com|letsencrypt|-|-|greenfield|ok|
B 0.0.0.0 TLS route, explicit same bind|none|0.0.0.0|dq|relay.example.com|admin@example.com|letsencrypt|0.0.0.0|-|greenfield|ok|
B 0.0.0.0 TLS route, explicit different bind 10.9.9.9|none|0.0.0.0|dq|relay.example.com|admin@example.com|letsencrypt|10.9.9.9|-|greenfield|ok|
B :: no route, bind absent (effective 0.0.0.0)|none|::|dq|-|-|letsencrypt|-|-|greenfield|ok|
B :: no route, bind empty counts as absent|none|::|dq|-|-|letsencrypt|EMPTY|-|greenfield|ok|
B :: no route, explicit same bind|none|::|dq|-|-|letsencrypt|::|-|greenfield|ok|
B :: no route, explicit different bind 10.9.9.9|none|::|dq|-|-|letsencrypt|10.9.9.9|-|greenfield|ok|
B :: no route, explicit bind ::|none|::|dq|-|-|letsencrypt|::|-|greenfield|ok|
B :: no route, explicit bind 0.0.0.0|none|::|dq|-|-|letsencrypt|0.0.0.0|-|greenfield|ok|
B :: TLS route, bind absent (effective 127.0.0.1)|none|::|dq|relay.example.com|admin@example.com|letsencrypt|-|-|greenfield|ok|
B :: TLS route, explicit same bind|none|::|dq|relay.example.com|admin@example.com|letsencrypt|::|-|greenfield|ok|
B :: TLS route, explicit different bind 10.9.9.9|none|::|dq|relay.example.com|admin@example.com|letsencrypt|10.9.9.9|-|greenfield|ok|
B bare no route, bind absent|none|bare|dq|-|-|letsencrypt|-|-|greenfield|ok|
B bare no route, explicit 127.0.0.1|none|bare|dq|-|-|letsencrypt|127.0.0.1|-|greenfield|ok|
B bare TLS route, bind absent|none|bare|dq|relay.example.com|admin@example.com|letsencrypt|-|-|greenfield|ok|
B bare no route, explicit 10.9.9.9|none|bare|dq|-|-|letsencrypt|10.9.9.9|-|greenfield|ok|
B no ports section|none|-|dq|-|-|letsencrypt|-|-|greenfield|ok|
F dq 127.0.0.1, bind absent|none|127.0.0.1|dq|-|-|letsencrypt|-|-|greenfield|refuse|+the existing bind 127.0.0.1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=127.0.0.1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
F dq 127.0.0.1, same bind|none|127.0.0.1|dq|-|-|letsencrypt|127.0.0.1|-|greenfield|ok|
F sq 127.0.0.1, bind absent|none|127.0.0.1|sq|-|-|letsencrypt|-|-|greenfield|refuse|+the existing bind 127.0.0.1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=127.0.0.1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
F sq 127.0.0.1, same bind|none|127.0.0.1|sq|-|-|letsencrypt|127.0.0.1|-|greenfield|ok|
F uq 127.0.0.1, bind absent|none|127.0.0.1|uq|-|-|letsencrypt|-|-|greenfield|refuse|+the existing bind 127.0.0.1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=127.0.0.1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
F uq 127.0.0.1, same bind|none|127.0.0.1|uq|-|-|letsencrypt|127.0.0.1|-|greenfield|ok|
F tcp 127.0.0.1, bind absent|none|127.0.0.1|tcp|-|-|letsencrypt|-|-|greenfield|refuse|+the existing bind 127.0.0.1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=127.0.0.1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
F tcp 127.0.0.1, same bind|none|127.0.0.1|tcp|-|-|letsencrypt|127.0.0.1|-|greenfield|ok|
F crlf 127.0.0.1, bind absent|none|127.0.0.1|crlf|-|-|letsencrypt|-|-|greenfield|refuse|+the existing bind 127.0.0.1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=127.0.0.1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
F crlf 127.0.0.1, same bind|none|127.0.0.1|crlf|-|-|letsencrypt|127.0.0.1|-|greenfield|ok|
F tab 127.0.0.1, bind absent|none|127.0.0.1|tab|-|-|letsencrypt|-|-|greenfield|refuse|+the existing bind 127.0.0.1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=127.0.0.1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
F tab 127.0.0.1, same bind|none|127.0.0.1|tab|-|-|letsencrypt|127.0.0.1|-|greenfield|ok|
F cmt 127.0.0.1, bind absent|none|127.0.0.1|cmt|-|-|letsencrypt|-|-|greenfield|refuse|+the existing bind 127.0.0.1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=127.0.0.1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
F cmt 127.0.0.1, same bind|none|127.0.0.1|cmt|-|-|letsencrypt|127.0.0.1|-|greenfield|ok|
F uq ::1, bind absent|none|::1|uq|-|-|letsencrypt|-|-|greenfield|refuse|+the existing bind ::1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
F uq [::1], same bind ::1|none|[::1]|uq|-|-|letsencrypt|::1|-|greenfield|ok|
F sq ::1, bind absent|none|::1|sq|-|-|letsencrypt|-|-|greenfield|refuse|+the existing bind ::1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
F sq [::1], same bind ::1|none|[::1]|sq|-|-|letsencrypt|::1|-|greenfield|ok|
F tcp ::1, bind absent|none|::1|tcp|-|-|letsencrypt|-|-|greenfield|refuse|+the existing bind ::1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
F tcp [::1], same bind ::1|none|[::1]|tcp|-|-|letsencrypt|::1|-|greenfield|ok|
F crlf ::1, bind absent|none|::1|crlf|-|-|letsencrypt|-|-|greenfield|refuse|+the existing bind ::1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
F crlf [::1], same bind ::1|none|[::1]|crlf|-|-|letsencrypt|::1|-|greenfield|ok|
F tab ::1, bind absent|none|::1|tab|-|-|letsencrypt|-|-|greenfield|refuse|+the existing bind ::1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
F tab [::1], same bind ::1|none|[::1]|tab|-|-|letsencrypt|::1|-|greenfield|ok|
F cmt ::1, bind absent|none|::1|cmt|-|-|letsencrypt|-|-|greenfield|refuse|+the existing bind ::1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=::1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
F cmt [::1], same bind ::1|none|[::1]|cmt|-|-|letsencrypt|::1|-|greenfield|ok|
F sq bare, bind absent|none|bare|sq|-|-|letsencrypt|-|-|greenfield|ok|
F sq 0.0.0.0, bind absent|none|0.0.0.0|sq|-|-|letsencrypt|-|-|greenfield|ok|
F uq bare, bind absent|none|bare|uq|-|-|letsencrypt|-|-|greenfield|ok|
F uq 0.0.0.0, bind absent|none|0.0.0.0|uq|-|-|letsencrypt|-|-|greenfield|ok|
F tcp bare, bind absent|none|bare|tcp|-|-|letsencrypt|-|-|greenfield|ok|
F tcp 0.0.0.0, bind absent|none|0.0.0.0|tcp|-|-|letsencrypt|-|-|greenfield|ok|
F crlf bare, bind absent|none|bare|crlf|-|-|letsencrypt|-|-|greenfield|ok|
F crlf 0.0.0.0, bind absent|none|0.0.0.0|crlf|-|-|letsencrypt|-|-|greenfield|ok|
F tab bare, bind absent|none|bare|tab|-|-|letsencrypt|-|-|greenfield|ok|
F tab 0.0.0.0, bind absent|none|0.0.0.0|tab|-|-|letsencrypt|-|-|greenfield|ok|
F cmt bare, bind absent|none|bare|cmt|-|-|letsencrypt|-|-|greenfield|ok|
F cmt 0.0.0.0, bind absent|none|0.0.0.0|cmt|-|-|letsencrypt|-|-|greenfield|ok|
F nosp 127.0.0.1, bind absent|none|127.0.0.1|nosp|-|-|letsencrypt|-|-|greenfield|refuse|+the existing bind 127.0.0.1 of the plain-HTTP port
F nodash 127.0.0.1, bind absent (not a list item, not read)|none|127.0.0.1|nodash|-|-|letsencrypt|-|-|greenfield|ok
F port 80 127.0.0.1@80, bind absent|none|127.0.0.1@80|dq|-|-|letsencrypt|-|-|greenfield|refuse|+the existing bind 127.0.0.1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=127.0.0.1
F port 80 127.0.0.1@80, same bind|none|127.0.0.1@80|dq|-|-|letsencrypt|127.0.0.1|-|greenfield|ok
F port 18222 127.0.0.1@18222, bind absent|none|127.0.0.1@18222|dq|-|-|letsencrypt|-|-|greenfield|refuse|+the existing bind 127.0.0.1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=127.0.0.1
F port 18222 127.0.0.1@18222, same bind|none|127.0.0.1@18222|dq|-|-|letsencrypt|127.0.0.1|-|greenfield|ok
F port 80 ::1@80, bind absent|none|::1@80|dq|-|-|letsencrypt|-|-|greenfield|refuse|+the existing bind ::1 of the plain-HTTP port
F port 18222 10.0.0.5@18222, TLS route default bind|none|10.0.0.5@18222|dq|relay.example.com|admin@example.com|letsencrypt|-|-|greenfield|refuse|+the existing bind 10.0.0.5;;+publish it on 127.0.0.1
F port 80 0.0.0.0@80, bind absent|none|0.0.0.0@80|dq|-|-|letsencrypt|-|-|greenfield|ok
P 0.0.0.0 then 127.0.0.1|none|0.0.0.0+127.0.0.1|dq|-|-|letsencrypt|-|-|greenfield|refuse|+the existing bind 127.0.0.1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=127.0.0.1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
P 127.0.0.1 then 0.0.0.0|none|127.0.0.1+0.0.0.0|dq|-|-|letsencrypt|-|-|greenfield|refuse|+the existing bind 127.0.0.1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=127.0.0.1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
P 127.0.0.1 then 10.0.0.5, bind 127.0.0.1|none|127.0.0.1+10.0.0.5|dq|-|-|letsencrypt|127.0.0.1|-|greenfield|refuse|+the existing bind 10.0.0.5 of the plain-HTTP port;;+publish it on 127.0.0.1;;+Re-run with RELAY_BIND=10.0.0.5, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
P 10.0.0.5 then 127.0.0.1, bind 127.0.0.1|none|10.0.0.5+127.0.0.1|dq|-|-|letsencrypt|127.0.0.1|-|greenfield|refuse|+the existing bind 10.0.0.5 of the plain-HTTP port;;+publish it on 127.0.0.1;;+Re-run with RELAY_BIND=10.0.0.5, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
P 127.0.0.1 twice, bind 127.0.0.1|none|127.0.0.1+127.0.0.1|dq|-|-|letsencrypt|127.0.0.1|-|greenfield|ok|
P bare then 127.0.0.1|none|bare+127.0.0.1|dq|-|-|letsencrypt|-|-|greenfield|refuse|+the existing bind 127.0.0.1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=127.0.0.1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
P 0.0.0.0 then :: then bare|none|0.0.0.0+::+bare|dq|-|-|letsencrypt|-|-|greenfield|ok|
X tls=true + 127.0.0.1, bare re-run|tls|127.0.0.1|dq|-|-|letsencrypt|-|-|greenfield|refuse|+the TLS route for the relay;;+and the existing bind 127.0.0.1;;+values of the first install and RELAY_BIND=127.0.0.1;;+or with the RELAY_MODE of the first install if it was not greenfield;;+publish it on 0.0.0.0
X certresolver + 127.0.0.1, bare re-run|cert|127.0.0.1|dq|-|-|letsencrypt|-|-|greenfield|refuse|+the TLS route for the relay;;+and the existing bind 127.0.0.1;;+values of the first install and RELAY_BIND=127.0.0.1;;+or with the RELAY_MODE of the first install if it was not greenfield;;+publish it on 0.0.0.0
X tls=true + 127.0.0.1, route kept, default bind|tls|127.0.0.1|dq|relay.example.com|admin@example.com|letsencrypt|-|-|greenfield|ok|
X tls=true + 127.0.0.1, route kept, explicit 0.0.0.0|tls|127.0.0.1|dq|relay.example.com|admin@example.com|letsencrypt|0.0.0.0|-|greenfield|refuse|+the existing bind 127.0.0.1;;-the TLS route
X tls=true + 127.0.0.1, no route, bind 127.0.0.1 (TLS loss only)|tls|127.0.0.1|dq|-|-|letsencrypt|127.0.0.1|-|greenfield|refuse|+the TLS route for the relay;;-the existing bind;;+values of the first install
W both losses, RELAY_REWRITE=-|tls|127.0.0.1|dq|-|-|letsencrypt|-|-|greenfield|refuse|+the TLS route for the relay;;+and the existing bind 127.0.0.1;;+values of the first install and RELAY_BIND=127.0.0.1;;+or with the RELAY_MODE of the first install if it was not greenfield;;+publish it on 0.0.0.0
W TLS loss only, RELAY_REWRITE=-|tls|bare|dq|-|-|letsencrypt|-|-|greenfield|refuse|+the TLS route for the relay;;-the existing bind;;+the RELAY_DOMAIN and TRAEFIK_EMAIL (or TRAEFIK_CA=self-signed) values of the first install;;+or with the RELAY_MODE of the first install if it was not greenfield;;+RELAY_REWRITE=1
W bind loss only, RELAY_REWRITE=-|none|127.0.0.1|dq|-|-|letsencrypt|-|-|greenfield|refuse|+the existing bind 127.0.0.1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=127.0.0.1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
W both losses, RELAY_REWRITE=1|tls|127.0.0.1|dq|-|-|letsencrypt|-|1|greenfield|ok|+RELAY_REWRITE=1: rewriting;;+the TLS route for the relay;;+the existing bind 127.0.0.1
W TLS loss only, RELAY_REWRITE=1|tls|bare|dq|-|-|letsencrypt|-|1|greenfield|ok|+RELAY_REWRITE=1: rewriting;;+the TLS route for the relay;;-the existing bind
W bind loss only, RELAY_REWRITE=1|none|127.0.0.1|dq|-|-|letsencrypt|-|1|greenfield|ok|+RELAY_REWRITE=1: rewriting;;+the existing bind 127.0.0.1;;-the TLS route
W both losses, RELAY_REWRITE=true|tls|127.0.0.1|dq|-|-|letsencrypt|-|true|greenfield|refuse|+the TLS route for the relay;;+and the existing bind 127.0.0.1;;+values of the first install and RELAY_BIND=127.0.0.1;;+or with the RELAY_MODE of the first install if it was not greenfield;;+publish it on 0.0.0.0
W TLS loss only, RELAY_REWRITE=true|tls|bare|dq|-|-|letsencrypt|-|true|greenfield|refuse|+the TLS route for the relay;;-the existing bind;;+the RELAY_DOMAIN and TRAEFIK_EMAIL (or TRAEFIK_CA=self-signed) values of the first install;;+or with the RELAY_MODE of the first install if it was not greenfield;;+RELAY_REWRITE=1
W bind loss only, RELAY_REWRITE=true|none|127.0.0.1|dq|-|-|letsencrypt|-|true|greenfield|refuse|+the existing bind 127.0.0.1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=127.0.0.1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
W both losses, RELAY_REWRITE=EMPTY|tls|127.0.0.1|dq|-|-|letsencrypt|-|EMPTY|greenfield|refuse|+the TLS route for the relay;;+and the existing bind 127.0.0.1;;+values of the first install and RELAY_BIND=127.0.0.1;;+or with the RELAY_MODE of the first install if it was not greenfield;;+publish it on 0.0.0.0
W TLS loss only, RELAY_REWRITE=EMPTY|tls|bare|dq|-|-|letsencrypt|-|EMPTY|greenfield|refuse|+the TLS route for the relay;;-the existing bind;;+the RELAY_DOMAIN and TRAEFIK_EMAIL (or TRAEFIK_CA=self-signed) values of the first install;;+or with the RELAY_MODE of the first install if it was not greenfield;;+RELAY_REWRITE=1
W bind loss only, RELAY_REWRITE=EMPTY|none|127.0.0.1|dq|-|-|letsencrypt|-|EMPTY|greenfield|refuse|+the existing bind 127.0.0.1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=127.0.0.1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
W both losses, RELAY_REWRITE=0|tls|127.0.0.1|dq|-|-|letsencrypt|-|0|greenfield|refuse|+the TLS route for the relay;;+and the existing bind 127.0.0.1;;+values of the first install and RELAY_BIND=127.0.0.1;;+or with the RELAY_MODE of the first install if it was not greenfield;;+publish it on 0.0.0.0
W TLS loss only, RELAY_REWRITE=0|tls|bare|dq|-|-|letsencrypt|-|0|greenfield|refuse|+the TLS route for the relay;;-the existing bind;;+the RELAY_DOMAIN and TRAEFIK_EMAIL (or TRAEFIK_CA=self-signed) values of the first install;;+or with the RELAY_MODE of the first install if it was not greenfield;;+RELAY_REWRITE=1
W bind loss only, RELAY_REWRITE=0|none|127.0.0.1|dq|-|-|letsencrypt|-|0|greenfield|refuse|+the existing bind 127.0.0.1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=127.0.0.1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
W both losses, RELAY_REWRITE=yes|tls|127.0.0.1|dq|-|-|letsencrypt|-|yes|greenfield|refuse|+the TLS route for the relay;;+and the existing bind 127.0.0.1;;+values of the first install and RELAY_BIND=127.0.0.1;;+or with the RELAY_MODE of the first install if it was not greenfield;;+publish it on 0.0.0.0
W TLS loss only, RELAY_REWRITE=yes|tls|bare|dq|-|-|letsencrypt|-|yes|greenfield|refuse|+the TLS route for the relay;;-the existing bind;;+the RELAY_DOMAIN and TRAEFIK_EMAIL (or TRAEFIK_CA=self-signed) values of the first install;;+or with the RELAY_MODE of the first install if it was not greenfield;;+RELAY_REWRITE=1
W bind loss only, RELAY_REWRITE=yes|none|127.0.0.1|dq|-|-|letsencrypt|-|yes|greenfield|refuse|+the existing bind 127.0.0.1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=127.0.0.1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
W both losses, RELAY_REWRITE=11|tls|127.0.0.1|dq|-|-|letsencrypt|-|11|greenfield|refuse|+the TLS route for the relay;;+and the existing bind 127.0.0.1;;+values of the first install and RELAY_BIND=127.0.0.1;;+or with the RELAY_MODE of the first install if it was not greenfield;;+publish it on 0.0.0.0
W TLS loss only, RELAY_REWRITE=11|tls|bare|dq|-|-|letsencrypt|-|11|greenfield|refuse|+the TLS route for the relay;;-the existing bind;;+the RELAY_DOMAIN and TRAEFIK_EMAIL (or TRAEFIK_CA=self-signed) values of the first install;;+or with the RELAY_MODE of the first install if it was not greenfield;;+RELAY_REWRITE=1
W bind loss only, RELAY_REWRITE=11|none|127.0.0.1|dq|-|-|letsencrypt|-|11|greenfield|refuse|+the existing bind 127.0.0.1 of the plain-HTTP port;;+publish it on 0.0.0.0;;+Re-run with RELAY_BIND=127.0.0.1, or with the RELAY_MODE of the first install if it was not greenfield;;-values of the first install;;-the TLS route;;+RELAY_REWRITE=1
W no loss, RELAY_REWRITE=1 prints no warning|none|bare|dq|-|-|letsencrypt|-|1|greenfield|ok|-rewriting
W no loss, RELAY_REWRITE=true|none|bare|dq|-|-|letsencrypt|-|true|greenfield|ok|-rewriting
M mode 'port-only' with both losses|tls|127.0.0.1|dq|-|-|letsencrypt|-|-|port-only|ok|
M mode 'existing-traefik' with both losses|tls|127.0.0.1|dq|-|-|letsencrypt|-|-|existing-traefik|ok|
M mode 'auto' with both losses|tls|127.0.0.1|dq|-|-|letsencrypt|-|-|auto|ok|
M mode '' with both losses|tls|127.0.0.1|dq|-|-|letsencrypt|-|-|EMPTY|ok|
S missing file|none|@missing|dq|-|-|letsencrypt|-|-|greenfield|ok|
S empty file|none|@empty|dq|-|-|letsencrypt|-|-|greenfield|ok|-grep
S comment-only file|none|@comments|dq|-|-|letsencrypt|-|-|greenfield|ok|-grep
S directory at the compose path|none|@dir|dq|-|-|letsencrypt|-|-|greenfield|ok|-Is a directory
S unreadable file|none|@unreadable|dq|-|-|letsencrypt|-|-|greenfield|ok|-Permission denied
S marker-free hand-written file|none|@handwritten|dq|-|-|letsencrypt|-|-|greenfield|ok|
GUARD_TABLE

# ─── UFW hint decision table ────────────────────────────────────────────────
#
# Dimension: mode (greenfield, port-only, existing-traefik, auto, empty) x bind
# (127.0.0.1, 0.0.0.0, 10.0.0.5, ::) x missing ports (one, two). Row format:
#   id | mode | bind | port | missing | texts      (texts as above, on stderr)
# The hint writes only to stderr; stdout stays empty.

_hint_row() {
  local row="${HINT_ROWS[$1]}" id mode bind port missing texts errf
  IFS='|' read -r id mode bind port missing texts <<<"$row"
  if [ "$mode" = "EMPTY" ]; then mode=""; fi
  errf="${RELAY_TEST_DIR}/hint.err"
  run env M="$mode" B="$bind" P="$port" MISS="$missing" ERRF="$errf" bash -c "
    INSTALL_SH_SOURCE_ONLY=1 . '${INSTALL_SH}'
    agent_relay_ufw_hint \"\$M\" \"\$B\" \"\$P\" \"\$MISS\" 2>\"\$ERRF\"
  "
  [ "$status" -eq 0 ] || { echo "row ${id}: status ${status}"; return 1; }
  [ -z "$output" ] || { echo "row ${id}: stdout not empty: $output"; return 1; }
  # Colour codes out; no line may end with a blank (the allow line must not
  # carry a trailing space), and the text must end with an empty spacer line.
  sed $'s/\033\\[[0-9;]*m//g' "$errf" > "${errf}.plain"
  [ "$(tail -c 2 "${errf}.plain" | od -An -c | tr -d ' ')" = '\n\n' ] || { echo "row ${id}: no trailing empty line"; return 1; }
  if grep -qE ' $' "${errf}.plain"; then echo "row ${id}: a line ends with a space"; return 1; fi
  output="$(cat "${errf}.plain")"
  _check_texts "$texts"
}

HC="+UFW is active and does not list these port(s):;;+Docker publishes them through its own iptables rules, which bypass UFW's INPUT rules;;+reachable from the network whether or not UFW allows them, and UFW rules do not restrict them;;+Only if Docker's iptables integration is off (\"iptables\": false in daemon.json), Docker runs rootless, or the proxy uses host networking, UFW gates these ports;;-not allowed;;-Run this to open them:"
PLAIN="+RELAY_BIND=127.0.0.1 (use the HTTPS route or a local reverse proxy as the way in);;+DOCKER-USER iptables chain (they see the container port after NAT"
NOPLAIN="-RELAY_BIND;;-DOCKER-USER;;-The plain-HTTP port"
HINT_ROWS=()
while IFS= read -r _row; do
  [ -n "$_row" ] || continue
  _row="${_row//\$HC/$HC}"
  _row="${_row//\$PLAIN/$PLAIN}"
  _row="${_row//\$NOPLAIN/$NOPLAIN}"
  HINT_ROWS+=("$_row")
  _idx=$(( ${#HINT_ROWS[@]} - 1 ))
  eval "_hint_row_${_idx}() { _hint_row ${_idx}; }"
  bats_test_function --description "hint table: ${_row%%|*}" -- "_hint_row_${_idx}"
done <<'HINT_TABLE'
greenfield 0.0.0.0 one port|greenfield|0.0.0.0|8222|8222/tcp|$HC;;$PLAIN;;+The plain-HTTP port 8222/tcp is published on 0.0.0.0;;+sudo ufw allow 8222/tcp;
greenfield 10.0.0.5 other port|greenfield|10.0.0.5|9000|9000/tcp|$HC;;$PLAIN;;+The plain-HTTP port 9000/tcp is published on 10.0.0.5;;+sudo ufw allow 9000/tcp;
greenfield :: all IPv6|greenfield|::|8222|8222/tcp|$HC;;$PLAIN;;+is published on ::.
greenfield 127.0.0.1 TLS ports|greenfield|127.0.0.1|8222|80/tcp 443/tcp|$HC;;$NOPLAIN;;+sudo ufw allow 80/tcp; sudo ufw allow 443/tcp;
greenfield 0.0.0.0 TLS ports and plain|greenfield|0.0.0.0|8222|80/tcp 443/tcp|$HC;;$PLAIN;;+sudo ufw allow 80/tcp; sudo ufw allow 443/tcp;
port-only 0.0.0.0|port-only|0.0.0.0|8222|8222/tcp|$HC;;$PLAIN;;+The plain-HTTP port 8222/tcp is published on 0.0.0.0
port-only 10.0.0.5|port-only|10.0.0.5|9000|9000/tcp|$HC;;$PLAIN;;+is published on 10.0.0.5
port-only 127.0.0.1|port-only|127.0.0.1|8222|8222/tcp|$HC;;$NOPLAIN
existing-traefik 0.0.0.0|existing-traefik|0.0.0.0|8222|80/tcp 443/tcp|$HC;;$NOPLAIN;;+sudo ufw allow 80/tcp; sudo ufw allow 443/tcp;
existing-traefik 127.0.0.1|existing-traefik|127.0.0.1|8222|80/tcp|$HC;;$NOPLAIN;;+sudo ufw allow 80/tcp;
auto (unresolved) 0.0.0.0|auto|0.0.0.0|8222|8222/tcp|$HC;;$NOPLAIN
empty mode 0.0.0.0|EMPTY|0.0.0.0|8222|8222/tcp|$HC;;$NOPLAIN
HINT_TABLE

# ─── call sites ──────────────────────────────────────────────────────────────

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

@test "install.sh Step 5 runs the relay compose guard once, after the compat check and before the Traefik bootstrap" {
  _pin_below_guard '  agent_relay_relay_compose_guard "$RELAY_DIR"'
  compat="$(grep -nxF '  agent_relay_check_greenfield_compat' "$INSTALL_SH" | head -1 | cut -d: -f1)"
  guard="$(grep -nxF '  agent_relay_relay_compose_guard "$RELAY_DIR"' "$INSTALL_SH" | head -1 | cut -d: -f1)"
  boot="$(grep -nxF '  agent_relay_bootstrap_traefik "/opt/traefik"' "$INSTALL_SH" | head -1 | cut -d: -f1)"
  [ "$compat" -lt "$guard" ]
  [ "$guard" -lt "$boot" ]
}

@test "install.sh UFW block calls agent_relay_ufw_hint once, below the guard" {
  _pin_below_guard '      agent_relay_ufw_hint "$RELAY_MODE" "$(agent_relay_relay_bind)" "$RELAY_PORT" "${missing% }"'
}

@test "install.sh header documents RELAY_REWRITE" {
  run grep -c '^#   RELAY_REWRITE=1 ' "$INSTALL_SH"
  [ "$output" = "1" ]
}
