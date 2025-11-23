#!/bin/bash
set -euo pipefail

PROFILES="--profile webui"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

error() {
  echo -e "${RED}Error:${NC} $1" >&2
  exit 1
}

info() {
  echo -e "${GREEN}Info:${NC} $1"
}

warn() {
  echo -e "${YELLOW}Warning:${NC} $1"
}

# Check if docker daemon is available
if ! docker info >/dev/null 2>&1; then
  error "Docker daemon is not running or not accessible"
fi

info "Reloading docker compose services..."

# Step 1: Stop and remove containers
info "Stopping containers..."
if ! docker compose $PROFILES down --remove-orphans; then
  error "Failed to stop containers"
fi

# Step 2: Remove images (ignore errors if they don't exist)
info "Removing old images..."
docker rmi esm-app esm-webui 2>/dev/null || true

# Step 3: Prune containers and networks
info "Cleaning up unused containers and networks..."
docker container prune -f >/dev/null 2>&1 || true
docker network prune -f >/dev/null 2>&1 || true

# Step 4: Rebuild images
info "Rebuilding images (this will take a while)..."
if ! docker compose build --no-cache --pull; then
  error "Failed to build docker images"
fi

# Step 5: Start containers with profiles
info "Starting containers with profiles: webui"
if ! docker compose $PROFILES up -d; then
  error "Failed to start docker compose services"
fi

info "Reload complete"

