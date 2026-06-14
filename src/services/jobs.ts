import type { Db } from '../lib/supabase.js'
import type { Inferencia } from '../lib/anthropic.js'
import type { Database, Json } from '../domain/database.types.js'
import type { TipoAnalisis } from '../domain/schemas.js'
import { resolverModelo, type ModeloRow, type RoutingRow } from '../domain/routing.js'
import { armarPrompt, parsearAnalisis, calcularCosto, type CasoRow } from '../domain/analisis.js'
import { logger } from '../lib/logger.js'

// ─────────────────────────────────────────────────────────────────────────────
// Cola y procesamiento de jobs de analisis (caja negra, ADR-005 §3).
//
//   encolarJob   → IDEMPOTENTE por (caso_id, tipo): un retry del POST /v1/analizar
//                  NO duplica trabajo. Si ya existe el job, lo devuelve tal cual.
//   procesarJob  → toma un job `pendiente`, elige modelo por ai.routing, infiere,
//                  valida, escribe ai.analisis_caso + cierra el job en `listo`
//                  (o `fallido` con motivo server-side). Maquina de estados:
//                  pendiente → procesando → listo | fallido.
//
// ACCESO A `ai` (OCULTO a PostgREST, ADR-006 §7): el servicio NO toca ai.* directo por
// PostgREST (daria PGRST106). Pasa SIEMPRE por los contratos de escritura
// api.analisis_*_v1 (mig 108): wrappers invoker → puentes private SECURITY DEFINER que
// escriben/leen ai con privilegio. La lectura de public.casos sigue siendo directa.
// La PWA NUNCA recibe el analisis por HTTP: lo lee por api.analisis_caso_v1.
// ─────────────────────────────────────────────────────────────────────────────

export type JobRow = Database['ai']['Tables']['jobs']['Row']

const COLUMNAS_CASO =
  'id, slug, autor_id, estado_resolucion, titulo, descripcion, reporte_cliente, dtcs, anio, urgencia'

const MAX_TOKENS_DEFAULT = 1024

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
  tipo: TipoAnalisis,
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

/**
 * Procesa un job pendiente de punta a punta. No lanza: cierra el job en `listo` o
 * `fallido` y deja el detalle del error server-side. Pensado para ejecutarse en
 * background tras responder 202.
 */
export async function procesarJob(
  db: Db,
  inferir: Inferencia,
  jobId: string,
): Promise<{ status: 'listo' | 'fallido' | 'omitido' }> {
  const api = db.schema('api')
  const log = logger.child({ jobId })

  // 1. Tomar el job SOLO si esta pendiente (transicion atomica en el contrato SQL).
  const tomado = await api.rpc('analisis_tomar_job_v1', { p_job_id: jobId })

  if (tomado.error) {
    log.error({ err: tomado.error.message }, 'No se pudo tomar el job')
    return { status: 'omitido' }
  }
  const job = Array.isArray(tomado.data) ? tomado.data[0] : undefined
  if (!job) {
    // Ya estaba tomado/cerrado por otro worker: no es un error.
    log.info('Job no pendiente; omitido')
    return { status: 'omitido' }
  }

  const { caso_id: casoId, tipo, intentos } = job

  try {
    // 2. Caso (columnas explicitas) para el prompt. public.casos = lectura directa.
    const casoRes = await db.from('casos').select(COLUMNAS_CASO).eq('id', casoId).single()
    if (casoRes.error) throw new Error(`Caso ilegible: ${casoRes.error.message}`)
    const caso = casoRes.data as CasoRow

    // 3. Routing en datos: elegir modelo por tipo de tarea (resolucion en el servicio).
    const [routingRes, modelosRes] = await Promise.all([
      api.rpc('analisis_routing_v1', { p_tipo_tarea: tipo }),
      api.rpc('analisis_modelos_v1', {}),
    ])
    if (routingRes.error) throw new Error(`Routing ilegible: ${routingRes.error.message}`)
    if (modelosRes.error) throw new Error(`Modelos ilegibles: ${modelosRes.error.message}`)

    const elegido = resolverModelo(
      tipo,
      (routingRes.data ?? []) as RoutingRow[],
      (modelosRes.data ?? []) as ModeloRow[],
    )
    const maxTokens = elegido.routing.max_tokens_out ?? MAX_TOKENS_DEFAULT

    // 4. Inferencia (caja negra).
    const { system, user } = armarPrompt(caso)
    const salida = await inferir({ modelId: elegido.modelo.model_id, system, user, maxTokens })

    // 5. Validar la respuesta antes de persistir (nunca guardamos basura).
    const analisis = parsearAnalisis(salida.texto)
    const tokensTotal = salida.tokensIn + salida.tokensOut
    const costo = calcularCosto(elegido.modelo, salida.tokensIn, salida.tokensOut)

    // 6. Guardar resultado + cerrar el job en `listo`, ATOMICO (una funcion SQL).
    const guardado = await api.rpc('analisis_guardar_v1', {
      p_job_id: jobId,
      p_caso_id: casoId,
      p_resumen: analisis.resumen,
      p_diagnostico: analisis.diagnostico,
      p_severidad: analisis.severidad,
      p_confianza: analisis.confianza,
      p_hallazgos: analisis.hallazgos as Json,
      p_modelo_usado: elegido.modelo.id,
      p_tokens_total: tokensTotal,
      p_tokens_in: salida.tokensIn,
      p_tokens_out: salida.tokensOut,
      p_costo_usd: costo,
    })
    if (guardado.error) throw new Error(`No se pudo guardar el analisis: ${guardado.error.message}`)

    log.info(
      { modelo: elegido.modelo.alias, usoFallback: elegido.usoFallback, tokensTotal, costo },
      'Analisis listo',
    )
    return { status: 'listo' }
  } catch (err) {
    // Detalle del fallo → server-side (ai.jobs.error + log). Nunca crudo al cliente.
    const motivo = err instanceof Error ? err.message : 'error desconocido'
    log.error({ err: motivo, intentos: intentos + 1 }, 'Job fallido')
    await api.rpc('analisis_fallar_job_v1', {
      p_job_id: jobId,
      p_intentos: intentos + 1,
      p_error: motivo,
    })
    return { status: 'fallido' }
  }
}
