import type { Database } from './database.types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Resolucion de modelo por tipo de tarea. ROUTING EN DATOS, no hardcodeado
// (ADR-006 §1): el servicio LEE ai.routing + ai.modelos y elige; cambiar de modelo
// o de proveedor es una fila, no un deploy. Esta funcion es PURA (recibe las filas
// ya leidas) para poder testearla sin tocar la DB.
//
// Politica (deliberadamente simple, se calibra luego con ai.evals, ADR-006 §1):
//   1. routing del tipo_tarea, activo.
//   2. modelo_preferido si esta activo; si no, modelo_fallback si esta activo.
//   3. si ninguno sirve → error (el job cae a `fallido` con motivo claro).
// ─────────────────────────────────────────────────────────────────────────────

export type ModeloRow = Database['ai']['Tables']['modelos']['Row']
export type RoutingRow = Database['ai']['Tables']['routing']['Row']

export class RoutingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RoutingError'
  }
}

export interface ModeloElegido {
  modelo: ModeloRow
  /** true si se cayo al fallback (preferido inactivo/ausente). Util para telemetria. */
  usoFallback: boolean
  routing: RoutingRow
}

/**
 * Elige el modelo para `tipoTarea` segun las filas de routing/modelos provistas.
 * Lanza RoutingError si no hay ruta activa ni modelo activo disponible.
 */
export function resolverModelo(
  tipoTarea: string,
  routings: readonly RoutingRow[],
  modelos: readonly ModeloRow[],
): ModeloElegido {
  const routing = routings.find((r) => r.tipo_tarea === tipoTarea && r.activo)
  if (!routing) {
    throw new RoutingError(`Sin routing activo para tipo_tarea="${tipoTarea}"`)
  }

  const porId = new Map(modelos.map((m) => [m.id, m]))

  const preferido = porId.get(routing.modelo_preferido)
  if (preferido?.activo) {
    return { modelo: preferido, usoFallback: false, routing }
  }

  const fallback = routing.modelo_fallback ? porId.get(routing.modelo_fallback) : undefined
  if (fallback?.activo) {
    return { modelo: fallback, usoFallback: true, routing }
  }

  throw new RoutingError(
    `Sin modelo activo para tipo_tarea="${tipoTarea}" (preferido y fallback inactivos o ausentes)`,
  )
}
