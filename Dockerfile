# Stage 1: Builder - Install dependencies and build application
FROM node:20-slim AS builder

# Install build tools for native npm modules
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files for dependency installation
COPY package*.json ./

# Install all dependencies (including devDependencies for building webui)
RUN npm ci

# Copy vite config (needed for webui build)
COPY vite.config.js ./

# Copy application source code
COPY src/ ./src/

# Copy scripts directory (needed for build-webui.js)
COPY scripts/ ./scripts/

# Build webui frontend
RUN npm run build:webui

# Remove devDependencies to keep only production dependencies
RUN npm prune --production

# Stage 2: Runtime - Minimal production image
FROM node:20-slim AS runtime

# Copy Docker CLI binary from official Docker image (lightweight alternative to docker-ce-cli)
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker

# Install only runtime dependencies: FFmpeg and ca-certificates
RUN apt-get update && apt-get install -y \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Build arguments for metadata
ARG BUILD_TIMESTAMP
ARG GIT_COMMIT

# Set environment variables
ENV BUILD_TIMESTAMP=${BUILD_TIMESTAMP}
ENV GIT_COMMIT=${GIT_COMMIT}
ENV NODE_ENV=production
ENV SERVER_PORT=3000

# Copy production dependencies from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application code and built webui from builder
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/package*.json ./

# Create necessary directories
RUN mkdir -p data-prod/gifs data-test/gifs temp

# Copy entrypoint script
COPY scripts/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Expose server ports
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Use entrypoint script to run both processes
ENTRYPOINT ["docker-entrypoint.sh"]

