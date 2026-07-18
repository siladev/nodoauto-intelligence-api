import type { Db } from '../lib/supabase.js'
import type { Inferencia } from '../lib/anthropic.js'
import type { Database, Json } from '../domain/database.types.js'
import { aliasDeBenchmark, type TipoJob } from '../domain/schemas.js'
import { resolverModelo, RoutingError, type ModeloRow, type RoutingRow } from '../domain/routing.js'
import { armarPrompt, parsearAnalisis, calcularCosto, type CasoRow } from '../domain/analisis.js'
import { normalizarGrounding, type GroundingPayload } from '../domain/grounding.js'
import { elegirTipoTarea } from '../domain/tiering.js'
import { logger } from '../lib/logger.js'

// ─────────────────────────────────────────────────────────────────────────────
// Cola y procesamiento de jobs de analisis (caja negra, ADR-005 §3).
//
//   encolarJob   → IDEMPOTENTE por (caso_id, tipo): un retry del POST /v1/analizar
//                  NO duplica trabajo. Si ya existe el job, lo devuelve tal cual.
//   reencolarJob → RE-ANALISIS controlado: resetea el job a `pendiente` (salvo que este
//                  `procesando`) para reintentar un `fallido` o re-correr un `listo`.
//                  Tambien es la via de ENCOLADO del benchmark (ADR-008 §3: cada
//                  comando re-corre la tupla (caso_id, 'benchmark:<alias>')).
//   procesarJob  → pre-vuelo (grounding → tiering → routing → PRESUPUESTO), toma el
//                  job `pendiente`, infiere, valida y guarda. Maquina de estados:
//                  pendiente → procesando → listo | fallido. Si el techo diario esta
//                  alcanzado, el job QUEDA `pendiente` (degradacion visible, DEC-029).
//
// ACCESO A `ai` (OCULTO a PostgREST, ADR-006 §7): el servicio NO toca ai.* directo por
// PostgREST (daria PGRST106). Pasa SIEMPRE por los contratos de escritura
// api.analisis_*_v1 (migs 108/111/155): wrappers invoker → puentes private SECURITY
// DEFINER que escriben/leen ai con privilegio. La lectura de public.casos sigue siendo
// directa. La PWA NUNCA recibe el analisis por HTTP: lo lee por api.analisis_caso_v1.
//
// IDENTIDAD DEL JOB ≠ TIPO DE TAREA DEL ROUTING (invariante ADR-008 §4): el tiering
// elige 'analisis_caso' | 'analisis_caso_complejo' SOLO para resolver la fila de
// routing (modelo/techo/max_tokens). El tipo del JOB no cambia nunca aca: sigue
// siendo 'analisis_caso' (o 'benchmark:<alias>').
// ─────────────────────────────────────────────────────────────────────────────

export type JobRow = Database['ai']['Tables']['jobs']['Row']

const COLUMNAS_CASO =
  'id, slug, autor_id, estado_resolucion, titulo, descripcion, reporte_cliente, dtcs, anio, urgencia'

// Fallback SOLO si la fila de routing tiene max_tokens_out NULL. 4096, jamas 1024:
// la mig 110 documento que 1024 TRUNCA el JSON del analisis y el job cae a `fallido`
// (bug real, caso d6adcf00). max_tokens es techo, no objetivo: no encarece.
const MAX_TOKENS_FALLBACK = 4096

export interface ResultadoEncolar {
  job: JobRow
  /** true si el job se creo en esta llamada; false si ya existia (idempotencia). */
  creado: boolean
}

/**
 * Crea (o recupera) el job para (caso_id, tipo). Idempotente: dos llamadas con la
 * misma tupla devuelven el MISMO job, y solo la primera lo marca `creado`. La
 * idempotencia (ON CONFLICT) y la carrera viven en el contrato SQL (mig 108).
 */
export async function encolarJob(
  db: Db,
  casoId: string,
  tipo: TipoJob,
): Promise<ResultadoEncolar> {
  const { data, error } = await db
    .schema('api')
    .rpc('analisis_encolar_job_v1', { p_caso_id: casoId, p_tipo: tipo })

  if (error) {
    throw new Error(`Error encolando job: ${error.message}`)
  }
  const fila = Array.isArray(data) ? data[0] : undefined
  if (!fila) {
    throw new Error('Encolar job no devolvio fila')
  }
  const { creado, ...job } = fila
  return { job, creado }
}

export interface ResultadoReencolar {
  job: JobRow
  /**
   * true si el job quedo `pendiente` para (re)procesar — porque no existia o porque se
   * reseteo desde `pendiente`/`listo`/`fallido`. false si estaba `procesando` (no-op: no
   * se pisa un job en vuelo), en cuyo caso `job` es el job tal cual, sin tocar.
   */
  reencolado: boolean
}

/**
 * RE-ANALISIS controlado (ADR-006): re-encola el job de (caso_id, tipo) para volver a
 * procesarlo. Si no existe, lo crea. Si existe y NO esta `procesando`, lo resetea a
 * `pendiente` (limpia error/tiempos/metricas, suma `intentos`). Si esta `procesando`,
 * es no-op y devuelve `reencolado: false`. La transicion atomica (un solo
 * INSERT ... ON CONFLICT DO UPDATE ... WHERE status <> 'procesando') vive en el
 * contrato SQL (mig 111); aca solo lo invocamos.
 */
export async function reencolarJob(
  db: Db,
  casoId: string,
  tipo: TipoJob,
): Promise<ResultadoReencolar> {
  const { data, error } = await db
    .schema('api')
    .rpc('analisis_reencolar_v1', { p_caso_id: casoId, p_tipo: tipo })

  if (error) {
    throw new Error(`Error reencolando job: ${error.message}`)
  }
  const fila = Array.isArray(data) ? data[0] : undefined
  if (!fila) {
    throw new Error('Reencolar job no devolvio fila')
  }
  const { reencolado, ...job } = fila
  return { job, reencolado }
}

/**
 * Identidad minima del job a procesar. La provee el caller (que ya tiene la fila del
 * encolado): permite correr el PRE-VUELO — grounding, tiering y guard de presupuesto —
 * ANTES de tomar el job. No existe contrato para "soltar" un job `procesando`, asi que
 * si el techo diario esta alcanzado el job directamente NI SE TOMA (queda `pendiente`,
 * DEC-029: degradacion visible como "en cola", nunca `fallido` por presupuesto).
 */
export type JobPendiente = Pick<JobRow, 'id' | 'caso_id' | 'tipo'>

export type EstadoProcesamiento = 'listo' | 'fallido' | 'omitido' | 'pendiente'

/**
 * Procesa un job de punta a punta. No lanza: cierra el job en `listo` o `fallido`
 * (con motivo server-side), lo deja `pendiente` si el techo diario de presupuesto
 * esta alcanzado, u `omitido` si otro worker ya lo tenia. Pensado para ejecutarse
 * en background tras responder 202.
 */
export async function procesarJob(
  db: Db,
  inferir: Inferencia,
  job: JobPendiente,
): Promise<{ status: EstadoProcesamiento }> {
  const api = db.schema('api')
  const log = logger.child({ jobId: job.id })
  const aliasForzado = aliasDeBenchmark(job.tipo)

  // Cierra en `fallido` un job que fallo en el PRE-VUELO: primero hay que tomarlo
  // (transicion atomica) — si ya no esta `pendiente` (otro worker lo tiene o ya
  // cerro), no se pisa nada y se omite.
  async function fallarPreVuelo(motivo: string): Promise<{ status: EstadoProcesamiento }> {
    const tomado = await api.rpc('analisis_tomar_job_v1', { p_job_id: job.id })
    const fila = !tomado.error && Array.isArray(tomado.data) ? tomado.data[0] : undefined
    if (!fila) {
      log.error({ err: motivo }, 'Pre-vuelo fallido sobre un job no pendiente; omitido')
      return { status: 'omitido' }
    }
    log.error({ err: motivo, intentos: fila.intentos + 1 }, 'Job fallido (pre-vuelo)')
    await api.rpc('analisis_fallar_job_v1', {
      p_job_id: job.id,
      p_intentos: fila.intentos + 1,
      p_error: motivo,
    })
    return { status: 'fallido' }
  }

  // ── PRE-VUELO (solo lecturas; el job sigue `pendiente`, sin gastar) ──────────
  let caso: CasoRow
  let grounding: GroundingPayload | null
  let modelo: ModeloRow
  let routing: RoutingRow
  let usoFallback = false
  let tipoTarea: string
  try {
    // 1. Caso (columnas explicitas) para el prompt. public.casos = lectura directa.
    const casoRes = await db.from('casos').select(COLUMNAS_CASO).eq('id', job.caso_id).single()
    if (casoRes.error) throw new Error(`Caso ilegible: ${casoRes.error.message}`)
    caso = casoRes.data as CasoRow

    // 2. GROUNDING V2 (DEC-029): el paquete de anclaje completo en UNA llamada.
    const groundingRes = await api.rpc('analisis_grounding_v1', { p_caso_id: job.caso_id })
    if (groundingRes.error) throw new Error(`Grounding ilegible: ${groundingRes.error.message}`)
    grounding = normalizarGrounding(groundingRes.data)

    // 3. TIERING → tipo de TAREA del routing (el tipo del JOB no cambia, ADR-008 §4).
    tipoTarea = elegirTipoTarea(grounding)

    // 4. Routing en datos: fila del tipo de tarea + catalogo de modelos.
    const [routingRes, modelosRes] = await Promise.all([
      api.rpc('analisis_routing_v1', { p_tipo_tarea: tipoTarea }),
      api.rpc('analisis_modelos_v1', {}),
    ])
    if (routingRes.error) throw new Error(`Routing ilegible: ${routingRes.error.message}`)
    if (modelosRes.error) throw new Error(`Modelos ilegibles: ${modelosRes.error.message}`)
    const modelos = (modelosRes.data ?? []) as ModeloRow[]
    const routings = (routingRes.data ?? []) as RoutingRow[]

    if (aliasForzado !== null) {
      // BENCHMARK (ADR-008 §3): modelo FORZADO por alias, validado contra el
      // catalogo (activo). El routing sigue siendo el del tipo de tarea que el
      // tiering hubiera elegido — mismo max_tokens y mismo techo de presupuesto —
      // pero sin exigir preferido/fallback activos (el modelo lo pone el alias).
      const filaRouting = routings.find((r) => r.tipo_tarea === tipoTarea && r.activo)
      if (!filaRouting) {
        throw new RoutingError(`Sin routing activo para tipo_tarea="${tipoTarea}"`)
      }
      routing = filaRouting
      const forzado = modelos.find((m) => m.alias === aliasForzado && m.activo)
      if (!forzado) {
        throw new Error(
          `Benchmark con alias de modelo invalido o inactivo: "${aliasForzado}" (no esta en ai.modelos activos)`,
        )
      }
      modelo = forzado
    } else {
      const elegido = resolverModelo(tipoTarea, routings, modelos)
      routing = elegido.routing
      modelo = elegido.modelo
      usoFallback = elegido.usoFallback
    }

    // 5. GUARD DE PRESUPUESTO (DEC-029): techo diario en DATOS, consultado ANTES
    //    de tomar el job e inferir. Techo alcanzado → el job QUEDA `pendiente`.
    const presupuestoRes = await api.rpc('analisis_presupuesto_v1', { p_tipo_tarea: tipoTarea })
    if (presupuestoRes.error) {
      throw new Error(`Presupuesto ilegible: ${presupuestoRes.error.message}`)
    }
    const presupuesto = Array.isArray(presupuestoRes.data) ? presupuestoRes.data[0] : undefined
    if (!presupuesto) {
      // 0 filas = sin routing activo para el tipo (mismo criterio que resolverModelo).
      throw new RoutingError(`Sin presupuesto de routing activo para tipo_tarea="${tipoTarea}"`)
    }
    if (presupuesto.techo_alcanzado) {
      log.warn(
        {
          tipoTarea,
          gastadoHoy: presupuesto.gastado_hoy,
          presupuestoUsdDia: presupuesto.presupuesto_usd_dia,
        },
        'Techo diario de presupuesto alcanzado: el job queda pendiente (sin gasto)',
      )
      return { status: 'pendiente' }
    }
  } catch (err) {
    const motivo = err instanceof Error ? err.message : 'error desconocido'
    return fallarPreVuelo(motivo)
  }

  // ── TOMAR el job (transicion atomica pendiente → procesando, contrato mig 108) ──
  const tomado = await api.rpc('analisis_tomar_job_v1', { p_job_id: job.id })
  if (tomado.error) {
    log.error({ err: tomado.error.message }, 'No se pudo tomar el job')
    return { status: 'omitido' }
  }
  const enVuelo = Array.isArray(tomado.data) ? tomado.data[0] : undefined
  if (!enVuelo) {
    // Ya estaba tomado/cerrado por otro worker: no es un error.
    log.info('Job no pendiente; omitido')
    return { status: 'omitido' }
  }
  const { intentos } = enVuelo

  try {
    // 6. Inferencia (caja negra) con el prompt anclado.
    const maxTokens = routing.max_tokens_out ?? MAX_TOKENS_FALLBACK
    const { system, user } = armarPrompt(caso, grounding)
    const salida = await inferir({ modelId: modelo.model_id, system, user, maxTokens })

    // 7. Validar la respuesta antes de persistir (nunca guardamos basura).
    const analisis = parsearAnalisis(salida.texto)
    const tokensTotal = salida.tokensIn + salida.tokensOut
    const costo = calcularCosto(modelo, salida.tokensIn, salida.tokensOut)

    // 8. Guardar + cerrar el job en `listo`, ATOMICO (una funcion SQL). El BENCHMARK
    //    va a ai.benchmarks (mig 155) y JAMAS a analisis_guardar_v1: el analisis
    //    vigente del caso no se pisa desde una corrida comparativa (ADR-008 §3).
    if (aliasForzado !== null) {
      const guardado = await api.rpc('intel_benchmark_guardar_v1', {
        p_job_id: job.id,
        p_caso_id: job.caso_id,
        p_modelo: modelo.id,
        p_resumen: analisis.resumen,
        p_diagnostico: analisis.diagnostico,
        p_severidad: analisis.severidad,
        p_confianza: analisis.confianza,
        p_hallazgos: analisis.hallazgos as Json,
        p_tokens_in: salida.tokensIn,
        p_tokens_out: salida.tokensOut,
        p_costo_usd: costo,
      })
      if (guardado.error) {
        throw new Error(`No se pudo guardar el benchmark: ${guardado.error.message}`)
      }
    } else {
      const guardado = await api.rpc('analisis_guardar_v1', {
        p_job_id: job.id,
        p_caso_id: job.caso_id,
        p_resumen: analisis.resumen,
        p_diagnostico: analisis.diagnostico,
        p_severidad: analisis.severidad,
        p_confianza: analisis.confianza,
        p_hallazgos: analisis.hallazgos as Json,
        p_modelo_usado: modelo.id,
        p_tokens_total: tokensTotal,
        p_tokens_in: salida.tokensIn,
        p_tokens_out: salida.tokensOut,
        p_costo_usd: costo,
      })
      if (guardado.error) {
        throw new Error(`No se pudo guardar el analisis: ${guardado.error.message}`)
      }
    }

    log.info(
      {
        modelo: modelo.alias,
        tipoTarea,
        benchmark: aliasForzado !== null,
        usoFallback,
        tokensTotal,
        costo,
      },
      aliasForzado !== null ? 'Benchmark listo' : 'Analisis listo',
    )
    return { status: 'listo' }
  } catch (err) {
    // Detalle del fallo → server-side (ai.jobs.error + log). Nunca crudo al cliente.
    const motivo = err instanceof Error ? err.message : 'error desconocido'
    log.error({ err: motivo, intentos: intentos + 1 }, 'Job fallido')
    await api.rpc('analisis_fallar_job_v1', {
      p_job_id: job.id,
      p_intentos: intentos + 1,
      p_error: motivo,
    })
    return { status: 'fallido' }
  }
}
