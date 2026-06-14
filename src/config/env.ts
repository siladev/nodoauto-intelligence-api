import { z } from 'zod'

// ─────────────────────────────────────────────────────────────────────────────
// Carga + validacion de entorno. Es el UNICO punto que lee process.env: el resto
// del codigo importa `env` ya tipado y validado. Asi un secreto faltante revienta
// al arrancar (fail-fast) y no a mitad de un request.
//
// "server-only" en sentido practico: este es un servicio Node — todo es server. No
// existe bundle de cliente al que pueda filtrarse un secreto (a diferencia de la
// PWA, que usa el paquete `server-only`). Aun asi, el unico modulo que lee secretos
// es este; nada los re-exporta crudo.
// ─────────────────────────────────────────────────────────────────────────────

const EnvSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY requerido'),
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY requerido'),
  SERVICE_SHARED_TOKEN: z
    .string()
    .min(16, 'SERVICE_SHARED_TOKEN debe tener al menos 16 caracteres'),
  PORT: z.coerce.number().int().positive().default(8787),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
})

export type Env = z.infer<typeof EnvSchema>

let cached: Env | null = null

/**
 * Devuelve el entorno validado (memoizado). Lanza si falta/es invalido un secreto.
 * Se llama explicitamente al bootstrap (server.ts) para fallar temprano.
 */
export function loadEnv(): Env {
  if (cached) return cached
  const parsed = EnvSchema.safeParse(process.env)
  if (!parsed.success) {
    const detalle = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(raiz)'}: ${i.message}`)
      .join('\n')
    throw new Error(`Entorno invalido:\n${detalle}`)
  }
  cached = parsed.data
  return cached
}

/** Solo para tests: limpia el cache entre casos. */
export function _resetEnvCache(): void {
  cached = null
}
