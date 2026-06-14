// ─────────────────────────────────────────────────────────────────────────────
// Tipos de la superficie de datos que ESTE servicio toca. No es el canonico de la
// PWA (`nodoauto-database/generated/database.types.ts`, que tipa solo `public` y NO
// incluye `ai`). Aca se tipa, a mano y acotado, lo que el servicio realmente lee/
// escribe:
//   · public.casos / public.usuarios  → SOLO LECTURA, para re-verificar autorizacion
//     (defensa en profundidad) y armar el prompt. Cross-domain: solo leemos, nunca
//     mutamos `public` (ADR-005 ley 2).
//   · ai.*  → autoria de Intelligence, custodia de nodoauto-database. Lo escribimos
//     con service_role. Espejo de las migraciones 104/106 (campos que usamos).
//
// Si nodoauto-database cambia el esquema `ai`, este espejo se actualiza A MANO contra
// la migracion (database-first: el esquema lo posee el repo-DB; este repo NO crea ni
// altera DDL). Mantener acotado a lo usado: menos superficie, menos drift.
// ─────────────────────────────────────────────────────────────────────────────

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type JobStatus = 'pendiente' | 'procesando' | 'listo' | 'fallido'
export type Severidad = 'info' | 'media' | 'critica'
export type SuggestionTipo = 'contenido' | 'codigo'

export interface Database {
  public: {
    Tables: {
      casos: {
        Row: {
          id: string
          slug: string | null
          autor_id: string | null
          estado_resolucion: string | null
          titulo: string
          descripcion: string
          reporte_cliente: string | null
          dtcs: string[] | null
          anio: number | null
          urgencia: string | null
        }
        Insert: never
        Update: never
        Relationships: []
      }
      usuarios: {
        Row: {
          id: string
          rol: string | null
        }
        Insert: never
        Update: never
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
  ai: {
    Tables: {
      modelos: {
        Row: {
          id: string
          proveedor: string
          model_id: string
          alias: string
          capacidades: string[]
          costo_in_usd_mtok: number | null
          costo_out_usd_mtok: number | null
          contexto_tokens: number | null
          activo: boolean
        }
        Insert: never
        Update: never
        Relationships: []
      }
      routing: {
        Row: {
          id: string
          tipo_tarea: string
          modelo_preferido: string
          modelo_fallback: string | null
          presupuesto_usd_dia: number | null
          max_tokens_out: number | null
          activo: boolean
        }
        Insert: never
        Update: never
        Relationships: []
      }
      jobs: {
        Row: {
          id: string
          caso_id: string
          tipo: string
          status: JobStatus
          modelo_usado: string | null
          tokens_in: number | null
          tokens_out: number | null
          costo_usd: number | null
          intentos: number
          error: string | null
          created_at: string
          updated_at: string
          started_at: string | null
          finished_at: string | null
        }
        Insert: {
          caso_id: string
          tipo?: string
          status?: JobStatus
        }
        Update: {
          status?: JobStatus
          modelo_usado?: string | null
          tokens_in?: number | null
          tokens_out?: number | null
          costo_usd?: number | null
          intentos?: number
          error?: string | null
          started_at?: string | null
          finished_at?: string | null
        }
        Relationships: []
      }
      analisis_caso: {
        Row: {
          id: string
          caso_id: string
          job_id: string | null
          resumen: string | null
          diagnostico: string | null
          severidad: Severidad | null
          confianza: number | null
          hallazgos: Json
          modelo_usado: string | null
          tokens_total: number | null
          created_at: string
          updated_at: string
        }
        Insert: {
          caso_id: string
          job_id?: string | null
          resumen?: string | null
          diagnostico?: string | null
          severidad?: Severidad | null
          confianza?: number | null
          hallazgos?: Json
          modelo_usado?: string | null
          tokens_total?: number | null
        }
        Update: {
          job_id?: string | null
          resumen?: string | null
          diagnostico?: string | null
          severidad?: Severidad | null
          confianza?: number | null
          hallazgos?: Json
          modelo_usado?: string | null
          tokens_total?: number | null
        }
        Relationships: []
      }
      suggestions: {
        Row: {
          id: string
          tipo: SuggestionTipo
          origen: string
          problema: string
          evidencia: Json
          cambio_sugerido: string
          dueno: string | null
          metrica_esperada: string | null
          impacto_esperado: string | null
          estado: string
          ticket_vault: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          tipo: SuggestionTipo
          origen: string
          problema: string
          evidencia: Json
          cambio_sugerido: string
          dueno?: string | null
          metrica_esperada?: string | null
          impacto_esperado?: string | null
          estado?: string
        }
        Update: never
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
  // `api` — contratos EXPUESTOS a PostgREST. El servicio escribe/lee `ai` (OCULTO) SOLO
  // a través de estos wrappers (mig 108: api.* invoker → private.* definer). Espejo a
  // mano de las firmas `_v1`; si nodoauto-database cambia un contrato, se actualiza acá.
  api: {
    Tables: Record<string, never>
    Views: Record<string, never>
    Functions: {
      // ── Escritura del análisis EN VIVO (loop 1) ──────────────────────────────
      analisis_encolar_job_v1: {
        Args: { p_caso_id: string; p_tipo: string }
        Returns: Array<{
          id: string
          caso_id: string
          tipo: string
          status: JobStatus
          modelo_usado: string | null
          tokens_in: number | null
          tokens_out: number | null
          costo_usd: number | null
          intentos: number
          error: string | null
          created_at: string
          updated_at: string
          started_at: string | null
          finished_at: string | null
          creado: boolean
        }>
      }
      analisis_tomar_job_v1: {
        Args: { p_job_id: string }
        Returns: Array<{ id: string; caso_id: string; tipo: string; intentos: number }>
      }
      analisis_routing_v1: {
        Args: { p_tipo_tarea: string }
        Returns: Array<{
          id: string
          tipo_tarea: string
          modelo_preferido: string
          modelo_fallback: string | null
          presupuesto_usd_dia: number | null
          max_tokens_out: number | null
          activo: boolean
        }>
      }
      analisis_modelos_v1: {
        Args: Record<string, never>
        Returns: Array<{
          id: string
          proveedor: string
          model_id: string
          alias: string
          capacidades: string[]
          costo_in_usd_mtok: number | null
          costo_out_usd_mtok: number | null
          contexto_tokens: number | null
          activo: boolean
        }>
      }
      analisis_guardar_v1: {
        Args: {
          p_job_id: string
          p_caso_id: string
          p_resumen: string | null
          p_diagnostico: string | null
          p_severidad: Severidad | null
          p_confianza: number | null
          p_hallazgos: Json
          p_modelo_usado: string | null
          p_tokens_total: number | null
          p_tokens_in: number | null
          p_tokens_out: number | null
          p_costo_usd: number | null
        }
        Returns: undefined
      }
      analisis_fallar_job_v1: {
        Args: { p_job_id: string; p_intentos: number; p_error: string }
        Returns: undefined
      }
      // ── Propuestas (loop 3, §9): registra, NUNCA aplica ──────────────────────
      suggestions_registrar_v1: {
        Args: {
          p_tipo: SuggestionTipo
          p_origen: string
          p_problema: string
          p_evidencia: Json
          p_cambio_sugerido: string
          p_dueno: string | null
          p_metrica_esperada: string | null
          p_impacto_esperado: string | null
        }
        Returns: string
      }
    }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
