FROM node:20-slim

# Install FFmpeg, Docker CLI, and required dependencies
# Also install build tools for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    ca-certificates \
    curl \
    gnupg \
    lsb-release \
    python3 \
    make \
    g++ \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null \
    && apt-get update \
    && apt-get install -y docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for building webui)
# Build native modules (better-sqlite3) after installation
RUN npm ci --ignore-scripts && \
    npm rebuild better-sqlite3

# Copy vite config (needed for webui build)
COPY vite.config.js ./

# Copy application code
COPY src/ ./src/

# Build webui frontend
RUN npm run build:webui

# Remove devDependencies to reduce image size (keep only production deps)
# Note: better-sqlite3 is a production dependency, so its bindings remain after prune
RUN npm prune --production

# Remove build tools to reduce image size (they're no longer needed after native modules are built)
RUN apt-get remove -y python3 make g++ && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

# Create necessary directories
RUN mkdir -p data temp

# Expose server port
EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production
ENV SERVER_PORT=3000
ENV GIF_STORAGE_PATH=./data

# Copy entrypoint script
COPY scripts/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Use entrypoint script to run both processes
ENTRYPOINT ["docker-entrypoint.sh"]

