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
}
