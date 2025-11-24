#!/bin/bash
set -euo pipefail

TIMEOUT=120

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

info "Restarting docker compose services..."

# Step 1: Restart containers
info "Restarting containers"
if ! docker compose restart; then
  error "Failed to restart containers"
fi

# Wait a moment for containers to initialize
sleep 3

# Step 2: Verify containers started successfully
info "Verifying container status..."

MAX_WAIT=$TIMEOUT
ELAPSED=0

# Helper function to check container status
check_status() {
  local ps_output
  ps_output=$(docker compose ps 2>/dev/null || echo "")
  
  if [ -z "$ps_output" ]; then
    echo "0:0:0"
    return
  fi
  
  local running=0
  local exited=0
  local restarting=0
  
  while IFS= read -r line; do
    if echo "$line" | grep -q "running"; then
      running=$((running + 1))
    elif echo "$line" | grep -q "Exited"; then
      exited=$((exited + 1))
    elif echo "$line" | grep -q "restarting"; then
      restarting=$((restarting + 1))
    fi
  done <<< "$ps_output"
  
  echo "$running:$exited:$restarting"
}

while [ $ELAPSED -lt $MAX_WAIT ]; do
  STATUS=$(check_status)
  RUNNING=$(echo "$STATUS" | cut -d: -f1)
  EXITED=$(echo "$STATUS" | cut -d: -f2)
  RESTARTING=$(echo "$STATUS" | cut -d: -f3)
  
  # Check for exited containers (failed)
  if [ "$EXITED" -gt 0 ]; then
    EXITED_CONTAINERS=$(docker compose ps --format "{{.Name}}: {{.Status}}" 2>/dev/null | grep "Exited" || true)
    if [ -n "$EXITED_CONTAINERS" ]; then
      error "Some containers exited: $EXITED_CONTAINERS"
    fi
  fi
  
  # Count total services
  TOTAL_SERVICES=$(docker compose ps --format "{{.Name}}" 2>/dev/null | grep -v "^$" | wc -l || echo "0")
  
  # If all running and none restarting/exited, we're good
  if [ "$TOTAL_SERVICES" -gt 0 ] && [ "$RUNNING" -ge "$TOTAL_SERVICES" ] && [ "$RESTARTING" -eq 0 ] && [ "$EXITED" -eq 0 ]; then
    info "All containers are running"
    
    # Check for health checks and wait for them
    HAS_HEALTHCHECK=0
    while IFS= read -r name; do
      if [ -n "$name" ]; then
        if docker inspect "$name" --format '{{.State.Health}}' 2>/dev/null | grep -q "Status"; then
          HAS_HEALTHCHECK=1
          break
        fi
      fi
    done <<< "$(docker compose ps --format "{{.Name}}" 2>/dev/null)"
    
    if [ "$HAS_HEALTHCHECK" -eq 1 ]; then
      info "Waiting for health checks to pass..."
      sleep 10
      
      # Check final health status
      UNHEALTHY=0
      while IFS= read -r name; do
        if [ -n "$name" ]; then
          HEALTH=$(docker inspect "$name" --format '{{.State.Health.Status}}' 2>/dev/null || echo "")
          if [ "$HEALTH" = "unhealthy" ]; then
            UNHEALTHY=$((UNHEALTHY + 1))
          fi
        fi
      done <<< "$(docker compose ps --format "{{.Name}}" 2>/dev/null)"
      
      if [ "$UNHEALTHY" -gt 0 ]; then
        warn "Some containers are unhealthy. Check logs with: npm run docker:logs"
      else
        info "All health checks passed"
      fi
    fi
    
    info "Restart complete"
    exit 0
  fi
  
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

# Timeout - show status
warn "Timeout waiting for containers. Current status:"
docker compose ps

# Check if any failed
STATUS=$(check_status)
EXITED=$(echo "$STATUS" | cut -d: -f2)
if [ "$EXITED" -gt 0 ]; then
  error "Some containers failed to start. Check logs with: npm run docker:logs"
fi

warn "Containers may still be starting. Check status with: docker compose ps"

