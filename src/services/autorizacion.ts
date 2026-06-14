import type { Db } from '../lib/supabase.js'
import type { CasoRow } from '../domain/analisis.js'

// ─────────────────────────────────────────────────────────────────────────────
// Re-verificacion de autorizacion contra la DB (defensa en profundidad, ADR-006 §3).
// Aunque la PWA ya valido al crear el caso, Intelligence CONFIRMA contra la base que
// el solicitante puede tocar ese caso ANTES de encolar. No confia en el llamante.
//
// Reglas:
//   · El caso debe existir → si no, NotFound (no encolamos analisis de un fantasma).
//   · Con usuario_id (pedido de usuario): permitido si es AUTOR del caso, o si su rol
//     es admin/moderador. Si no, Forbidden.
//   · Sin usuario_id (pedido de SERVICIO/sistema, p.ej. backfill admin): basta con que
//     el caso exista. El token de servicio ya autentico el server-to-server.
//
// Columnas EXPLICITAS (egress acotado, AGENTS §4): nunca select('*') sobre casos.
// ─────────────────────────────────────────────────────────────────────────────

const ROLES_ELEVADOS = new Set(['admin', 'moderador'])

export type CodigoAutorizacion = 'no_encontrado' | 'prohibido'

export class AutorizacionError extends Error {
  constructor(
    public readonly codigo: CodigoAutorizacion,
    message: string,
  ) {
    super(message)
    this.name = 'AutorizacionError'
  }
}

const COLUMNAS_CASO =
  'id, slug, autor_id, estado_resolucion, titulo, descripcion, reporte_cliente, dtcs, anio, urgencia'

/**
 * Confirma que el solicitante puede analizar el caso y devuelve la fila del caso
 * (para armar el prompt). Lanza AutorizacionError si no existe o no esta permitido.
 */
export async function reVerificarAcceso(
  db: Db,
  casoId: string,
  usuarioId?: string,
): Promise<CasoRow> {
  const { data: caso, error } = await db
    .from('casos')
    .select(COLUMNAS_CASO)
    .eq('id', casoId)
    .maybeSingle()

  if (error) {
    // Detalle crudo de Postgres → server-side; al caller, mensaje generico (AGENTS §3).
    throw new Error(`Error leyendo caso: ${error.message}`)
  }
  if (!caso) {
    throw new AutorizacionError('no_encontrado', 'El caso no existe')
  }

  if (!usuarioId) {
    // Pedido de servicio/sistema: el token ya autentico; basta con que el caso exista.
    return caso
  }

  if (caso.autor_id && caso.autor_id === usuarioId) {
    return caso
  }

  const { data: usuario, error: errUsuario } = await db
    .from('usuarios')
    .select('id, rol')
    .eq('id', usuarioId)
    .maybeSingle()

  if (errUsuario) {
    throw new Error(`Error leyendo usuario: ${errUsuario.message}`)
  }
  if (usuario && usuario.rol && ROLES_ELEVADOS.has(usuario.rol)) {
    return caso
  }

  throw new AutorizacionError(
    'prohibido',
    'El usuario no puede analizar este caso',
  )
}
