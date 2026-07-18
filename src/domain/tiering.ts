import type { GroundingPayload } from './grounding.js'

// ─────────────────────────────────────────────────────────────────────────────
// TIERING → tipo de TAREA del routing (F4.b, DEC-029 §2.3). Funcion PURA portada
// de la base $0 de la PWA (nodoauto-app src/lib/ia/tiering.ts), con una diferencia
// clave: aca NO se elige un model_id (eso seria hardcodear costo, ADR-006 §1) sino
// el TIPO DE TAREA de ai.routing — que modelo/techo/max_tokens corresponde a cada
// tipo vive en DATOS y se calibra desde el cockpit, no con un deploy.
//
// Filosofia de costo: el grounding hace el trabajo pesado, asi que el tipo default
// ('analisis_caso' → seed haiku) alcanza; solo se ESCALA ('analisis_caso_complejo'
// → seed sonnet) cuando el caso es genuinamente dificil de razonar: sin ningun dato
// duro que lo aterrice, o interaccion multi-sistema (muchos DTC a la vez).
//
// ⚠️ INVARIANTE (ADR-008 §4): esto decide SOLO que fila de routing usar. El TIPO
// DEL JOB sigue siendo 'analisis_caso' (o 'benchmark:<alias>') — jamas se crea un
// job tipo 'analisis_caso_complejo' (romperia la vista 106 y la cuota).
// ─────────────────────────────────────────────────────────────────────────────

/** Tipo de tarea default: barato. Alcanza cuando el grounding aporta datos duros. */
export const TIPO_TAREA_DEFAULT = 'analisis_caso'

/** Tipo de tarea escalado: para casos sin anclaje o multi-sistema. */
export const TIPO_TAREA_ESCALADO = 'analisis_caso_complejo'

/** A partir de cuantos codigos a la vez se considera el caso "multi-sistema". */
export const UMBRAL_DTCS_DIFICIL = 3

/**
 * Elige el tipo de tarea del routing. Escala cuando:
 *  - No hay NINGUN dato duro (ni glosario ni precedentes) → el modelo razona de cero.
 *    Grounding null (caso sin paquete de anclaje) cuenta como "sin datos".
 *  - Hay muchos codigos a la vez → ordenar la interaccion multi-sistema es mas dificil.
 * En cualquier otro caso, el tipo default alcanza.
 */
export function elegirTipoTarea(grounding: GroundingPayload | null): string {
  const hayConocimiento = (grounding?.glosario.length ?? 0) > 0
  const hayPrecedentes = (grounding?.precedentes.length ?? 0) > 0
  const numDtcs = grounding?.caso.dtcs.length ?? 0

  if (!hayConocimiento && !hayPrecedentes) return TIPO_TAREA_ESCALADO
  if (numDtcs >= UMBRAL_DTCS_DIFICIL) return TIPO_TAREA_ESCALADO
  return TIPO_TAREA_DEFAULT
}
