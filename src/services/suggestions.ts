import { z } from 'zod'
import type { Db } from '../lib/supabase.js'
import type { Database } from '../domain/database.types.js'
import { logger } from '../lib/logger.js'

// ─────────────────────────────────────────────────────────────────────────────
// Camino de PROPUESTAS (loops 2/3: contenido / codigo). ADR-005 §9 / §14:
// Intelligence DETECTA y PROPONE, NUNCA aplica. Este modulo SOLO escribe una fila
// en ai.suggestions con evidencia; el cambio entra al embudo: triage de Silvina
// (vault C-XX/S-XX) → gates del repo dueño → prod → verificacion por metrica.
//
// NO hay aqui —ni habra en el runtime— ninguna ruta que aplique un cambio de codigo
// o contenido. Por eso este es el unico export: registrar la propuesta.
//
// DIENTE §9 "sin evidencia no entra al triage": se exige evidencia NO vacia en el
// schema (espeja el CHECK jsonb_array_length(evidencia) > 0 de la migracion 104).
// ─────────────────────────────────────────────────────────────────────────────

export type SuggestionInsert = Database['ai']['Tables']['suggestions']['Insert']

export const PropuestaSchema = z.object({
  tipo: z.enum(['contenido', 'codigo']),
  origen: z.string().min(1).max(120),
  problema: z.string().min(1).max(4000),
  // Sin evidencia no entra al triage (ADR-005 §9): al menos 1 item.
  evidencia: z.array(z.unknown()).min(1, 'La propuesta requiere evidencia'),
  cambio_sugerido: z.string().min(1).max(4000),
  dueno: z
    .enum(['nodoauto-app', 'nodoauto-database', 'intelligence', 'contenido'])
    .optional(),
  metrica_esperada: z.string().max(500).optional(),
  impacto_esperado: z.string().max(2000).optional(),
})

export type Propuesta = z.infer<typeof PropuestaSchema>

/**
 * Registra una propuesta de mejora en ai.suggestions (estado 'nueva'). Valida la
 * evidencia (no vacia) antes de tocar la DB. NO aplica ningun cambio.
 */
export async function registrarPropuesta(db: Db, entrada: Propuesta): Promise<{ id: string }> {
  const p = PropuestaSchema.parse(entrada)

  const insert: SuggestionInsert = {
    tipo: p.tipo,
    origen: p.origen,
    problema: p.problema,
    evidencia: p.evidencia as Database['ai']['Tables']['suggestions']['Insert']['evidencia'],
    cambio_sugerido: p.cambio_sugerido,
    dueno: p.dueno ?? null,
    metrica_esperada: p.metrica_esperada ?? null,
    impacto_esperado: p.impacto_esperado ?? null,
  }

  const { data, error } = await db
    .schema('ai')
    .from('suggestions')
    .insert(insert)
    .select('id')
    .single()

  if (error) {
    throw new Error(`No se pudo registrar la propuesta: ${error.message}`)
  }
  logger.info({ suggestionId: data.id, tipo: p.tipo, origen: p.origen }, 'Propuesta registrada')
  return { id: data.id }
}
