import { serve } from '@hono/node-server'
import { loadEnv } from './config/env.js'
import { createDefaultApp } from './http/app.js'
import { logger } from './lib/logger.js'

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap del servicio. Valida el entorno (fail-fast: si falta un secreto, revienta
// aca y no a mitad de un request) y levanta el server HTTP. Pensado para correr en
// Coolify como la PWA (Node 24, ADR-004).
// ─────────────────────────────────────────────────────────────────────────────

function main(): void {
  const env = loadEnv()
  const app = createDefaultApp()

  serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    logger.info({ port: info.port, env: env.NODE_ENV }, 'nodoauto-intelligence-api escuchando')
  })
}

main()
