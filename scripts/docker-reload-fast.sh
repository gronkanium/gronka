#!/bin/bash
set -euo pipefail


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

info "Fast reloading docker compose services (using build cache)..."

# Step 1: Stop and remove containers, and remove associated images
info "Stopping containers and removing images..."
if ! docker compose down --rmi all --remove-orphans; then
  error "Failed to stop containers and remove images"
fi

# Step 2: Prune containers and networks
info "Cleaning up unused containers and networks..."
docker container prune -f >/dev/null 2>&1 || true
docker network prune -f >/dev/null 2>&1 || true

# Step 3: Get git commit hash and build timestamp
GIT_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "")
BUILD_TIMESTAMP=$(date +%s)

# Export as environment variables for docker-compose.yml to use
export GIT_COMMIT
export BUILD_TIMESTAMP

# Step 4: Rebuild images with build args (using cache for speed)
info "Rebuilding images with cache (this should be much faster)..."
if ! docker compose build; then
  error "Failed to build docker images"
fi

# Step 5: Start containers
info "Starting containers"
if ! docker compose up -d; then
  error "Failed to start docker compose services"
fi

info "Fast reload complete"

