import { z } from 'zod'

// ─────────────────────────────────────────────────────────────────────────────
// Contrato de ENTRADA del comando /v1/analizar. Es un COMANDO, no una consulta
// (ADR-005 §3): recibe { caso_id, tipo } y el servicio responde 202 + job_id.
// NUNCA recibe el texto del caso por el cuerpo — el contenido se lee de la DB con
// service_role. Limites estrictos (Zod con max()) en TODO campo (AGENTS §3).
//
// `usuario_id`: id del USUARIO interno (public.usuarios.id) que origina el pedido.
// La PWA lo manda server-side junto al token de servicio. Se usa para re-verificar
// autorizacion contra la DB (defensa en profundidad, ADR-006 §3). Opcional: si no
// viene, el pedido se trata como de SERVICIO (admin/sistema) y solo se exige que el
// caso exista.
// ─────────────────────────────────────────────────────────────────────────────

// Tipos de tarea que el endpoint acepta hoy. El routing fino vive en datos
// (ai.routing); esta lista solo acota la SUPERFICIE del comando.
export const TIPOS_ANALISIS = ['analisis_caso'] as const
export type TipoAnalisis = (typeof TIPOS_ANALISIS)[number]

export const AnalizarComandoSchema = z
  .object({
    caso_id: z.string().uuid('caso_id debe ser un UUID'),
    tipo: z.enum(TIPOS_ANALISIS).default('analisis_caso'),
    usuario_id: z.string().uuid('usuario_id debe ser un UUID').optional(),
  })
  .strict()

export type AnalizarComando = z.infer<typeof AnalizarComandoSchema>

// ─────────────────────────────────────────────────────────────────────────────
// Forma del JSON que esperamos del modelo. Se valida con Zod antes de persistir:
// si el modelo devuelve basura, no contaminamos ai.analisis_caso (cae a `fallido`).
// ─────────────────────────────────────────────────────────────────────────────
export const AnalisisModeloSchema = z.object({
  resumen: z.string().max(2000),
  diagnostico: z.string().max(4000),
  severidad: z.enum(['info', 'media', 'critica']).nullable().default(null),
  confianza: z.number().min(0).max(1).nullable().default(null),
  hallazgos: z
    .array(
      z.object({
        titulo: z.string().max(200),
        detalle: z.string().max(1000),
        dtc: z.string().max(10).nullable().default(null),
      }),
    )
    .max(10)
    .default([]),
})

export type AnalisisModelo = z.infer<typeof AnalisisModeloSchema>
