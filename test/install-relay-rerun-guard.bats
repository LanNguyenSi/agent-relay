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
    RELAY_MODE=\"\${MODE_FOR:-greenfield}\"
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
