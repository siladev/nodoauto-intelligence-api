// ─────────────────────────────────────────────────────────────────────────────
// Saneo de texto para construir prompts de IA (AGENTS §3 "Inyeccion en IA"). El
// comando /v1/analizar NO recibe texto libre del cliente (solo caso_id + tipo); el
// contenido del caso sale de `public.casos`, ya saneado al escribirse en la PWA.
// Aun asi, antes de interpolar contenido almacenado en el prompt lo normalizamos:
// defensa en profundidad contra inyeccion de instrucciones via contenido guardado.
//
// No usamos `sanitize-html` (no renderizamos HTML, construimos texto): quitamos
// caracteres de control, colapsamos saltos y recortamos / acotamos longitud.
// ─────────────────────────────────────────────────────────────────────────────

// Control chars (excepto \t=0x09 y \n=0x0A) — construido por codigo para no pegar
// bytes de control en el fuente.
const CONTROL_CHARS = new RegExp(
  '[' +
    '\\x00-\\x08' + // antes de \t
    '\\x0B\\x0C' + // entre \n y \r
    '\\x0E-\\x1F' + // resto de C0
    '\\x7F' + // DEL
    ']',
  'g',
)

/** Normaliza un campo de texto para incrustarlo en un prompt. Acota a `max` chars. */
export function sanitizeForPrompt(value: unknown, max = 2000): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    .trim()
    .slice(0, max)
}
