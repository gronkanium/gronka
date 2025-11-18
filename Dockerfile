FROM node:20-slim

# Install FFmpeg, Docker CLI, and required dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    ca-certificates \
    curl \
    gnupg \
    lsb-release \
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
RUN npm ci --ignore-scripts

# Copy vite config (needed for webui build)
COPY vite.config.js ./

# Copy application code
COPY src/ ./src/

# Build webui frontend
RUN npm run build:webui

# Remove devDependencies to reduce image size (keep only production deps)
RUN npm prune --production

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

