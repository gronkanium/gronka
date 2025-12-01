#!/bin/sh

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

# Function to check if a process is still running
is_process_running() {
    kill -0 "$1" 2>/dev/null
}

# Function to handle shutdown
cleanup() {
    log_info "Shutting down gracefully..."
    
    # Send SIGTERM to all processes
    if is_process_running "$BOT_PID"; then
        log_info "Stopping bot process (PID: $BOT_PID)..."
        kill -TERM "$BOT_PID" 2>/dev/null || true
    fi
    
    if is_process_running "$WEBUI_PID"; then
        log_info "Stopping webui process (PID: $WEBUI_PID)..."
        kill -TERM "$WEBUI_PID" 2>/dev/null || true
    fi
    
    # Wait for processes to terminate (max 10 seconds)
    for i in $(seq 1 10); do
        if ! is_process_running "$BOT_PID" && ! is_process_running "$WEBUI_PID"; then
            break
        fi
        sleep 1
    done
    
    # Force kill if still running
    if is_process_running "$BOT_PID"; then
        log_warn "Bot process did not terminate, forcing kill..."
        kill -KILL "$BOT_PID" 2>/dev/null || true
    fi
    
    if is_process_running "$WEBUI_PID"; then
        log_warn "WebUI process did not terminate, forcing kill..."
        kill -KILL "$WEBUI_PID" 2>/dev/null || true
    fi
    
    wait "$BOT_PID" "$WEBUI_PID" 2>/dev/null || true
    
    log_info "Shutdown complete"
    exit 0
}

# Trap signals for graceful shutdown
trap 'cleanup' TERM INT

# Start the Discord bot in the background (includes stats HTTP server)
log_info "Starting Discord bot..."
node src/bot.js &
BOT_PID=$!

# Give bot a moment to start
sleep 2

# Check if bot started successfully
if ! is_process_running "$BOT_PID"; then
    log_error "Bot process failed to start"
    cleanup
    exit 1
fi

log_info "Bot started (PID: $BOT_PID)"

# Start the WebUI server in the background
log_info "Starting WebUI server..."
node src/webui-server.js > /tmp/webui.log 2>&1 &
WEBUI_PID=$!

# Give webui a moment to start
sleep 2

# Check if webui started successfully
if ! is_process_running "$WEBUI_PID"; then
    log_error "WebUI process failed to start"
    log_error "Last 20 lines of output:"
    tail -n 20 /tmp/webui.log 2>/dev/null || echo "No log file available"
    cleanup
    exit 1
fi

log_info "WebUI started (PID: $WEBUI_PID)"
log_info "All processes running. Monitoring..."

# Monitor both processes
while true; do
    # Check if bot process is still running
    if ! is_process_running "$BOT_PID"; then
        log_error "Bot process exited unexpectedly (PID: $BOT_PID)"
        cleanup
        exit 1
    fi
    
    # Check if webui process is still running
    if ! is_process_running "$WEBUI_PID"; then
        log_error "WebUI process exited unexpectedly (PID: $WEBUI_PID)"
        log_error "Last 20 lines of output:"
        tail -n 20 /tmp/webui.log 2>/dev/null || echo "No log file available"
        cleanup
        exit 1
    fi
    
    # Sleep briefly before checking again
    sleep 5
done

