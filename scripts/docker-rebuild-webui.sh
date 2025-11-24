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

# Check if app container is running
CONTAINER_NAME="gronka"
if ! docker ps --filter "name=${CONTAINER_NAME}" --format "{{.Names}}" | grep -q "${CONTAINER_NAME}"; then
  error "Container ${CONTAINER_NAME} is not running. Please start it first with: docker compose up -d"
fi

# Install devDependencies inside the container (needed for building webui)
info "Installing devDependencies in container..."
if ! docker compose exec -T app npm install --include=dev; then
  error "Failed to install devDependencies in container"
fi

# Build webui inside the container
info "Building webui inside container..."
if ! docker compose exec -T app npm run build:webui; then
  error "Failed to build webui inside container"
fi

info "WebUI rebuild complete. The webui should now reflect the latest changes."
info "Note: Browser caching may require a hard refresh (Ctrl+F5) to see changes."

