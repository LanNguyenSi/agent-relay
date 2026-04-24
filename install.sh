#!/usr/bin/env bash
# agent-relay VPS bootstrap installer — v0.2.0 adaptive modes
# Usage: curl -sSL https://raw.githubusercontent.com/LanNguyenSi/agent-relay/main/install.sh | bash
#
# Modes (RELAY_MODE):
#   auto              Detect what's on :80 and pick greenfield / existing-traefik / port-only
#   greenfield        Create Traefik + traefik-public network, LE for RELAY_DOMAIN (default prior behaviour)
#   existing-traefik  Do NOT touch Traefik; join relay to an existing Traefik via TRAEFIK_NETWORK + TRAEFIK_CERTRESOLVER
#   port-only         No Traefik, no TLS; relay publishes to RELAY_BIND:RELAY_PORT directly
#
# Env-var surface:
#   RELAY_DOMAIN           FQDN for TLS routing (required in greenfield / existing-traefik)
#   TRAEFIK_EMAIL          LE contact address (required in greenfield when RELAY_DOMAIN is set)
#   APPS_DIR               Host dir bind-mounted into the relay container as /apps
#   RELAY_DIR              Where install.sh writes compose + .env (default /opt/agent-relay)
#   RELAY_PORT             Container port (default 8222)
#   RELAY_MODE             auto | greenfield | existing-traefik | port-only  (default auto)
#   TRAEFIK_NETWORK        Docker network to attach to in existing-traefik mode (default traefik-public)
#   TRAEFIK_CERTRESOLVER   ACME resolver name on the existing Traefik (default letsencrypt)
#   RELAY_BIND             Host bind IP for port-only mode (default 127.0.0.1; use 0.0.0.0 to expose)
#   SKIP_TRAEFIK=1         Back-compat alias for RELAY_MODE=port-only

set -euo pipefail

RELAY_DIR="${RELAY_DIR:-/opt/agent-relay}"
APPS_DIR="${APPS_DIR:-/home/deploy/apps}"
RELAY_PORT="${RELAY_PORT:-8222}"
TRAEFIK_EMAIL="${TRAEFIK_EMAIL:-}"
RELAY_DOMAIN="${RELAY_DOMAIN:-}"
RELAY_MODE="${RELAY_MODE:-auto}"
# Track whether user explicitly set TRAEFIK_NETWORK so existing-traefik mode
# can auto-adopt the detected network without overriding an explicit choice.
if [ -n "${TRAEFIK_NETWORK:-}" ]; then
  TRAEFIK_NETWORK_EXPLICIT=1
else
  TRAEFIK_NETWORK_EXPLICIT=0
fi
TRAEFIK_NETWORK="${TRAEFIK_NETWORK:-traefik-public}"
TRAEFIK_CERTRESOLVER="${TRAEFIK_CERTRESOLVER:-letsencrypt}"
RELAY_BIND="${RELAY_BIND:-127.0.0.1}"

# Back-compat: SKIP_TRAEFIK=1 → port-only (only when mode wasn't explicitly set)
if [ "${SKIP_TRAEFIK:-}" = "1" ] && [ "$RELAY_MODE" = "auto" ]; then
  RELAY_MODE="port-only"
fi

# ── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
info() { echo -e "${CYAN}[i]${NC} $1"; }

# ── Pre-checks ─────────────────────────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || err "Run as root: sudo bash install.sh"

if ! grep -qiE 'ubuntu|debian' /etc/os-release 2>/dev/null; then
  warn "This script is tested on Ubuntu 22.04+ and Debian 12+. Proceed with caution."
fi

case "$RELAY_MODE" in
  auto|greenfield|existing-traefik|port-only) ;;
  *) err "Invalid RELAY_MODE='$RELAY_MODE'. Expected: auto | greenfield | existing-traefik | port-only" ;;
esac

# ── Step 1: Docker ─────────────────────────────────────────────────────────
if command -v docker &>/dev/null; then
  log "Docker already installed ($(docker --version | awk '{print $3}'))"
else
  info "Installing Docker..."
  curl -fsSL https://get.docker.com | bash
  systemctl enable --now docker
  log "Docker installed"
fi

if ! docker compose version &>/dev/null; then
  err "Docker Compose plugin not available. Install Docker Compose v2."
fi
log "Docker Compose available"

# ── Step 2: Detect host state (for auto mode + reporting) ──────────────────
# Returns the name of the docker container publishing :80, or empty.
detect_port80_container() {
  docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null \
    | awk -F'\t' '$2 ~ /:80->/ { print $1; exit }'
}

# Returns "traefik" if the given container's image looks like Traefik, else empty.
# Matches `traefik:*`, `*/traefik:*`, and the bare `traefik` tag.
is_traefik_container() {
  local name="$1"
  local image
  image=$(docker inspect --format '{{.Config.Image}}' "$name" 2>/dev/null || true)
  case "$image" in
    traefik|traefik:*|*/traefik|*/traefik:*) return 0 ;;
    *) return 1 ;;
  esac
}

# First non-default network of a container (skips bridge/host/none).
get_container_network() {
  local name="$1"
  docker inspect --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}
{{end}}' "$name" 2>/dev/null \
    | grep -vxE 'bridge|host|none' \
    | head -n1
}

# Best-effort: pull the first certresolver name from the Traefik container's
# command args (`--certificatesresolvers.<name>.acme…`). Falls back to the
# TRAEFIK_CERTRESOLVER env default if nothing matches.
detect_cert_resolver() {
  local name="$1"
  docker inspect --format '{{range .Config.Cmd}}{{.}}
{{end}}' "$name" 2>/dev/null \
    | grep -oE -- '--certificatesresolvers\.[^.]+\.acme' \
    | head -n1 \
    | sed -E 's/^--certificatesresolvers\.([^.]+)\.acme$/\1/'
}

# Who owns :80? Prints one of:
#   free
#   traefik:<container>
#   docker:<container>
#   proc:<processname>
#   unknown
port80_owner() {
  local container proc
  container=$(detect_port80_container)
  if [ -n "$container" ]; then
    if is_traefik_container "$container"; then
      printf 'traefik:%s\n' "$container"
    else
      printf 'docker:%s\n' "$container"
    fi
    return
  fi
  # Not a docker container — check with ss for any other listener.
  if ! command -v ss &>/dev/null; then
    # iproute2 missing (very unusual on Ubuntu/Debian); can't tell.
    if ss -tln 2>/dev/null | awk '{print $4}' | grep -qE ':80$'; then
      echo "unknown"
    else
      echo "free"
    fi
    return
  fi
  local listener
  listener=$(ss -tlnp 2>/dev/null | awk '$4 ~ /:80$/' | head -n1)
  if [ -z "$listener" ]; then
    echo "free"
    return
  fi
  proc=$(echo "$listener" | grep -oP 'users:\(\("\K[^"]+' | head -n1 || true)
  if [ -n "$proc" ]; then
    printf 'proc:%s\n' "$proc"
  else
    echo "unknown"
  fi
}

# ── Step 3: Resolve RELAY_MODE (auto → concrete) ───────────────────────────
OWNER="$(port80_owner)"
OWNER_KIND="${OWNER%%:*}"
OWNER_NAME="${OWNER#*:}"
[ "$OWNER_KIND" = "$OWNER_NAME" ] && OWNER_NAME=""

if [ "$RELAY_MODE" = "auto" ]; then
  case "$OWNER_KIND" in
    free)
      RELAY_MODE="greenfield"
      info "Detection: port 80 free → mode=greenfield"
      ;;
    traefik)
      RELAY_MODE="existing-traefik"
      info "Detection: existing Traefik container '${OWNER_NAME}' on :80 → mode=existing-traefik"
      ;;
    docker|proc|unknown)
      local_owner="${OWNER_NAME:-<unknown>}"
      if [ -n "$RELAY_DOMAIN" ]; then
        echo ""
        err "$(cat <<BANNER
Port 80 is owned by: ${local_owner}

RELAY_MODE=auto refuses to continue because RELAY_DOMAIN='${RELAY_DOMAIN}' is set
and we cannot route it through an unknown reverse proxy without your input.

Options:
  (a) Free the port (stop the process/container on :80) and re-run.
  (b) Run with RELAY_MODE=port-only for no-TLS access on RELAY_BIND:${RELAY_PORT}.
  (c) Run with RELAY_MODE=existing-traefik (plus TRAEFIK_NETWORK / TRAEFIK_CERTRESOLVER
      overrides if needed) if '${local_owner}' is actually your reverse proxy.

No changes have been written yet.
BANNER
)"
      else
        RELAY_MODE="port-only"
        info "Detection: port 80 owned by '${local_owner}' and RELAY_DOMAIN unset → mode=port-only"
      fi
      ;;
  esac
fi

# ── Step 4: Mode-specific validation ───────────────────────────────────────
case "$RELAY_MODE" in
  greenfield)
    if [ -n "$RELAY_DOMAIN" ] && [ -z "$TRAEFIK_EMAIL" ]; then
      warn "RELAY_DOMAIN='${RELAY_DOMAIN}' but TRAEFIK_EMAIL is empty — Let's Encrypt will not issue a certificate."
      warn "Set TRAEFIK_EMAIL=you@example.com and re-run, or leave RELAY_DOMAIN unset for port-only mode."
    fi
    ;;
  existing-traefik)
    [ -n "$RELAY_DOMAIN" ] || err "RELAY_MODE=existing-traefik requires RELAY_DOMAIN (the FQDN the existing Traefik should route to this relay)."
    # If the user left TRAEFIK_NETWORK at default and we detected a Traefik
    # container on :80, adopt its primary network automatically. User-supplied
    # overrides always win.
    if [ "$TRAEFIK_NETWORK_EXPLICIT" = "0" ] \
       && [ "$OWNER_KIND" = "traefik" ] && [ -n "$OWNER_NAME" ]; then
      detected_net=$(get_container_network "$OWNER_NAME" || true)
      if [ -n "$detected_net" ] && [ "$detected_net" != "$TRAEFIK_NETWORK" ]; then
        info "Adopting existing Traefik network '${detected_net}' (override with TRAEFIK_NETWORK=…)."
        TRAEFIK_NETWORK="$detected_net"
      fi
    fi
    if ! docker network inspect "$TRAEFIK_NETWORK" &>/dev/null; then
      err "TRAEFIK_NETWORK='${TRAEFIK_NETWORK}' does not exist. Override with TRAEFIK_NETWORK=<name of existing Traefik's network>."
    fi
    # Best-effort resolver detection — informational only, user override wins.
    if [ "$OWNER_KIND" = "traefik" ] && [ -n "$OWNER_NAME" ]; then
      detected_resolver=$(detect_cert_resolver "$OWNER_NAME" || true)
      if [ -n "$detected_resolver" ] && [ "$detected_resolver" != "$TRAEFIK_CERTRESOLVER" ]; then
        info "Detected cert resolver '${detected_resolver}' on '${OWNER_NAME}' (configured: '${TRAEFIK_CERTRESOLVER}'). Set TRAEFIK_CERTRESOLVER='${detected_resolver}' if labels don't match."
      fi
    fi
    ;;
  port-only)
    if [ -n "$RELAY_DOMAIN" ]; then
      warn "RELAY_DOMAIN='${RELAY_DOMAIN}' is set but RELAY_MODE=port-only — domain routing is ignored in this mode."
    fi
    ;;
esac

# ── Step 5: Traefik bootstrap (greenfield only) ────────────────────────────
if [ "$RELAY_MODE" = "greenfield" ]; then
  if ! docker network inspect traefik-public &>/dev/null; then
    docker network create traefik-public >/dev/null
    log "Created traefik-public network"
  else
    log "traefik-public network exists"
  fi

  TRAEFIK_DIR="/opt/traefik"
  if docker ps --format '{{.Names}}' | grep -q '^traefik$'; then
    log "Traefik already running"
  else
    info "Starting Traefik..."
    mkdir -p "$TRAEFIK_DIR"
    touch "$TRAEFIK_DIR/acme.json"
    chmod 600 "$TRAEFIK_DIR/acme.json"

    cat > "$TRAEFIK_DIR/docker-compose.yml" <<TRAEFIK_EOF
services:
  traefik:
    image: traefik:v3
    container_name: traefik
    restart: unless-stopped
    command:
      - "--providers.docker=true"
      - "--providers.docker.exposedbydefault=false"
      - "--providers.docker.network=traefik-public"
      - "--entrypoints.web.address=:80"
      - "--entrypoints.websecure.address=:443"
$(if [ -n "$TRAEFIK_EMAIL" ]; then
cat <<ACME
      - "--entrypoints.web.http.redirections.entrypoint.to=websecure"
      - "--entrypoints.web.http.redirections.entrypoint.scheme=https"
      - "--certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web"
      - "--certificatesresolvers.letsencrypt.acme.email=${TRAEFIK_EMAIL}"
      - "--certificatesresolvers.letsencrypt.acme.storage=/acme.json"
ACME
fi)
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ${TRAEFIK_DIR}/acme.json:/acme.json
    networks:
      - traefik-public

networks:
  traefik-public:
    external: true
TRAEFIK_EOF

    docker compose -f "$TRAEFIK_DIR/docker-compose.yml" up -d
    log "Traefik started"
  fi
fi

# ── Step 6: agent-relay ────────────────────────────────────────────────────
mkdir -p "$RELAY_DIR" "$APPS_DIR"

# Preserve existing token or generate new one
if [ -f "$RELAY_DIR/.env" ] && grep -q '^AUTH_TOKEN=' "$RELAY_DIR/.env"; then
  AUTH_TOKEN=$(grep '^AUTH_TOKEN=' "$RELAY_DIR/.env" | cut -d= -f2-)
  log "Using existing auth token"
else
  AUTH_TOKEN=$(openssl rand -hex 32)
  log "Generated auth token"
fi

cat > "$RELAY_DIR/.env" <<ENV_EOF
AUTH_TOKEN=${AUTH_TOKEN}
APPS_DIR=/apps
PORT=${RELAY_PORT}
ENV_EOF

# Build compose file. Three shapes, driven by RELAY_MODE.
case "$RELAY_MODE" in
  greenfield)
    RELAY_NETWORK_NAME="traefik-public"
    RELAY_CERT_RESOLVER="letsencrypt"
    if [ -n "$RELAY_DOMAIN" ] && [ -n "$TRAEFIK_EMAIL" ]; then
      RELAY_LABELS="    labels:
      - traefik.enable=true
      - traefik.docker.network=${RELAY_NETWORK_NAME}
      - traefik.http.routers.relay.rule=Host(\`${RELAY_DOMAIN}\`)
      - traefik.http.routers.relay.entrypoints=websecure
      - traefik.http.routers.relay.tls.certresolver=${RELAY_CERT_RESOLVER}
      - traefik.http.services.relay.loadbalancer.server.port=${RELAY_PORT}"
    else
      RELAY_LABELS=""
    fi
    cat > "$RELAY_DIR/docker-compose.yml" <<COMPOSE_EOF
services:
  relay:
    image: ghcr.io/lannguyensi/agent-relay:latest
    container_name: agent-relay
    restart: unless-stopped
    env_file: .env
    ports:
      - "${RELAY_PORT}:${RELAY_PORT}"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ${APPS_DIR}:/apps
${RELAY_LABELS}
    networks:
      - ${RELAY_NETWORK_NAME}
      - default

networks:
  ${RELAY_NETWORK_NAME}:
    external: true
COMPOSE_EOF
    ;;

  existing-traefik)
    RELAY_LABELS="    labels:
      - traefik.enable=true
      - traefik.docker.network=${TRAEFIK_NETWORK}
      - traefik.http.routers.relay.rule=Host(\`${RELAY_DOMAIN}\`)
      - traefik.http.routers.relay.entrypoints=websecure
      - traefik.http.routers.relay.tls.certresolver=${TRAEFIK_CERTRESOLVER}
      - traefik.http.services.relay.loadbalancer.server.port=${RELAY_PORT}"
    cat > "$RELAY_DIR/docker-compose.yml" <<COMPOSE_EOF
services:
  relay:
    image: ghcr.io/lannguyensi/agent-relay:latest
    container_name: agent-relay
    restart: unless-stopped
    env_file: .env
    expose:
      - "${RELAY_PORT}"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ${APPS_DIR}:/apps
${RELAY_LABELS}
    networks:
      - ${TRAEFIK_NETWORK}
      - default

networks:
  ${TRAEFIK_NETWORK}:
    external: true
COMPOSE_EOF
    ;;

  port-only)
    cat > "$RELAY_DIR/docker-compose.yml" <<COMPOSE_EOF
services:
  relay:
    image: ghcr.io/lannguyensi/agent-relay:latest
    container_name: agent-relay
    restart: unless-stopped
    env_file: .env
    ports:
      - "${RELAY_BIND}:${RELAY_PORT}:${RELAY_PORT}"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ${APPS_DIR}:/apps
    networks:
      - default
COMPOSE_EOF
    ;;
esac

docker compose -f "$RELAY_DIR/docker-compose.yml" pull 2>/dev/null || warn "Could not pull image — will build locally if available"
docker compose -f "$RELAY_DIR/docker-compose.yml" up -d
log "agent-relay started (mode=${RELAY_MODE})"

# ── Step 7: Print connection info ──────────────────────────────────────────
HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}')

case "$RELAY_MODE" in
  greenfield|existing-traefik)
    if [ -n "$RELAY_DOMAIN" ]; then
      RELAY_URL="https://${RELAY_DOMAIN}"
    else
      # Only reachable in greenfield-without-domain edge case (no labels, no TLS)
      RELAY_URL="http://${HOST_IP}:${RELAY_PORT}"
    fi
    ;;
  port-only)
    # In port-only, the URL operators should use is the publicly-reachable one.
    # If RELAY_BIND=127.0.0.1, the URL is only useful on the VPS itself; we still
    # print the host IP so wizard / operator gets a stable URL to test from the box.
    if [ "$RELAY_BIND" = "127.0.0.1" ]; then
      RELAY_URL="http://127.0.0.1:${RELAY_PORT}"
    else
      RELAY_URL="http://${HOST_IP}:${RELAY_PORT}"
    fi
    ;;
esac

echo ""
echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN} agent-relay is ready!${NC}"
echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  Mode:  ${CYAN}${RELAY_MODE}${NC}"
echo -e "  URL:   ${CYAN}${RELAY_URL}${NC}"
echo -e "  Token: ${YELLOW}${AUTH_TOKEN}${NC}"
echo ""
if [ "$RELAY_MODE" = "port-only" ]; then
  echo -e "  ${YELLOW}Port-only mode: no TLS.${NC}"
  echo -e "  Bind: ${RELAY_BIND}:${RELAY_PORT}. If this host is reachable from the"
  echo -e "  internet, ensure a firewall or reverse proxy handles TLS termination."
  echo ""
fi
echo -e "  Health:    curl -s \$URL/health"
echo -e "  API:       curl -s -H 'Authorization: Bearer \$TOKEN' \$URL/api/apps"
echo -e "  MCP:       \$URL/mcp"
echo ""
echo -e "  Apps dir:  ${APPS_DIR}"
echo -e "  Config:    ${RELAY_DIR}/.env"
echo ""
echo -e "  ${CYAN}Add to deploy-panel:${NC}"
echo -e "    Name:       $(hostname)"
echo -e "    Host:       ${HOST_IP}"
echo -e "    Relay URL:  ${RELAY_URL}"
echo -e "    Relay Token: ${AUTH_TOKEN}"
echo ""
