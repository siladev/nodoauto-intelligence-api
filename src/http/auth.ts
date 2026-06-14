import { timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'

// ─────────────────────────────────────────────────────────────────────────────
// Auth de SERVICIO server-to-server (ADR-005 §3 / ADR-006 §3). La PWA llama desde
// SU servidor con `Authorization: Bearer <SERVICE_SHARED_TOKEN>`. El browser NUNCA
// conoce este token (vive en un modulo server-only de la PWA): no hay CORS nuevo ni
// sesion de usuario aca. Esto autentica al LLAMANTE (la PWA); la autorizacion del
// caso se re-verifica aparte contra la DB (defensa en profundidad).
//
// Comparacion en tiempo constante (timingSafeEqual) para no filtrar el token por
// timing. Falla cerrado: sin header valido → 401 generico.
// ─────────────────────────────────────────────────────────────────────────────

function tokensCoinciden(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

export function servicioAuth(tokenEsperado: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? ''
    const match = /^Bearer (.+)$/.exec(header)
    if (!match || !tokensCoinciden(match[1], tokenEsperado)) {
      return c.json({ error: 'No autorizado' }, 401)
    }
    await next()
  }
}
