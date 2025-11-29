#!/bin/bash

# Automated Jekyll Site Update Script
# Fetches from newer remote (GitHub or GitLab) and rebuilds site with safety checks
# Always updates stats and rebuilds Jekyll, even if git is up to date

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/jekyll-update.log"
SITE_DIR="$PROJECT_ROOT/_site"
BACKUP_DIR="$PROJECT_ROOT/_site.backup"
STATS_FILE="$PROJECT_ROOT/_data/stats.json"
REMOTE_GITHUB="origin"
REMOTE_GITLAB="gitlab"
BRANCH="main"

# Exit codes
EXIT_SUCCESS=0
EXIT_BUILD_FAILED=1
EXIT_GIT_ERROR=2
EXIT_VALIDATION_FAILED=3

# Logging function
log() {
    local level="$1"
    shift
    local message="$*"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] [$level] $message" | tee -a "$LOG_FILE"
}

# Log section header
log_section() {
    local section="$1"
    log "INFO" "=========================================="
    log "INFO" "=== $section ==="
    log "INFO" "=========================================="
}

# Error handler
error_exit() {
    local exit_code="$1"
    shift
    log "ERROR" "$*"
    exit "$exit_code"
}

# Cleanup function
cleanup() {
    local exit_code=$?
    if [ $exit_code -ne 0 ]; then
        log "ERROR" "Script failed with exit code $exit_code"
    fi
}

trap cleanup EXIT

# Change to project root
cd "$PROJECT_ROOT" || error_exit $EXIT_GIT_ERROR "Failed to change to project root: $PROJECT_ROOT"

log_section "Starting Jekyll Site Update Process"
log "INFO" "Project root: $PROJECT_ROOT"
log "INFO" "Log file: $LOG_FILE"

# ============================================================================
# SECTION 1: Git Update (Optional - skip if up to date, but continue anyway)
# ============================================================================
log_section "Git Update Check"

GIT_UPDATED=false
CURRENT_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
NEW_COMMIT=""

log "INFO" "Current commit: $CURRENT_COMMIT"

# Step 1: Stash local changes
log "INFO" "Checking for local changes..."
if ! git diff-index --quiet HEAD --; then
    log "WARN" "Local changes detected, stashing..."
    git stash push -m "Auto-stash before Jekyll update $(date '+%Y-%m-%d %H:%M:%S')" || {
        log "WARN" "Stash failed, but continuing..."
    }
fi

# Step 2: Fetch from both remotes
log "INFO" "Fetching from remotes..."
if ! git fetch "$REMOTE_GITHUB" "$BRANCH" 2>&1 | tee -a "$LOG_FILE"; then
    log "WARN" "Failed to fetch from $REMOTE_GITHUB, continuing..."
fi

if ! git fetch "$REMOTE_GITLAB" "$BRANCH" 2>&1 | tee -a "$LOG_FILE"; then
    log "WARN" "Failed to fetch from $REMOTE_GITLAB, continuing..."
fi

# Step 3: Determine which remote is newer
log "INFO" "Comparing remotes to determine newer version..."

GITHUB_COMMIT=""
GITLAB_COMMIT=""
GITHUB_DATE=""
GITLAB_DATE=""

# Get GitHub commit date
if git rev-parse --verify "$REMOTE_GITHUB/$BRANCH" >/dev/null 2>&1; then
    GITHUB_COMMIT=$(git rev-parse "$REMOTE_GITHUB/$BRANCH")
    GITHUB_DATE=$(git log -1 --format=%ct "$REMOTE_GITHUB/$BRANCH" 2>/dev/null || echo "0")
    log "INFO" "GitHub ($REMOTE_GITHUB): commit $GITHUB_COMMIT, timestamp $GITHUB_DATE"
else
    log "WARN" "GitHub remote branch not found"
    GITHUB_DATE="0"
fi

# Get GitLab commit date
if git rev-parse --verify "$REMOTE_GITLAB/$BRANCH" >/dev/null 2>&1; then
    GITLAB_COMMIT=$(git rev-parse "$REMOTE_GITLAB/$BRANCH")
    GITLAB_DATE=$(git log -1 --format=%ct "$REMOTE_GITLAB/$BRANCH" 2>/dev/null || echo "0")
    log "INFO" "GitLab ($REMOTE_GITLAB): commit $GITLAB_COMMIT, timestamp $GITLAB_DATE"
else
    log "WARN" "GitLab remote branch not found"
    GITLAB_DATE="0"
fi

# Determine which remote is newer
SELECTED_REMOTE=""
SELECTED_COMMIT=""
if [ "$GITHUB_DATE" -gt "$GITLAB_DATE" ]; then
    SELECTED_REMOTE="$REMOTE_GITHUB"
    SELECTED_COMMIT="$GITHUB_COMMIT"
    log "INFO" "GitHub is newer, selecting $REMOTE_GITHUB"
elif [ "$GITLAB_DATE" -gt "$GITHUB_DATE" ]; then
    SELECTED_REMOTE="$REMOTE_GITLAB"
    SELECTED_COMMIT="$GITLAB_COMMIT"
    log "INFO" "GitLab is newer, selecting $REMOTE_GITLAB"
elif [ "$GITHUB_DATE" -eq "$GITLAB_DATE" ] && [ "$GITHUB_DATE" != "0" ]; then
    # Same timestamp, prefer GitLab as primary
    SELECTED_REMOTE="$REMOTE_GITLAB"
    SELECTED_COMMIT="$GITLAB_COMMIT"
    log "INFO" "Remotes are equal, defaulting to GitLab"
elif [ "$GITHUB_DATE" != "0" ] || [ "$GITLAB_DATE" != "0" ]; then
    # At least one remote is available
    if [ "$GITHUB_DATE" != "0" ]; then
        SELECTED_REMOTE="$REMOTE_GITHUB"
        SELECTED_COMMIT="$GITHUB_COMMIT"
    else
        SELECTED_REMOTE="$REMOTE_GITLAB"
        SELECTED_COMMIT="$GITLAB_COMMIT"
    fi
    log "INFO" "Using available remote: $SELECTED_REMOTE"
else
    log "WARN" "Could not determine newer remote. GitHub: $GITHUB_DATE, GitLab: $GITLAB_DATE. Continuing without git update..."
    SELECTED_REMOTE=""
    SELECTED_COMMIT=""
fi

# Step 4: Pull from selected remote if needed
if [ -n "$SELECTED_REMOTE" ] && [ -n "$SELECTED_COMMIT" ]; then
    if [ "$CURRENT_COMMIT" = "$SELECTED_COMMIT" ]; then
        log "INFO" "Git repository already up to date at commit $SELECTED_COMMIT"
        log "INFO" "Skipping git pull, but will continue with stats update and site rebuild"
    else
        log "INFO" "Git repository is behind. Pulling from $SELECTED_REMOTE/$BRANCH..."
        if ! git pull "$SELECTED_REMOTE" "$BRANCH" 2>&1 | tee -a "$LOG_FILE"; then
            log "ERROR" "Failed to pull from $SELECTED_REMOTE/$BRANCH, but continuing with stats update and rebuild..."
        else
            NEW_COMMIT=$(git rev-parse HEAD)
            log "INFO" "Successfully updated git repository from $CURRENT_COMMIT to $NEW_COMMIT"
            GIT_UPDATED=true
        fi
    fi
else
    log "WARN" "Skipping git update (no valid remote found), but continuing with stats update and rebuild"
fi

# ============================================================================
# SECTION 2: Update Stats from Bot API
# ============================================================================
log_section "Stats Update"

# Read current stats if file exists
OLD_STATS_EXISTS=false
OLD_USERS=""
OLD_FILES=""
OLD_DATA=""

if [ -f "$STATS_FILE" ]; then
    # Check if file is readable
    if [ ! -r "$STATS_FILE" ]; then
        log "WARN" "Stats file exists but is not readable: $STATS_FILE"
    else
        OLD_STATS_EXISTS=true
        log "INFO" "Reading current stats from $STATS_FILE..."
        
        # Try to read stats using jq if available, otherwise use python3
        STATS_READ_ERROR=false
        if command -v jq &> /dev/null; then
            if ! jq -e . "$STATS_FILE" >/dev/null 2>&1; then
                log "WARN" "Stats file exists but is not valid JSON (corrupted?)"
                STATS_READ_ERROR=true
            else
                OLD_USERS=$(jq -r '.unique_users // "unknown"' "$STATS_FILE" 2>/dev/null || echo "unknown")
                OLD_FILES=$(jq -r '.total_files // "unknown"' "$STATS_FILE" 2>/dev/null || echo "unknown")
                OLD_DATA=$(jq -r '.total_data_formatted // "unknown"' "$STATS_FILE" 2>/dev/null || echo "unknown")
                if [ "$OLD_USERS" != "unknown" ] && [ "$OLD_FILES" != "unknown" ] && [ "$OLD_DATA" != "unknown" ]; then
                    log "INFO" "Current stats: $OLD_USERS users, $OLD_FILES files, $OLD_DATA"
                else
                    log "WARN" "Stats file exists but contains invalid or missing data"
                    STATS_READ_ERROR=true
                fi
            fi
        elif command -v python3 &> /dev/null; then
            if ! python3 -c "import json; json.load(open('$STATS_FILE'))" 2>/dev/null; then
                log "WARN" "Stats file exists but is not valid JSON (corrupted?)"
                STATS_READ_ERROR=true
            else
                OLD_USERS=$(python3 -c "import json, sys; d=json.load(open('$STATS_FILE')); print(d.get('unique_users', 'unknown'))" 2>/dev/null || echo "unknown")
                OLD_FILES=$(python3 -c "import json, sys; d=json.load(open('$STATS_FILE')); print(d.get('total_files', 'unknown'))" 2>/dev/null || echo "unknown")
                OLD_DATA=$(python3 -c "import json, sys; d=json.load(open('$STATS_FILE')); print(d.get('total_data_formatted', 'unknown'))" 2>/dev/null || echo "unknown")
                if [ "$OLD_USERS" != "unknown" ] && [ "$OLD_FILES" != "unknown" ] && [ "$OLD_DATA" != "unknown" ]; then
                    log "INFO" "Current stats: $OLD_USERS users, $OLD_FILES files, $OLD_DATA"
                else
                    log "WARN" "Stats file exists but contains invalid or missing data"
                    STATS_READ_ERROR=true
                fi
            fi
        else
            log "WARN" "Stats file exists but jq/python3 not available to validate or read values"
            STATS_READ_ERROR=true
        fi
        
        if [ "$STATS_READ_ERROR" = true ]; then
            OLD_STATS_EXISTS=false
            OLD_USERS=""
            OLD_FILES=""
            OLD_DATA=""
        fi
    fi
else
    log "INFO" "No existing stats file found at $STATS_FILE"
fi

# Check environment variables
if [ -f "$PROJECT_ROOT/.env" ]; then
    if grep -q "^BOT_API_URL=" "$PROJECT_ROOT/.env" 2>/dev/null; then
        BOT_API_URL=$(grep "^BOT_API_URL=" "$PROJECT_ROOT/.env" | cut -d'=' -f2- | tr -d '"' | tr -d "'")
        log "INFO" "BOT_API_URL configured: $BOT_API_URL"
    else
        log "WARN" "BOT_API_URL not found in .env file"
    fi
else
    log "WARN" ".env file not found, using default BOT_API_URL"
fi

# Update stats from bot API (before build so stats are included)
log "INFO" "Fetching latest stats from bot API..."
cd "$PROJECT_ROOT"

STATS_UPDATE_SUCCESS=false
NEW_USERS=""
NEW_FILES=""
NEW_DATA=""
STATS_OUTPUT=""

# Try to update stats - this should never fail the entire script
set +e  # Temporarily disable exit on error for this section
STATS_OUTPUT=$(npm run jekyll:update-stats 2>&1)
STATS_EXIT_CODE=$?
set -e  # Re-enable exit on error

if [ $STATS_EXIT_CODE -eq 0 ] && echo "$STATS_OUTPUT" | grep -q "Stats updated successfully"; then
    STATS_UPDATE_SUCCESS=true
    log "INFO" "Stats update completed successfully"
    
    # Read new stats from file
    if [ -f "$STATS_FILE" ]; then
        # Validate the file is readable and valid JSON
        if [ -r "$STATS_FILE" ]; then
            # Try to read stats using jq if available, otherwise use python3
            if command -v jq &> /dev/null; then
                if jq -e . "$STATS_FILE" >/dev/null 2>&1; then
                    NEW_USERS=$(jq -r '.unique_users // ""' "$STATS_FILE" 2>/dev/null || echo "")
                    NEW_FILES=$(jq -r '.total_files // ""' "$STATS_FILE" 2>/dev/null || echo "")
                    NEW_DATA=$(jq -r '.total_data_formatted // ""' "$STATS_FILE" 2>/dev/null || echo "")
                else
                    log "WARN" "Stats file was written but is not valid JSON"
                fi
            elif command -v python3 &> /dev/null; then
                if python3 -c "import json; json.load(open('$STATS_FILE'))" 2>/dev/null; then
                    NEW_USERS=$(python3 -c "import json, sys; d=json.load(open('$STATS_FILE')); print(d.get('unique_users', ''))" 2>/dev/null || echo "")
                    NEW_FILES=$(python3 -c "import json, sys; d=json.load(open('$STATS_FILE')); print(d.get('total_files', ''))" 2>/dev/null || echo "")
                    NEW_DATA=$(python3 -c "import json, sys; d=json.load(open('$STATS_FILE')); print(d.get('total_data_formatted', ''))" 2>/dev/null || echo "")
                else
                    log "WARN" "Stats file was written but is not valid JSON"
                fi
            fi
            
            if [ -n "$NEW_USERS" ] && [ -n "$NEW_FILES" ] && [ -n "$NEW_DATA" ]; then
                log "INFO" "New stats fetched: $NEW_USERS users, $NEW_FILES files, $NEW_DATA"
                
                # Compare if we had old stats
                if [ "$OLD_STATS_EXISTS" = true ] && [ -n "$OLD_USERS" ] && [ -n "$OLD_FILES" ] && [ -n "$OLD_DATA" ]; then
                    if [ "$OLD_USERS" != "$NEW_USERS" ] || [ "$OLD_FILES" != "$NEW_FILES" ] || [ "$OLD_DATA" != "$NEW_DATA" ]; then
                        log "INFO" "Stats changed:"
                        log "INFO" "  Users: $OLD_USERS -> $NEW_USERS"
                        log "INFO" "  Files: $OLD_FILES -> $NEW_FILES"
                        log "INFO" "  Data: $OLD_DATA -> $NEW_DATA"
                    else
                        log "INFO" "Stats unchanged (same as before)"
                    fi
                fi
            else
                log "WARN" "Stats update reported success but could not read values from file"
            fi
        else
            log "WARN" "Stats file was created but is not readable"
        fi
    else
        log "WARN" "Stats update reported success but stats file was not created"
    fi
    
    # Log full stats update output
    echo "$STATS_OUTPUT" | tee -a "$LOG_FILE"
else
    # Stats update failed - log details but continue
    log "WARN" "Stats update failed (exit code: $STATS_EXIT_CODE)"
    
    # Determine failure reason
    if [ -z "$STATS_OUTPUT" ]; then
        log "WARN" "No output from stats update script - possible script error"
    elif echo "$STATS_OUTPUT" | grep -qi "timeout\|timed out"; then
        log "WARN" "Stats update failed: timeout connecting to bot API"
    elif echo "$STATS_OUTPUT" | grep -qi "ECONNREFUSED\|connection refused\|refused"; then
        log "WARN" "Stats update failed: bot API server is not responding (connection refused)"
    elif echo "$STATS_OUTPUT" | grep -qi "ENOTFOUND\|could not resolve\|hostname"; then
        log "WARN" "Stats update failed: could not resolve bot API hostname"
    elif echo "$STATS_OUTPUT" | grep -qi "401\|unauthorized\|authentication"; then
        log "WARN" "Stats update failed: authentication error (check STATS_USERNAME/STATS_PASSWORD)"
    elif echo "$STATS_OUTPUT" | grep -qi "404\|not found"; then
        log "WARN" "Stats update failed: API endpoint not found (check BOT_API_URL)"
    else
        log "WARN" "Stats update failed: unknown error"
    fi
    
    log "WARN" "Full error output:"
    echo "$STATS_OUTPUT" | tee -a "$LOG_FILE"
    log "WARN" "Continuing with build using existing stats (if available)..."
    
    # If we have old stats, use them
    if [ "$OLD_STATS_EXISTS" = true ] && [ -n "$OLD_USERS" ] && [ -n "$OLD_FILES" ] && [ -n "$OLD_DATA" ]; then
        log "INFO" "Will use existing stats: $OLD_USERS users, $OLD_FILES files, $OLD_DATA"
    else
        log "WARN" "No existing stats available - site will build without stats in footer"
    fi
fi

# ============================================================================
# SECTION 3: Backup Current Site
# ============================================================================
log_section "Site Backup"

if [ -d "$SITE_DIR" ]; then
    OLD_FILE_COUNT=$(find "$SITE_DIR" -type f 2>/dev/null | wc -l)
    log "INFO" "Backing up current _site directory ($OLD_FILE_COUNT files)..."
    rm -rf "$BACKUP_DIR"
    cp -r "$SITE_DIR" "$BACKUP_DIR" || error_exit $EXIT_BUILD_FAILED "Failed to backup _site directory"
    log "INFO" "Backup created at $BACKUP_DIR"
else
    log "WARN" "No existing _site directory to backup"
fi

# ============================================================================
# SECTION 4: Prepare Build Environment
# ============================================================================
log_section "Build Preparation"

# Ensure bundle is available
if ! command -v bundle &> /dev/null; then
    error_exit $EXIT_BUILD_FAILED "bundle command not found. Please install Ruby and Bundler."
fi

log "INFO" "Bundle found: $(which bundle)"
log "INFO" "Ruby version: $(ruby --version 2>/dev/null || echo 'unknown')"

# Install dependencies if needed
if [ ! -f "$PROJECT_ROOT/Gemfile.lock" ] || [ ! -d "$PROJECT_ROOT/vendor/bundle" ]; then
    log "INFO" "Installing Jekyll dependencies..."
    cd "$PROJECT_ROOT"
    bundle install --path vendor/bundle 2>&1 | tee -a "$LOG_FILE" || {
        log "ERROR" "Failed to install dependencies"
        error_exit $EXIT_BUILD_FAILED "Dependency installation failed"
    }
    log "INFO" "Dependencies installed successfully"
else
    log "INFO" "Jekyll dependencies already installed"
fi

# Create temporary build directory
TEMP_BUILD_DIR=$(mktemp -d -t jekyll-build-XXXXXX)
TEMP_SITE_DIR="$TEMP_BUILD_DIR/_site"
log "INFO" "Using temporary build directory: $TEMP_BUILD_DIR"

# ============================================================================
# SECTION 5: Build Jekyll Site
# ============================================================================
log_section "Jekyll Build"

cd "$PROJECT_ROOT"
BUILD_START_TIME=$(date +%s)
log "INFO" "Starting Jekyll build at $(date '+%Y-%m-%d %H:%M:%S')"
log "INFO" "Build destination: $TEMP_SITE_DIR"

# Build in temp directory
BUILD_OUTPUT=$(bundle exec jekyll build --destination "$TEMP_SITE_DIR" 2>&1)
BUILD_EXIT_CODE=$?
BUILD_END_TIME=$(date +%s)
BUILD_DURATION=$((BUILD_END_TIME - BUILD_START_TIME))

if [ $BUILD_EXIT_CODE -ne 0 ]; then
    log "ERROR" "Jekyll build failed with exit code $BUILD_EXIT_CODE after ${BUILD_DURATION}s"
    log "ERROR" "Build output:"
    echo "$BUILD_OUTPUT" | tee -a "$LOG_FILE"
    rm -rf "$TEMP_BUILD_DIR"
    error_exit $EXIT_BUILD_FAILED "Jekyll build failed"
fi

log "INFO" "Jekyll build completed successfully in ${BUILD_DURATION}s"

# ============================================================================
# SECTION 6: Validate Build Output
# ============================================================================
log_section "Build Validation"

# Check if index.html exists
if [ ! -f "$TEMP_SITE_DIR/index.html" ]; then
    log "ERROR" "Validation failed: index.html not found in build output"
    rm -rf "$TEMP_BUILD_DIR"
    error_exit $EXIT_VALIDATION_FAILED "Build validation failed: missing index.html"
fi
log "INFO" "✓ index.html found"

# Check for critical errors in build output
CRITICAL_ERRORS=$(echo "$BUILD_OUTPUT" | grep -iE "error|fatal|failed" | grep -v "Liquid Warning" | grep -v "Deprecation" || true)
if [ -n "$CRITICAL_ERRORS" ]; then
    log "WARN" "Potential errors detected in build output:"
    echo "$CRITICAL_ERRORS" | while IFS= read -r line; do
        log "WARN" "  $line"
    done
else
    log "INFO" "✓ No critical errors in build output"
fi

# Check that _site directory has content
SITE_FILE_COUNT=$(find "$TEMP_SITE_DIR" -type f 2>/dev/null | wc -l)
if [ "$SITE_FILE_COUNT" -lt 5 ]; then
    log "ERROR" "Validation failed: build output has too few files ($SITE_FILE_COUNT)"
    rm -rf "$TEMP_BUILD_DIR"
    error_exit $EXIT_VALIDATION_FAILED "Build validation failed: insufficient files"
fi
log "INFO" "✓ Build output contains $SITE_FILE_COUNT files"

# Check if stats are in the built site
if grep -q "past 24 hours" "$TEMP_SITE_DIR/index.html" 2>/dev/null; then
    log "INFO" "✓ Stats footer found in built site"
    STATS_IN_SITE=$(grep -oP "(?<=past 24 hours, ).*?(?= amounting)" "$TEMP_SITE_DIR/index.html" 2>/dev/null || echo "")
    if [ -n "$STATS_IN_SITE" ]; then
        log "INFO" "  Stats in site: $STATS_IN_SITE"
    fi
else
    log "WARN" "Stats footer not found in built site (may be normal if stats file doesn't exist)"
fi

log "INFO" "Build validation passed"

# ============================================================================
# SECTION 7: Deploy New Build
# ============================================================================
log_section "Site Deployment"

log "INFO" "Replacing _site directory with new build..."

# Remove old _site
if [ -d "$SITE_DIR" ]; then
    OLD_SIZE=$(du -sh "$SITE_DIR" 2>/dev/null | cut -f1 || echo "unknown")
    log "INFO" "Removing old site directory (size: $OLD_SIZE)..."
    rm -rf "$SITE_DIR"
    log "INFO" "Old site directory removed"
fi

# Move temp build to _site
log "INFO" "Moving new build to _site directory..."
if mv "$TEMP_SITE_DIR" "$SITE_DIR" 2>/dev/null; then
    NEW_SIZE=$(du -sh "$SITE_DIR" 2>/dev/null | cut -f1 || echo "unknown")
    log "INFO" "✓ Site deployed successfully (size: $NEW_SIZE)"
else
    log "ERROR" "Failed to move build to _site directory"
    # Attempt rollback
    if [ -d "$BACKUP_DIR" ]; then
        log "WARN" "Attempting rollback to backup..."
        rm -rf "$SITE_DIR" 2>/dev/null || true
        if cp -r "$BACKUP_DIR" "$SITE_DIR" 2>/dev/null; then
            log "WARN" "Rollback successful - restored from backup"
        else
            log "ERROR" "Rollback also failed!"
        fi
    fi
    rm -rf "$TEMP_BUILD_DIR"
    error_exit $EXIT_BUILD_FAILED "Failed to deploy new build"
fi

# Cleanup temp directory
rm -rf "$TEMP_BUILD_DIR"
log "INFO" "Temporary build directory cleaned up"

# Cleanup old backup (keep only one backup)
if [ -d "$BACKUP_DIR" ]; then
    BACKUP_SIZE=$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1 || echo "unknown")
    log "INFO" "Previous backup kept at $BACKUP_DIR (size: $BACKUP_SIZE)"
fi

# ============================================================================
# SECTION 8: Summary
# ============================================================================
log_section "Update Summary"

log "INFO" "✓ Jekyll site update completed successfully"
log "INFO" ""

# Git update status
if [ "$GIT_UPDATED" = true ] && [ -n "$NEW_COMMIT" ]; then
    log "INFO" "Git: Updated from $CURRENT_COMMIT to $NEW_COMMIT"
    log "INFO" "Remote: $SELECTED_REMOTE"
elif [ -n "$SELECTED_REMOTE" ] && [ -n "$SELECTED_COMMIT" ]; then
    log "INFO" "Git: Already up to date at $CURRENT_COMMIT"
    log "INFO" "Remote: $SELECTED_REMOTE"
else
    log "INFO" "Git: Skipped (no remote available)"
fi

# Stats update status
if [ "$STATS_UPDATE_SUCCESS" = true ]; then
    if [ -n "$NEW_USERS" ] && [ -n "$NEW_FILES" ] && [ -n "$NEW_DATA" ]; then
        log "INFO" "Stats: Updated to $NEW_USERS users, $NEW_FILES files, $NEW_DATA"
    else
        log "INFO" "Stats: Updated successfully"
    fi
else
    if [ "$OLD_STATS_EXISTS" = true ]; then
        log "INFO" "Stats: Update failed, using existing stats ($OLD_USERS users, $OLD_FILES files, $OLD_DATA)"
    else
        log "INFO" "Stats: Update failed, no existing stats available"
    fi
fi

# Build status
log "INFO" "Build: Generated $SITE_FILE_COUNT files in ${BUILD_DURATION}s"
log "INFO" "Site: Deployed to $SITE_DIR"
log "INFO" ""

# Final timestamp
log "INFO" "Update completed at $(date '+%Y-%m-%d %H:%M:%S')"

exit $EXIT_SUCCESS






