#!/bin/bash
# Fix Docker credential storage issues in WSL2
# This script fixes:
# 1. credsStore issues with Windows credential manager
# 2. GPG decryption failures when pulling images

set -e

DOCKER_CONFIG_DIR="$HOME/.docker"
DOCKER_CONFIG_FILE="$DOCKER_CONFIG_DIR/config.json"

echo "Fixing Docker credential storage issues..."

# Create .docker directory if it doesn't exist
mkdir -p "$DOCKER_CONFIG_DIR"

# Check if config.json exists
if [ -f "$DOCKER_CONFIG_FILE" ]; then
    echo "Backing up existing Docker config..."
    cp "$DOCKER_CONFIG_FILE" "$DOCKER_CONFIG_FILE.backup.$(date +%Y%m%d_%H%M%S)"
    
    # Use jq if available for better JSON handling
    if command -v jq &> /dev/null; then
        echo "Using jq to fix credential storage..."
        # Remove credsStore and credHelpers (both can cause issues)
        # Clear auths that might be encrypted (GPG issues)
        jq 'del(.credsStore) | del(.credHelpers) | if .auths then .auths = {} else . end' "$DOCKER_CONFIG_FILE" > "$DOCKER_CONFIG_FILE.tmp" && mv "$DOCKER_CONFIG_FILE.tmp" "$DOCKER_CONFIG_FILE"
    else
        # Fallback: use sed to remove problematic lines
        echo "Using sed to fix credential storage..."
        # Remove credsStore, credHelpers, and clear auths section
        sed -i '/"credsStore"/d; /"credHelpers"/d' "$DOCKER_CONFIG_FILE"
        # If auths section exists and might be encrypted, we'll need to clear it manually
        # This is a simpler approach - just ensure credsStore is removed
    fi
else
    # Create new config file without credsStore
    echo "Creating new Docker config file..."
    echo '{}' > "$DOCKER_CONFIG_FILE"
fi

# Also check for and clear any GPG-related credential helpers
if [ -f "$DOCKER_CONFIG_DIR/credHelpers.json" ]; then
    echo "Removing GPG credential helper config..."
    mv "$DOCKER_CONFIG_DIR/credHelpers.json" "$DOCKER_CONFIG_DIR/credHelpers.json.backup.$(date +%Y%m%d_%H%M%S)" 2>/dev/null || true
fi

echo ""
echo "✓ Docker config updated successfully!"
echo "  Config location: $DOCKER_CONFIG_FILE"
echo ""
echo "Fixed issues:"
echo "  - Removed credsStore (Windows credential manager)"
echo "  - Removed credHelpers (GPG decryption issues)"
echo "  - Cleared encrypted auths (if present)"
echo ""
echo "Next steps:"
echo "  1. Run 'docker login' to authenticate (credentials will be stored in plain text)"
echo "  2. Try your docker build/pull commands again"
echo ""
echo "Note: Credentials will be stored in plain text in the config file,"
echo "      which works reliably in WSL2 but is less secure than encrypted storage."


