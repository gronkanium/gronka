#!/bin/bash
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info() {
  echo -e "${GREEN}Info:${NC} $1"
}

warn() {
  echo -e "${YELLOW}Warning:${NC} $1"
}

error() {
  echo -e "${RED}Error:${NC} $1" >&2
}

section() {
  echo -e "${BLUE}=== $1 ===${NC}"
}

# Check if docker daemon is available
if ! docker info >/dev/null 2>&1; then
  error "Docker daemon is not running or not accessible"
  exit 1
fi

section "Checking Docker Containers Status"

# Get current git commit hash
CURRENT_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
CURRENT_COMMIT_SHORT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

info "Current repository commit: ${CURRENT_COMMIT_SHORT}"

# Check if containers are running
CONTAINERS=("gronka" "gronka-webui")
ALL_UP_TO_DATE=true

for CONTAINER in "${CONTAINERS[@]}"; do
  echo ""
  section "Checking ${CONTAINER}"
  
  if ! docker ps --format "{{.Names}}" | grep -q "^${CONTAINER}$"; then
    warn "${CONTAINER} is not running"
    ALL_UP_TO_DATE=false
    continue
  fi
  
  info "${CONTAINER} is running"
  
  # Try to get commit hash from container environment
  CONTAINER_COMMIT=$(docker exec "${CONTAINER}" sh -c 'echo $GIT_COMMIT' 2>/dev/null | tr -d '\r\n' || echo "unknown")
  
  # If that didn't work, try inspecting the container's env vars
  if [ "${CONTAINER_COMMIT}" = "unknown" ] || [ -z "${CONTAINER_COMMIT}" ]; then
    CONTAINER_COMMIT=$(docker inspect "${CONTAINER}" --format='{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep "^GIT_COMMIT=" | cut -d'=' -f2 | tr -d '\r\n' || echo "unknown")
  fi
  
  # Try to get build timestamp
  BUILD_TIMESTAMP=$(docker exec "${CONTAINER}" sh -c 'echo $BUILD_TIMESTAMP 2>/dev/null' 2>/dev/null || echo "unknown")
  
  if [ "${CONTAINER_COMMIT}" != "unknown" ] && [ "${CONTAINER_COMMIT}" != "" ]; then
    CONTAINER_COMMIT_SHORT=$(echo "${CONTAINER_COMMIT}" | cut -c1-7)
    info "Container commit: ${CONTAINER_COMMIT_SHORT}"
    
    if [ "${CONTAINER_COMMIT}" = "${CURRENT_COMMIT}" ]; then
      info "${CONTAINER} is running the latest code ✓"
    else
      warn "${CONTAINER} is running different code (${CONTAINER_COMMIT_SHORT} vs ${CURRENT_COMMIT_SHORT})"
      ALL_UP_TO_DATE=false
    fi
  else
    warn "Could not determine commit hash for ${CONTAINER}"
    if [ "${BUILD_TIMESTAMP}" != "unknown" ] && [ "${BUILD_TIMESTAMP}" != "" ]; then
      info "Build timestamp: ${BUILD_TIMESTAMP}"
    fi
    ALL_UP_TO_DATE=false
  fi
  
  # Show container image info
  IMAGE=$(docker inspect "${CONTAINER}" --format='{{.Config.Image}}' 2>/dev/null || echo "unknown")
  CREATED=$(docker inspect "${CONTAINER}" --format='{{.Created}}' 2>/dev/null || echo "unknown")
  info "Image: ${IMAGE}"
  if [ "${CREATED}" != "unknown" ]; then
    info "Container created: ${CREATED}"
  fi
done

echo ""
section "Summary"

if [ "${ALL_UP_TO_DATE}" = true ]; then
  info "All containers are running and appear to be up to date"
  exit 0
else
  warn "Some containers may not be running the latest code"
  info "To update, run: npm run docker:reload"
  exit 1
fi

