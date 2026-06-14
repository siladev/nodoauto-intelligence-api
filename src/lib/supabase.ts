import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { loadEnv } from '../config/env.js'
import type { Database } from '../domain/database.types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Cliente Supabase con SERVICE_ROLE. Es el unico modo en que el servicio toca la
// base: escribe `ai.*` (schema OCULTO, sin USAGE para anon/authenticated; solo
// service_role) y LEE `public.casos`/`public.usuarios` para re-verificar autorizacion.
//
// service_role IGNORA RLS — por eso toda mutacion por id ademas filtra por dueño en
// codigo cuando aplica (defensa en profundidad, AGENTS §4). El servicio NUNCA muta
// `public`: cross-domain es solo-lectura (ADR-005 ley 2).
//
// Acceso a `ai`: `db.schema('ai').from('jobs')`. El default del cliente es `public`.
// ─────────────────────────────────────────────────────────────────────────────

export type Db = SupabaseClient<Database>

let cached: Db | null = null

export function getDb(): Db {
  if (cached) return cached
  const env = loadEnv()
  cached = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
  return cached
}
