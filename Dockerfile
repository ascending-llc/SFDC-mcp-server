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

# Create Salesforce CLI config directory with proper permissions
RUN mkdir -p /app/.sf && chown -R app:app /app/.sf

USER app
EXPOSE 3336

ENTRYPOINT ["node", "packages/mcp/bin/run.js"]
# Provide sensible defaults; override flags at `docker run`
CMD ["--help"]
