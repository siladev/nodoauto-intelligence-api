import { randomUUID } from 'node:crypto'
import type { Db } from '../../src/lib/supabase.js'

// ─────────────────────────────────────────────────────────────────────────────
// Fake en memoria del cliente Supabase, acotado a los metodos que el servicio usa
// (select/insert/update/upsert + eq + maybeSingle/single + await como array). NO
// pretende emular PostgREST entero: solo lo necesario para testear idempotencia,
// routing, autorizacion y el route HTTP sin red.
//
// Modela el UNIQUE(caso_id,tipo) de ai.jobs y el onConflict(caso_id) de
// ai.analisis_caso, que es lo que la logica de idempotencia/upsert necesita.
// ─────────────────────────────────────────────────────────────────────────────

export interface FakeState {
  // public
  casos: Record<string, unknown>[]
  usuarios: Record<string, unknown>[]
  // ai
  jobs: Record<string, unknown>[]
  modelos: Record<string, unknown>[]
  routing: Record<string, unknown>[]
  analisis_caso: Record<string, unknown>[]
  suggestions: Record<string, unknown>[]
}

export function nuevoEstado(parcial: Partial<FakeState> = {}): FakeState {
  return {
    casos: [],
    usuarios: [],
    jobs: [],
    modelos: [],
    routing: [],
    analisis_caso: [],
    suggestions: [],
    ...parcial,
  }
}

type Row = Record<string, unknown>
type Filtro = [string, unknown]

interface Resultado {
  data: unknown
  error: { message: string; code?: string } | null
}

// Defaults aplicados al insertar, por tabla (espejan los DEFAULT de las migraciones).
function aplicarDefaults(tabla: keyof FakeState, payload: Row): Row {
  const ahora = new Date().toISOString()
  const base: Row = { id: randomUUID(), created_at: ahora, updated_at: ahora }
  if (tabla === 'jobs') {
    return {
      ...base,
      tipo: 'analisis_caso',
      status: 'pendiente',
      modelo_usado: null,
      tokens_in: null,
      tokens_out: null,
      costo_usd: null,
      intentos: 0,
      error: null,
      started_at: null,
      finished_at: null,
      ...payload,
    }
  }
  if (tabla === 'analisis_caso') {
    return { ...base, job_id: null, hallazgos: [], ...payload }
  }
  if (tabla === 'suggestions') {
    return { ...base, estado: 'nueva', ...payload }
  }
  return { ...base, ...payload }
}

class FakeQuery implements PromiseLike<Resultado> {
  private filtros: Filtro[] = []
  private modo: 'select' | 'insert' | 'update' | 'upsert' = 'select'
  private payload: Row | Row[] = {}
  private onConflict: string | null = null

  constructor(
    private readonly estado: FakeState,
    private readonly tabla: keyof FakeState,
  ) {}

  select(_cols?: string): this {
    if (this.modo === 'select') this.modo = 'select'
    return this
  }
  insert(payload: Row | Row[]): this {
    this.modo = 'insert'
    this.payload = payload
    return this
  }
  update(payload: Row): this {
    this.modo = 'update'
    this.payload = payload
    return this
  }
  upsert(payload: Row, opts?: { onConflict?: string }): this {
    this.modo = 'upsert'
    this.payload = payload
    this.onConflict = opts?.onConflict ?? null
    return this
  }
  eq(col: string, val: unknown): this {
    this.filtros.push([col, val])
    return this
  }

  private filtrar(): Row[] {
    const tabla = this.estado[this.tabla]
    return tabla.filter((row) => this.filtros.every(([c, v]) => row[c] === v))
  }

  private ejecutar(): Resultado {
    const tabla = this.estado[this.tabla]
    if (this.modo === 'insert') {
      const fila = aplicarDefaults(this.tabla, this.payload as Row)
      // UNIQUE(caso_id,tipo) de ai.jobs.
      if (this.tabla === 'jobs') {
        const dup = tabla.some(
          (r) => r.caso_id === fila.caso_id && r.tipo === fila.tipo,
        )
        if (dup) {
          return { data: null, error: { message: 'duplicate key', code: '23505' } }
        }
      }
      tabla.push(fila)
      return { data: fila, error: null }
    }
    if (this.modo === 'update') {
      const afectadas = this.filtrar()
      for (const row of afectadas) Object.assign(row, this.payload)
      return { data: afectadas, error: null }
    }
    if (this.modo === 'upsert') {
      const p = this.payload as Row
      const conflictCol = this.onConflict
      const existente = conflictCol
        ? tabla.find((r) => r[conflictCol] === p[conflictCol])
        : undefined
      if (existente) {
        Object.assign(existente, p, { updated_at: new Date().toISOString() })
        return { data: existente, error: null }
      }
      const fila = aplicarDefaults(this.tabla, p)
      tabla.push(fila)
      return { data: fila, error: null }
    }
    // select
    return { data: this.filtrar(), error: null }
  }

  async maybeSingle(): Promise<Resultado> {
    const res = this.ejecutar()
    if (res.error) return res
    const arr = Array.isArray(res.data) ? res.data : res.data ? [res.data] : []
    return { data: arr[0] ?? null, error: null }
  }

  async single(): Promise<Resultado> {
    const res = this.ejecutar()
    if (res.error) return res
    const arr = Array.isArray(res.data) ? res.data : res.data ? [res.data] : []
    if (arr.length === 0) {
      return { data: null, error: { message: 'no rows', code: 'PGRST116' } }
    }
    return { data: arr[0], error: null }
  }

  then<TR = Resultado, TE = never>(
    onfulfilled?: ((value: Resultado) => TR | PromiseLike<TR>) | null,
    onrejected?: ((reason: unknown) => TE | PromiseLike<TE>) | null,
  ): PromiseLike<TR | TE> {
    return Promise.resolve(this.ejecutar()).then(onfulfilled, onrejected)
  }
}

class FakeSchema {
  constructor(private readonly estado: FakeState) {}
  from(tabla: keyof FakeState): FakeQuery {
    return new FakeQuery(this.estado, tabla)
  }
}

class FakeClient {
  constructor(private readonly estado: FakeState) {}
  schema(_name: 'ai'): FakeSchema {
    return new FakeSchema(this.estado)
  }
  from(tabla: keyof FakeState): FakeQuery {
    return new FakeQuery(this.estado, tabla)
  }
}

/**
 * Devuelve un doble del cliente Supabase tipado como `Db`. El cast es deliberado:
 * el fake implementa SOLO la superficie usada por el servicio (justificado en test).
 */
export function fakeDb(estado: FakeState): Db {
  return new FakeClient(estado) as unknown as Db
}
