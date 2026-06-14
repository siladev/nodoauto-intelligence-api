# nodoauto-intelligence-api — imagen de produccion para Coolify (como la PWA, ADR-004).
# Node 24.12 LTS pinneado. Multi-stage: build con devDeps, runtime solo con prod deps.

# ---- build ----
FROM node:24.12.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- prod deps ----
FROM node:24.12.0-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:24.12.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Usuario no-root (la imagen base trae `node`).
COPY --chown=node:node package.json ./
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
USER node
EXPOSE 8787
# Healthcheck contra /health (sin auth).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
