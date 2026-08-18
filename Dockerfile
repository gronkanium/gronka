# Stage 1: Builder - Install dependencies and build application
FROM oven/bun:1.3-debian AS builder

# Install build tools for native modules
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files for dependency installation
COPY package.json bun.lock ./

# Install all dependencies (including devDependencies for building webui).
# --frozen-lockfile makes a lockfile that drifted from package.json fail the build here
# rather than silently resolving something different from what CI tested.
RUN bun install --frozen-lockfile

# Copy vite config (needed for webui build)
COPY vite.config.js svelte.config.js ./

# Copy application source code
COPY src/ ./src/

# Copy scripts directory (needed for build-webui.js)
COPY scripts/ ./scripts/

# Build webui frontend
RUN bun run build:webui

# Reinstall with production dependencies only, dropping the build toolchain from the tree
# that gets copied into the runtime stage. --ignore-scripts because the "prepare" script runs
# husky, a devDependency that is absent from a production tree (and pointless in a container
# with no .git) - without it this step dies with exit 127.
RUN rm -rf node_modules && bun install --frozen-lockfile --production --ignore-scripts

# Stage 2: Runtime - Minimal production image
FROM oven/bun:1.3-debian AS runtime

# Install runtime dependencies: FFmpeg, gifsicle (GIF optimization), ImageMagick
# (animated-WebP -> GIF; ffmpeg can't demux animated webp), ca-certificates, and yt-dlp.
# yt-dlp-ejs ships the solver script for YouTube's `n` challenge; without it every YouTube
# format is skipped and only storyboards remain.
RUN apt-get update && apt-get install -y \
    ffmpeg \
    gifsicle \
    imagemagick \
    ca-certificates \
    python3 \
    python3-pip \
    && pip3 install --break-system-packages yt-dlp yt-dlp-ejs \
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
COPY --from=builder /app/package.json /app/bun.lock ./

# Create necessary directories
RUN mkdir -p data-prod/gifs data-test/gifs temp

# Copy entrypoint script
COPY scripts/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Expose server ports
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD bun -e "const r = await fetch('http://localhost:3000/health'); process.exit(r.status === 200 ? 0 : 1)"

# Use entrypoint script to run both processes
ENTRYPOINT ["docker-entrypoint.sh"]
