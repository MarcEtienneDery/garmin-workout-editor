# MCP server (Streamable HTTP) for garmin-workout-editor.
# Secrets, plans and data are NOT baked in: mount them at /config, /plans and /data.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=8787 \
    GARMIN_PROFILES_DIR=/config \
    GARMIN_DATA_DIR=/data \
    WORKOUT_PLANS_DIR=/plans

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# /data and /plans must be writable by the runtime user (token cache, activities,
# written-back workout IDs); /config only needs to be readable.
RUN mkdir -p /config /data /plans && chown node:node /data /plans
USER node

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/mcp/server.js", "--http"]
