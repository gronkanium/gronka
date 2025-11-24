#!/bin/bash
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

error() {
  echo -e "${RED}Error:${NC} $1" >&2
  exit 1
}

info() {
  echo -e "${GREEN}Info:${NC} $1"
}

# Check if docker daemon is available
if ! docker info >/dev/null 2>&1; then
  error "Docker daemon is not running or not accessible"
fi

# Check if webui container is running
CONTAINER_NAME="gronka-webui"
if ! docker ps --filter "name=${CONTAINER_NAME}" --format "{{.Names}}" | grep -q "${CONTAINER_NAME}"; then
  error "Container ${CONTAINER_NAME} is not running. Please start it first with: docker compose --profile webui up -d"
fi

# Build webui locally
info "Building webui locally..."
if ! npm run build:webui; then
  error "Failed to build webui locally"
fi

# Copy built files to container
info "Copying built files to container..."
docker cp src/public/. ${CONTAINER_NAME}:/app/src/public/

info "Files copied successfully. The webui should now reflect the latest changes."

