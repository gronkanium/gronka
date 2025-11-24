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
    
    # Send SIGTERM to processes (handle both webui and app scenarios)
    if [ -n "$WEBUI_PID" ]; then
        # WebUI mode: single process
        if is_process_running "$WEBUI_PID"; then
            log_info "Stopping webui process (PID: $WEBUI_PID)..."
            kill -TERM "$WEBUI_PID" 2>/dev/null || true
        fi
    else
        # App mode: server and bot processes
        if is_process_running "$SERVER_PID"; then
            log_info "Stopping server process (PID: $SERVER_PID)..."
            kill -TERM "$SERVER_PID" 2>/dev/null || true
        fi
        
        if is_process_running "$BOT_PID"; then
            log_info "Stopping bot process (PID: $BOT_PID)..."
            kill -TERM "$BOT_PID" 2>/dev/null || true
        fi
    fi
    
    # Wait for processes to terminate (max 10 seconds)
    for i in $(seq 1 10); do
        if [ -n "$WEBUI_PID" ]; then
            if ! is_process_running "$WEBUI_PID"; then
                break
            fi
        else
            if ! is_process_running "$SERVER_PID" && ! is_process_running "$BOT_PID"; then
                break
            fi
        fi
        sleep 1
    done
    
    # Force kill if still running
    if [ -n "$WEBUI_PID" ]; then
        if is_process_running "$WEBUI_PID"; then
            log_warn "WebUI process did not terminate, forcing kill..."
            kill -KILL "$WEBUI_PID" 2>/dev/null || true
        fi
        wait "$WEBUI_PID" 2>/dev/null || true
    else
        if is_process_running "$SERVER_PID"; then
            log_warn "Server process did not terminate, forcing kill..."
            kill -KILL "$SERVER_PID" 2>/dev/null || true
        fi
        
        if is_process_running "$BOT_PID"; then
            log_warn "Bot process did not terminate, forcing kill..."
            kill -KILL "$BOT_PID" 2>/dev/null || true
        fi
        wait "$SERVER_PID" "$BOT_PID" 2>/dev/null || true
    fi
    
    log_info "Shutdown complete"
    exit 0
}

# Trap signals for graceful shutdown
trap 'cleanup' TERM INT

# Check if running as webui service
if [ -n "$WEBUI_PORT" ]; then
    # WebUI mode: only start webui-server.js
    log_info "Detected webui service, starting webui server only..."
    
    # Check if node_modules exists and has required dependencies
    if [ ! -d "node_modules" ] || [ ! -d "node_modules/express" ]; then
        log_error "node_modules not found or incomplete. Please rebuild the container."
        exit 1
    fi
    
    log_info "Starting webui server..."
    # Run in foreground first to capture any immediate errors, then background it
    node src/webui-server.js > /tmp/webui.log 2>&1 &
    WEBUI_PID=$!
    
    # Give webui more time to start and show any errors
    sleep 5
    
    # Check if webui started successfully
    if ! is_process_running "$WEBUI_PID"; then
        log_error "WebUI process failed to start"
        log_error "Last 20 lines of output:"
        tail -n 20 /tmp/webui.log 2>/dev/null || echo "No log file available"
        exit 1
    fi
    
    log_info "WebUI started (PID: $WEBUI_PID)"
    log_info "WebUI process running. Monitoring..."
    
    # Monitor webui process
    while true; do
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
else
    # App mode: start both server and bot
    # Start the Express server in the background
    log_info "Starting Express server..."
    node src/server.js &
    SERVER_PID=$!
    
    # Give server a moment to start
    sleep 2
    
    # Check if server started successfully
    if ! is_process_running "$SERVER_PID"; then
        log_error "Server process failed to start"
        exit 1
    fi
    
    log_info "Server started (PID: $SERVER_PID)"
    
    # Start the Discord bot in the background
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
    log_info "All processes running. Monitoring..."
    
    # Monitor both processes
    # Wait for either process to exit, then cleanup
    while true; do
        # Check if server process is still running
        if ! is_process_running "$SERVER_PID"; then
            log_error "Server process exited unexpectedly (PID: $SERVER_PID)"
            cleanup
            exit 1
        fi
        
        # Check if bot process is still running
        if ! is_process_running "$BOT_PID"; then
            log_error "Bot process exited unexpectedly (PID: $BOT_PID)"
            cleanup
            exit 1
        fi
        
        # Sleep briefly before checking again
        sleep 5
    done
fi

