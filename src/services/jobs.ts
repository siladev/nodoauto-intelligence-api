import type { Db } from '../lib/supabase.js'
import type { Inferencia } from '../lib/anthropic.js'
import type { Database } from '../domain/database.types.js'
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
// El servicio escribe ai.* con service_role (schema oculto). La PWA NUNCA recibe el
// analisis por HTTP: lo lee por api.analisis_caso_v1.
// ─────────────────────────────────────────────────────────────────────────────

export type JobRow = Database['ai']['Tables']['jobs']['Row']

const COLUMNAS_JOB =
  'id, caso_id, tipo, status, modelo_usado, tokens_in, tokens_out, costo_usd, intentos, error, created_at, updated_at, started_at, finished_at'
const COLUMNAS_CASO =
  'id, slug, autor_id, estado_resolucion, titulo, descripcion, reporte_cliente, dtcs, anio, urgencia'
const COLUMNAS_ROUTING =
  'id, tipo_tarea, modelo_preferido, modelo_fallback, presupuesto_usd_dia, max_tokens_out, activo'
const COLUMNAS_MODELO =
  'id, proveedor, model_id, alias, capacidades, costo_in_usd_mtok, costo_out_usd_mtok, contexto_tokens, activo'

const MAX_TOKENS_DEFAULT = 1024
const PG_UNIQUE_VIOLATION = '23505'

export interface ResultadoEncolar {
  job: JobRow
  /** true si el job se creo en esta llamada; false si ya existia (idempotencia). */
  creado: boolean
}

/**
 * Crea (o recupera) el job para (caso_id, tipo). Idempotente: dos llamadas con la
 * misma tupla devuelven el MISMO job, y solo la primera lo marca `creado`.
 */
export async function encolarJob(
  db: Db,
  casoId: string,
  tipo: TipoAnalisis,
): Promise<ResultadoEncolar> {
  const ai = db.schema('ai')

  const existente = await ai
    .from('jobs')
    .select(COLUMNAS_JOB)
    .eq('caso_id', casoId)
    .eq('tipo', tipo)
    .maybeSingle()

  if (existente.error) {
    throw new Error(`Error buscando job: ${existente.error.message}`)
  }
  if (existente.data) {
    return { job: existente.data, creado: false }
  }

  const insertado = await ai
    .from('jobs')
    .insert({ caso_id: casoId, tipo, status: 'pendiente' })
    .select(COLUMNAS_JOB)
    .single()

  if (insertado.error) {
    // Carrera: otro request inserto la misma tupla entre el select y el insert.
    // El UNIQUE(caso_id,tipo) lo frena → recuperamos el job existente (idempotencia).
    if (insertado.error.code === PG_UNIQUE_VIOLATION) {
      const recuperado = await ai
        .from('jobs')
        .select(COLUMNAS_JOB)
        .eq('caso_id', casoId)
        .eq('tipo', tipo)
        .single()
      if (recuperado.error) {
        throw new Error(`Error recuperando job en carrera: ${recuperado.error.message}`)
      }
      return { job: recuperado.data, creado: false }
    }
    throw new Error(`Error creando job: ${insertado.error.message}`)
  }

  return { job: insertado.data, creado: true }
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
  const ai = db.schema('ai')
  const log = logger.child({ jobId })

  // 1. Tomar el job SOLO si esta pendiente (evita doble proceso). Transicion atomica
  //    via update condicionado por status.
  const tomado = await ai
    .from('jobs')
    .update({ status: 'procesando', started_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('status', 'pendiente')
    .select('id, caso_id, tipo, intentos')
    .maybeSingle()

  if (tomado.error) {
    log.error({ err: tomado.error.message }, 'No se pudo tomar el job')
    return { status: 'omitido' }
  }
  if (!tomado.data) {
    // Ya estaba tomado/cerrado por otro worker: no es un error.
    log.info('Job no pendiente; omitido')
    return { status: 'omitido' }
  }

  const { caso_id: casoId, tipo, intentos } = tomado.data

  try {
    // 2. Caso (columnas explicitas) para el prompt.
    const casoRes = await db.from('casos').select(COLUMNAS_CASO).eq('id', casoId).single()
    if (casoRes.error) throw new Error(`Caso ilegible: ${casoRes.error.message}`)
    const caso = casoRes.data as CasoRow

    // 3. Routing en datos: elegir modelo por tipo de tarea.
    const [routingRes, modelosRes] = await Promise.all([
      ai.from('routing').select(COLUMNAS_ROUTING).eq('activo', true),
      ai.from('modelos').select(COLUMNAS_MODELO),
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

    // 6. Escribir el resultado EN VIVO (uno vigente por caso → UPSERT por caso_id).
    const upsert = await ai
      .from('analisis_caso')
      .upsert(
        {
          caso_id: casoId,
          job_id: jobId,
          resumen: analisis.resumen,
          diagnostico: analisis.diagnostico,
          severidad: analisis.severidad,
          confianza: analisis.confianza,
          hallazgos: analisis.hallazgos,
          modelo_usado: elegido.modelo.id,
          tokens_total: tokensTotal,
        },
        { onConflict: 'caso_id' },
      )
    if (upsert.error) throw new Error(`No se pudo guardar el analisis: ${upsert.error.message}`)

    // 7. Cerrar el job en `listo` con costo/tokens/modelo.
    const cierre = await ai
      .from('jobs')
      .update({
        status: 'listo',
        modelo_usado: elegido.modelo.id,
        tokens_in: salida.tokensIn,
        tokens_out: salida.tokensOut,
        costo_usd: costo,
        error: null,
        finished_at: new Date().toISOString(),
      })
      .eq('id', jobId)
    if (cierre.error) throw new Error(`No se pudo cerrar el job: ${cierre.error.message}`)

    log.info(
      { modelo: elegido.modelo.alias, usoFallback: elegido.usoFallback, tokensTotal, costo },
      'Analisis listo',
    )
    return { status: 'listo' }
  } catch (err) {
    // Detalle del fallo → server-side (ai.jobs.error + log). Nunca crudo al cliente.
    const motivo = err instanceof Error ? err.message : 'error desconocido'
    log.error({ err: motivo, intentos: intentos + 1 }, 'Job fallido')
    await ai
      .from('jobs')
      .update({
        status: 'fallido',
        intentos: intentos + 1,
        error: motivo.slice(0, 2000),
        finished_at: new Date().toISOString(),
      })
      .eq('id', jobId)
    return { status: 'fallido' }
  }
}
