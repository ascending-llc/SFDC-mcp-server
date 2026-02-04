# Builder stage
FROM node:20-bullseye AS build

WORKDIR /app

# Match repo's Yarn 1.x usage
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare yarn@1.22.22 --activate

# Copy everything first (yarn needs full context with frozen-lockfile)
COPY . /app

# Install dependencies with frozen lockfile
# Version conflicts resolved - all packages now use vitest 4.0.14
RUN yarn install --frozen-lockfile

# Build all packages
RUN yarn workspaces run clean || true
RUN yarn workspaces run build

# Runtime stage
FROM node:20-slim

WORKDIR /app
ENV NODE_ENV=production \
    SF_MCP_HTTP_HOST=0.0.0.0 \
    SF_MCP_HTTP_PORT=3336 \
    PATH="/app/node_modules/.bin:/app/packages/mcp/node_modules/.bin:${PATH}"

# Create non-root user and copy artifacts
RUN groupadd -r app && useradd -r -g app -d /app app
COPY --from=build --chown=app:app /app /app

# Create writable directories for Salesforce SDK (OAuth-only mode)
# The SDK tries to create these directories for logging, state, and cache
# Even though we use chdir shim, SDK initialization needs these paths
RUN mkdir -p /app/.sf /app/.sfdx /app/.cache && \
    chown -R app:app /app/.sf /app/.sfdx /app/.cache

# Set Salesforce SDK environment variables to use writable locations
ENV SF_HOME=/app/.sf \
    SFDX_HOME=/app/.sfdx \
    SF_CACHE_DIR=/app/.cache \
    SF_LOGIN_URL=https://login.salesforce.com

USER app
EXPOSE 3336

ENTRYPOINT ["node", "packages/mcp/bin/run.js"]
# Default: OAuth-only HTTP mode for LibreChat integration
# Override flags at `docker run` if needed
CMD ["--transport", "http", \
     "--http-host", "0.0.0.0", \
     "--http-port", "3336", \
     "--toolsets", "all", \
     "--orgs", "ALLOW_ALL_ORGS", \
     "--no-telemetry"]
