import { Hono } from 'hono'
import { z } from 'zod'
import type { Db } from '../lib/supabase.js'
import { getDb } from '../lib/supabase.js'
import { inferirConAnthropic, type Inferencia } from '../lib/anthropic.js'
import { loadEnv } from '../config/env.js'
import { AnalizarComandoSchema } from '../domain/schemas.js'
import { reVerificarAcceso, AutorizacionError } from '../services/autorizacion.js'
import { encolarJob, reencolarJob, procesarJob } from '../services/jobs.js'
import { logger } from '../lib/logger.js'
import { servicioAuth } from './auth.js'

// ─────────────────────────────────────────────────────────────────────────────
// App HTTP (Hono). Fabrica `createApp(deps)` para poder inyectar dobles en tests
// (db, inferencia, disparo de procesamiento) sin tocar Supabase ni Anthropic.
//
// Contrato HTTP = COMANDOS (ADR-005 §3): /v1/analizar responde 202 + job_id y NUNCA
// devuelve el analisis. El resultado se lee por api.analisis_caso_v1 (la PWA, F4).
// ─────────────────────────────────────────────────────────────────────────────

export interface AppDeps {
  db: Db
  inferir: Inferencia
  /**
   * Dispara el procesamiento del job (fire-and-forget tras el 202). Inyectable para
   * que los tests controlen/observen el background sin condiciones de carrera.
   */
  dispararProcesamiento: (jobId: string) => void
  /** Token de servicio esperado (Bearer). */
  tokenServicio: string
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono()

  // Salud: sin auth, para health checks de Coolify/Traefik.
  app.get('/health', (c) => c.json({ ok: true, servicio: 'nodoauto-intelligence-api' }))

  // Todo /v1/* exige token de servicio.
  app.use('/v1/*', servicioAuth(deps.tokenServicio))

  // ── POST /v1/analizar — COMANDO de analisis ────────────────────────────────
  app.post('/v1/analizar', async (c) => {
    // 1. Validar el comando (limites estrictos; sin texto libre del cliente).
    let comando
    try {
      const body = await c.req.json().catch(() => null)
      comando = AnalizarComandoSchema.parse(body)
    } catch (err) {
      if (err instanceof z.ZodError) {
        return c.json({ error: 'Datos del comando invalidos' }, 400)
      }
      return c.json({ error: 'Cuerpo invalido' }, 400)
    }

    // 2. Re-verificar autorizacion contra la DB (defensa en profundidad).
    try {
      await reVerificarAcceso(deps.db, comando.caso_id, comando.usuario_id)
    } catch (err) {
      if (err instanceof AutorizacionError) {
        const status = err.codigo === 'no_encontrado' ? 404 : 403
        return c.json(
          { error: err.codigo === 'no_encontrado' ? 'Caso no encontrado' : 'Acceso denegado' },
          status,
        )
      }
      // Detalle crudo → server-side; al cliente, generico (AGENTS §3).
      logger.error({ err: err instanceof Error ? err.message : err }, 'Error de autorizacion')
      return c.json({ error: 'Error procesando el comando' }, 500)
    }

    // 3. Encolar idempotente por (caso_id, tipo), o RE-ENCOLAR si el comando pide
    //    re-analisis (resetea el job salvo que este `procesando`). `disparar` indica si
    //    quedo un job `pendiente` para (re)procesar; idempotente = no se hizo trabajo.
    let job
    let disparar: boolean
    try {
      if (comando.reanalizar) {
        const r = await reencolarJob(deps.db, comando.caso_id, comando.tipo)
        job = r.job
        disparar = r.reencolado
      } else {
        const r = await encolarJob(deps.db, comando.caso_id, comando.tipo)
        job = r.job
        disparar = r.creado
      }
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err }, 'Error encolando job')
      return c.json({ error: 'Error procesando el comando' }, 500)
    }

    // 4. Solo dispara procesamiento si quedo un job pendiente (un retry idempotente, o un
    //    reanalizar sobre un job `procesando`, NO reprocesa).
    if (disparar) {
      deps.dispararProcesamiento(job.id)
    }

    // 5. 202 + id. Nunca el analisis (se lee por api.analisis_caso_v1).
    return c.json(
      {
        job_id: job.id,
        status: job.status,
        idempotente: !disparar,
      },
      202,
    )
  })

  return app
}

/** Construye la app con dependencias reales (Supabase + Anthropic). */
export function createDefaultApp(): Hono {
  const env = loadEnv()
  const db = getDb()
  const deps: AppDeps = {
    db,
    inferir: inferirConAnthropic,
    dispararProcesamiento: (jobId) => {
      // Fire-and-forget: el 202 ya salio. Errores se cierran dentro de procesarJob.
      void procesarJob(db, inferirConAnthropic, jobId).catch((err) => {
        logger.error({ err: err instanceof Error ? err.message : err, jobId }, 'Procesamiento sin capturar')
      })
    },
    tokenServicio: env.SERVICE_SHARED_TOKEN,
  }
  return createApp(deps)
}
