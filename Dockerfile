# MCP server (Streamable HTTP) and plan editor web UI for garmin-workout-editor.
# One image, two entrypoints: dist/mcp/server.js (default CMD) and dist/web/server.js.
# Secrets and data are NOT baked in: mount them at /config and /data (garmin.db lives in /data).

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev && chmod -R a+rX dist

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=8787 \
    WEB_HOST=0.0.0.0 \
    WEB_PORT=8788 \
    GARMIN_PROFILES_DIR=/config \
    GARMIN_DATA_DIR=/data

# Claude Code, for the Food view's AI box on a Claude plan (FOOD_AI_BACKEND=cli runs `claude -p`: src/shared/foodAiCli.ts). Pinned, because
# that module relies on its flags. It signs in with CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) and keeps its settings in /tmp.
ARG CLAUDE_CODE_VERSION=2.1.310
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force
ENV CLAUDE_CONFIG_DIR=/tmp/claude-config

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# /data must be writable by the runtime user (the database); /config only
# needs to be readable.
RUN mkdir -p /config /data && chown node:node /data
USER node

EXPOSE 8787 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/mcp/server.js", "--http"]
