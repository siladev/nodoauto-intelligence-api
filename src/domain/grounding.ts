import { sanitizeForPrompt } from './sanitize.js'

// ─────────────────────────────────────────────────────────────────────────────
// GROUNDING V2 (F4.b, DEC-029 / ADR-008): el paquete de anclaje del caso llega en
// UNA llamada al contrato api.analisis_grounding_v1 (mig 155) — jsonb con 5 claves
// CONGELADAS: caso / glosario / precedentes / manual / siglas. Este modulo es PURO:
// tipa ese payload (espejo a mano del contrato, como database.types.ts), lo
// normaliza defensivamente y construye los bloques de texto que anclan el prompt.
//
// REGLA ANTI-DOWNGRADE (DEC-029): estos bloques anclan AL MENOS tanto como la base
// $0 de la PWA (src/lib/dtc/grounding.ts de nodoauto-app: glosario DTC + precedentes
// por modelo_id) y SUMAN manual OEM citado (manual + pagina, epica VEH) + siglas de
// arquitectura por combustible. Bloques vacios NO generan texto de relleno.
//
// Todo el contenido viene de la DB (conocimiento curado), pero se pasa igual por
// sanitizeForPrompt antes de interpolar: defensa en profundidad contra inyeccion
// de instrucciones via contenido almacenado (AGENTS §4). El contenido es DATO.
// ─────────────────────────────────────────────────────────────────────────────

export interface GroundingCaso {
  id: string
  modelo_id: string | null
  combustible: string | null
  vehiculo: string | null
  dtcs: string[]
}

export interface GroundingGlosario {
  codigo: string
  nombre_corto: string | null
  descripcion: string | null
  sintomas: string[] | null
  // jsonb del glosario: tolera ambas formas ({causa} | {descripcion}) + porcentaje
  // (mismo criterio que la base $0 de la PWA).
  causas: Array<{ causa?: string; descripcion?: string; porcentaje?: number }> | null
  condiciones_logicas: string | null
  sistema: string | null
}

export interface GroundingPrecedente {
  vehiculo: string
  titulo: string
  solucion: string | null
}

export interface GroundingManual {
  sistema: string | null
  tipo: string | null
  titulo: string | null
  valor: string | null
  contenido: string | null
  pagina_fuente: number | null
  manual_titulo: string | null
  fuente_referencia: string | null
  fuente_edicion: string | null
}

export interface GroundingSigla {
  sigla: string
  nombre_espanol: string | null
  definicion: string | null
}

export interface GroundingPayload {
  caso: GroundingCaso
  glosario: GroundingGlosario[]
  precedentes: GroundingPrecedente[]
  manual: GroundingManual[]
  siglas: GroundingSigla[]
}

function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

/**
 * Normaliza el jsonb del contrato a un payload seguro de recorrer. Caso inexistente
 * (el contrato devuelve NULL) o forma irreconocible → null (el prompt cae a la base
 * sin bloques, y el tiering lo trata como "sin anclaje"). Bloques ausentes → [].
 */
export function normalizarGrounding(data: unknown): GroundingPayload | null {
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return null
  const d = data as Record<string, unknown>
  const caso = d.caso
  if (caso == null || typeof caso !== 'object' || Array.isArray(caso)) return null
  const c = caso as Record<string, unknown>
  return {
    caso: {
      id: typeof c.id === 'string' ? c.id : '',
      modelo_id: typeof c.modelo_id === 'string' ? c.modelo_id : null,
      combustible: typeof c.combustible === 'string' ? c.combustible : null,
      vehiculo: typeof c.vehiculo === 'string' ? c.vehiculo : null,
      dtcs: arr<unknown>(c.dtcs).filter((x): x is string => typeof x === 'string'),
    },
    glosario: arr<GroundingGlosario>(d.glosario),
    precedentes: arr<GroundingPrecedente>(d.precedentes),
    manual: arr<GroundingManual>(d.manual),
    siglas: arr<GroundingSigla>(d.siglas),
  }
}

// Topes de interpolacion por campo (el contrato ya recorta con left() en SQL; estos
// son la segunda capa, alineados a los limites de la mig 155).
const MAX_DESCRIPCION = 800
const MAX_CONDICIONES = 600
const MAX_SOLUCION = 600
const MAX_CONTENIDO = 1200
const MAX_DEFINICION = 400
const MAX_CORTO = 200

function lineaGlosario(k: GroundingGlosario): string {
  const codigo = sanitizeForPrompt(k.codigo, 10)
  const nombre = sanitizeForPrompt(k.nombre_corto, MAX_CORTO)
  const partes = [`• ${codigo}${nombre ? ` (${nombre})` : ''}`]

  const descripcion = sanitizeForPrompt(k.descripcion, MAX_DESCRIPCION)
  if (descripcion) partes.push(`  Definición: ${descripcion}`)

  const sintomas = arr<unknown>(k.sintomas)
    .map((s) => sanitizeForPrompt(s, MAX_CORTO))
    .filter(Boolean)
  if (sintomas.length) partes.push(`  Síntomas típicos: ${sintomas.join('; ')}`)

  const causas = arr<{ causa?: string; descripcion?: string; porcentaje?: number }>(k.causas)
    .map((c) => {
      const texto = sanitizeForPrompt(c?.causa ?? c?.descripcion, MAX_CORTO)
      if (!texto) return ''
      return typeof c?.porcentaje === 'number' ? `${texto} (${c.porcentaje}%)` : texto
    })
    .filter(Boolean)
  if (causas.length) partes.push(`  Causas probables conocidas: ${causas.join(', ')}`)

  const condiciones = sanitizeForPrompt(k.condiciones_logicas, MAX_CONDICIONES)
  if (condiciones) partes.push(`  Condiciones de activación: ${condiciones}`)

  const sistema = sanitizeForPrompt(k.sistema, MAX_CORTO)
  if (sistema) partes.push(`  Sistema: ${sistema}`)
  return partes.join('\n')
}

function lineaPrecedente(p: GroundingPrecedente): string {
  const vehiculo = sanitizeForPrompt(p.vehiculo, MAX_CORTO) || 'Vehículo no especificado'
  const titulo = sanitizeForPrompt(p.titulo, MAX_CORTO)
  const solucion = sanitizeForPrompt(p.solucion, MAX_SOLUCION)
  return `• [${vehiculo}] ${titulo}${solucion ? ` → Solución: ${solucion}` : ''}`
}

function lineaManual(m: GroundingManual): string {
  const sistema = sanitizeForPrompt(m.sistema, MAX_CORTO)
  const titulo = sanitizeForPrompt(m.titulo, MAX_CORTO)
  const valor = sanitizeForPrompt(m.valor, MAX_CORTO)
  const contenido = sanitizeForPrompt(m.contenido, MAX_CONTENIDO)
  const referencia = sanitizeForPrompt(m.fuente_referencia, MAX_CORTO)
  const edicion = sanitizeForPrompt(m.fuente_edicion, MAX_CORTO)
  const manualTitulo = sanitizeForPrompt(m.manual_titulo, MAX_CORTO)
  const pagina = typeof m.pagina_fuente === 'number' ? String(m.pagina_fuente) : ''

  const cuerpo = [valor, contenido].filter(Boolean).join(' — ')
  const fuente = [
    referencia || manualTitulo,
    edicion ? `ed. ${edicion}` : '',
    pagina ? `p. ${pagina}` : '',
  ]
    .filter(Boolean)
    .join(', ')
  return `• [${sistema || 'general'}] ${titulo}${cuerpo ? `: ${cuerpo}` : ''}${fuente ? ` (Fuente: ${fuente})` : ''}`
}

function lineaSigla(s: GroundingSigla): string {
  const sigla = sanitizeForPrompt(s.sigla, 20)
  const nombre = sanitizeForPrompt(s.nombre_espanol, MAX_CORTO)
  const definicion = sanitizeForPrompt(s.definicion, MAX_DEFINICION)
  return `• ${sigla}${nombre ? ` (${nombre})` : ''}${definicion ? `: ${definicion}` : ''}`
}

/**
 * Construye el contexto de anclaje del prompt a partir del payload del contrato.
 * Devuelve '' si no hay nada que anclar (bloques vacios NO generan relleno: la ruta
 * cae al prompt base y el tiering ya escalo el modelo).
 */
export function construirContextoGrounding(grounding: GroundingPayload | null): string {
  if (!grounding) return ''
  const bloques: string[] = []

  if (grounding.glosario.length > 0) {
    bloques.push(
      'DATOS VERIFICADOS DEL GLOSARIO TÉCNICO (base obligatoria: priorizá estas causas, ' +
        'no inventes diagnósticos que las contradigan; citá [Glosario <código>]):\n' +
        grounding.glosario.map(lineaGlosario).join('\n'),
    )
  }

  if (grounding.precedentes.length > 0) {
    bloques.push(
      'CASOS REALES YA RESUELTOS con estos códigos (precedentes verificados de la ' +
        'comunidad; citá [Precedente: <vehículo>]):\n' +
        grounding.precedentes.map(lineaPrecedente).join('\n'),
    )
  }

  if (grounding.manual.length > 0) {
    bloques.push(
      'MANUAL OEM DEL VEHÍCULO (datos oficiales del fabricante; al usarlos citá SIEMPRE ' +
        'manual y página: [Manual <fuente>, p. <página>]):\n' +
        grounding.manual.map(lineaManual).join('\n'),
    )
  }

  if (grounding.siglas.length > 0) {
    bloques.push(
      'ARQUITECTURA DEL VEHÍCULO (siglas del glosario según su combustible; usalas para ' +
        'razonar el sistema correcto):\n' +
        grounding.siglas.map(lineaSigla).join('\n'),
    )
  }

  return bloques.join('\n\n')
}
