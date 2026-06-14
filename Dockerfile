# nodoauto-intelligence-api — imagen de produccion para Coolify (como la PWA, ADR-004).
# Node 24.12 LTS pinneado, base **alpine** (misma que la PWA): un solo estandar en los dos
# repos, imagen chica, y `wget` disponible (busybox) para el healthcheck. Deps JS puras (sin
# modulos nativos) → musl no introduce incompatibilidades. Multi-stage: build con devDeps,
# runtime solo con prod deps.

# ---- build ----
FROM node:24.12.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- prod deps ----
FROM node:24.12.0-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:24.12.0-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Usuario no-root (la imagen base trae `node`).
COPY --chown=node:node package.json ./
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
USER node
EXPOSE 8787
# Healthcheck contra /health (sin auth). Mismo patron que la PWA: wget de busybox (alpine).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["node", "dist/server.js"]
