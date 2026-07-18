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
//
// `reanalizar`: RE-ANALISIS controlado (ADR-006). Por DEFAULT el comando es idempotente
// por (caso_id, tipo): un job ya existente NO se reprocesa (un retry no duplica trabajo).
// Con `reanalizar: true`, si el job existe y NO esta `procesando`, se RE-ENCOLA (vuelve a
// `pendiente`, limpia error/tiempos, suma `intentos`) y se vuelve a procesar — la via para
// reintentar un `fallido` o re-correr un `listo` tras mejorar prompt/modelo. Si esta
// `procesando`, es no-op (no se pisa un job en vuelo). La transicion vive en el contrato
// api.analisis_reencolar_v1 (mig 111); el cliente solo manda el flag.
// ─────────────────────────────────────────────────────────────────────────────

// Tipos de job que el endpoint acepta hoy: el analisis vigente ('analisis_caso')
// o una corrida de BENCHMARK con modelo forzado por alias ('benchmark:<alias>',
// ADR-008 §3 — el MISMO caso corrido con otro modelo SIN pisar el analisis
// vigente; el resultado va a ai.benchmarks). El routing fino vive en datos
// (ai.routing); este patron solo acota la SUPERFICIE del comando.
// Rama unica (no union .or(): quirk de Zod 4 que vuelve opcional la clave, C-80).
export const TIPO_ANALISIS_CASO = 'analisis_caso'
export const PREFIJO_BENCHMARK = 'benchmark:'
const TIPO_JOB_REGEX = /^(analisis_caso|benchmark:[a-z0-9][a-z0-9_-]{0,31})$/

/** Identidad del job (ai.jobs.tipo): 'analisis_caso' | 'benchmark:<alias>'. */
export type TipoJob = string

/**
 * Alias del modelo forzado si el tipo de job es una corrida de benchmark
 * ('benchmark:<alias>'); null para el analisis normal. La validacion del alias
 * contra ai.modelos es del procesamiento (alias invalido = job `fallido`).
 */
export function aliasDeBenchmark(tipo: string): string | null {
  return tipo.startsWith(PREFIJO_BENCHMARK) ? tipo.slice(PREFIJO_BENCHMARK.length) : null
}

export const AnalizarComandoSchema = z
  .object({
    caso_id: z.string().uuid('caso_id debe ser un UUID'),
    tipo: z
      .string()
      .max(42)
      .regex(TIPO_JOB_REGEX, 'tipo debe ser analisis_caso o benchmark:<alias>')
      .default(TIPO_ANALISIS_CASO),
    usuario_id: z.string().uuid('usuario_id debe ser un UUID').optional(),
    reanalizar: z.boolean().default(false),
  })
  .strict()

export type AnalizarComando = z.infer<typeof AnalizarComandoSchema>

// ─────────────────────────────────────────────────────────────────────────────
// Forma del JSON que esperamos del modelo. Se valida con Zod antes de persistir:
// si el modelo devuelve basura, no contaminamos ai.analisis_caso (cae a `fallido`).
// `cita` (F4.b, DEC-029): la fuente del hallazgo ([Manual X, p. N] / [Glosario
// PXXXX] / [Precedente: ...]) — el system prompt la EXIGE; viaja dentro del jsonb
// `hallazgos` existente (sin DDL). Nullable: un hallazgo sin fuente provista debe
// declararse sin cita, no inventarla.
//
// `dtc`: el prompt exige UN solo codigo, pero los modelos a veces devuelven varios
// o texto ("P0101, P0299" — bug real en prod, benchmark sonnet del caso 3776d6e9:
// el analisis entero caia a `fallido` por un campo cosmetico). Normalizacion
// determinista que NO inventa: se extrae el primer codigo OBD-II valido presente;
// sin codigo → null. `.overwrite()` y no `.transform()` (quirk de Zod 4: transform
// vuelve opcional la clave en z.infer — leccion C-80).
// ─────────────────────────────────────────────────────────────────────────────
const DTC_PATRON = /[PBCU][0-9]{4}/i

function normalizarDtc(valor: string | null): string | null {
  if (valor == null) return null
  const match = DTC_PATRON.exec(valor)
  return match ? match[0].toUpperCase() : null
}

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
        dtc: z.string().max(200).nullable().default(null).overwrite(normalizarDtc),
        cita: z.string().max(300).nullable().default(null),
      }),
    )
    .max(10)
    .default([]),
})

export type AnalisisModelo = z.infer<typeof AnalisisModeloSchema>
