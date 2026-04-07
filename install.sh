#!/usr/bin/env bash
# agent-relay VPS bootstrap installer
# Usage: curl -sSL https://raw.githubusercontent.com/LanNguyenSi/agent-relay/main/install.sh | bash
#
# What it does:
# 1. Install Docker + Docker Compose (if missing)
# 2. Create traefik-public network + start Traefik (if not running)
# 3. Pull and start agent-relay container
# 4. Generate auth token (if not set)
# 5. Print connection info

set -euo pipefail

RELAY_DIR="${RELAY_DIR:-/opt/agent-relay}"
APPS_DIR="${APPS_DIR:-/home/deploy/apps}"
RELAY_PORT="${RELAY_PORT:-8222}"
TRAEFIK_EMAIL="${TRAEFIK_EMAIL:-}"
RELAY_DOMAIN="${RELAY_DOMAIN:-}"

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

# ── Step 2: Traefik ────────────────────────────────────────────────────────
if ! docker network inspect traefik-public &>/dev/null; then
  docker network create traefik-public
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

  # Build Traefik compose
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

# ── Step 3: agent-relay ────────────────────────────────────────────────────
mkdir -p "$RELAY_DIR" "$APPS_DIR"

# Generate token if not set
# Preserve existing token or generate new one
if [ -f "$RELAY_DIR/.env" ] && grep -q '^AUTH_TOKEN=' "$RELAY_DIR/.env"; then
  AUTH_TOKEN=$(grep '^AUTH_TOKEN=' "$RELAY_DIR/.env" | cut -d= -f2-)
  log "Using existing auth token"
else
  AUTH_TOKEN=$(openssl rand -hex 32)
  log "Generated auth token"
fi

# Always rewrite .env to pick up config changes (port, apps dir)
cat > "$RELAY_DIR/.env" <<ENV_EOF
AUTH_TOKEN=${AUTH_TOKEN}
APPS_DIR=/apps
PORT=${RELAY_PORT}
ENV_EOF

# Create relay docker-compose
RELAY_LABELS=""
if [ -n "$RELAY_DOMAIN" ] && [ -z "$TRAEFIK_EMAIL" ]; then
  warn "RELAY_DOMAIN is set but TRAEFIK_EMAIL is empty — TLS will not work."
  warn "Set TRAEFIK_EMAIL=you@example.com and re-run, or unset RELAY_DOMAIN for port-only mode."
fi
if [ -n "$RELAY_DOMAIN" ] && [ -n "$TRAEFIK_EMAIL" ]; then
  RELAY_LABELS="    labels:
      - traefik.enable=true
      - traefik.http.routers.relay.rule=Host(\`${RELAY_DOMAIN}\`)
      - traefik.http.routers.relay.entrypoints=websecure
      - traefik.http.routers.relay.tls.certresolver=letsencrypt
      - traefik.http.services.relay.loadbalancer.server.port=${RELAY_PORT}"
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
      - /var/run/docker.sock:/var/run/docker.sock  # read-write: relay manages app containers
      - ${APPS_DIR}:/apps
${RELAY_LABELS}
    networks:
      - traefik-public
      - default

networks:
  traefik-public:
    external: true
COMPOSE_EOF

docker compose -f "$RELAY_DIR/docker-compose.yml" pull 2>/dev/null || warn "Could not pull image — will build locally if available"
docker compose -f "$RELAY_DIR/docker-compose.yml" up -d
log "agent-relay started"

# ── Step 4: Print connection info ──────────────────────────────────────────
echo ""
echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN} agent-relay is ready!${NC}"
echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
echo ""
if [ -n "$RELAY_DOMAIN" ]; then
  echo -e "  URL:   ${CYAN}https://${RELAY_DOMAIN}${NC}"
else
  echo -e "  URL:   ${CYAN}http://$(hostname -I | awk '{print $1}'):${RELAY_PORT}${NC}"
fi
echo -e "  Token: ${YELLOW}${AUTH_TOKEN}${NC}"
echo ""
echo -e "  Health:    curl -s \$URL/health"
echo -e "  API:       curl -s -H 'Authorization: Bearer \$TOKEN' \$URL/api/apps"
echo -e "  MCP:       \$URL/mcp"
echo ""
echo -e "  Apps dir:  ${APPS_DIR}"
echo -e "  Config:    ${RELAY_DIR}/.env"
echo ""
echo -e "  ${CYAN}Add to deploy-panel:${NC}"
echo -e "    Name:       $(hostname)"
echo -e "    Host:       $(hostname -I | awk '{print $1}')"
if [ -n "$RELAY_DOMAIN" ]; then
  echo -e "    Relay URL:  https://${RELAY_DOMAIN}"
else
  echo -e "    Relay URL:  http://$(hostname -I | awk '{print $1}'):${RELAY_PORT}"
fi
echo -e "    Relay Token: ${AUTH_TOKEN}"
echo ""
