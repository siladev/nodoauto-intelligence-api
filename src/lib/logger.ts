import pino from 'pino'
import { loadEnv } from '../config/env.js'

// Logger estructurado (pino). En produccion sale JSON (lo ingiere Coolify); en dev
// se puede usar pino-pretty. NUNCA loguear secretos ni el cuerpo crudo de un error
// de Postgres hacia afuera — eso se queda server-side (ADR-005 §3 info-disclosure).
const env = loadEnv()

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'SUPABASE_SERVICE_ROLE_KEY',
      'ANTHROPIC_API_KEY',
      'SERVICE_SHARED_TOKEN',
    ],
    censor: '[redacted]',
  },
})

export type Logger = typeof logger
