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

// Emulacion de los contratos `api.*_v1` (mig 108): wrappers invoker → puentes private
// definer que tocan `ai`. El servicio ya NO toca ai.* directo; va por `.schema('api').
// rpc(...)`. Este fake reproduce la SEMANTICA de cada funcion SQL (idempotencia,
// transicion atomica, upsert+cierre) contra el mismo `estado` en memoria, asi las
// aserciones de los tests (estado.jobs / estado.analisis_caso) siguen valiendo.
async function ejecutarRpc(
  estado: FakeState,
  name: string,
  args: Record<string, unknown>,
): Promise<Resultado> {
  const ahora = () => new Date().toISOString()
  switch (name) {
    case 'analisis_encolar_job_v1': {
      const casoId = args.p_caso_id as string
      const tipo = (args.p_tipo as string) || 'analisis_caso'
      const existente = estado.jobs.find((j) => j.caso_id === casoId && j.tipo === tipo)
      if (existente) return { data: [{ ...existente, creado: false }], error: null }
      const fila = aplicarDefaults('jobs', { caso_id: casoId, tipo, status: 'pendiente' })
      estado.jobs.push(fila)
      return { data: [{ ...fila, creado: true }], error: null }
    }
    case 'analisis_reencolar_v1': {
      // Espeja private.intel_reencolar_v1 (mig 111): INSERT ... ON CONFLICT (caso_id,tipo)
      // DO UPDATE ... WHERE status <> 'procesando'. No existe → crea pendiente. Existe y
      // no `procesando` → resetea a pendiente (limpia error/tiempos/metricas, +intentos).
      // `procesando` → no-op, reencolado=false.
      const casoId = args.p_caso_id as string
      const tipo = (args.p_tipo as string) || 'analisis_caso'
      const existente = estado.jobs.find((j) => j.caso_id === casoId && j.tipo === tipo)
      if (!existente) {
        const fila = aplicarDefaults('jobs', { caso_id: casoId, tipo, status: 'pendiente' })
        estado.jobs.push(fila)
        return { data: [{ ...fila, reencolado: true }], error: null }
      }
      if (existente.status === 'procesando') {
        return { data: [{ ...existente, reencolado: false }], error: null }
      }
      Object.assign(existente, {
        status: 'pendiente',
        error: null,
        started_at: null,
        finished_at: null,
        modelo_usado: null,
        tokens_in: null,
        tokens_out: null,
        costo_usd: null,
        intentos: (existente.intentos as number) + 1,
        updated_at: ahora(),
      })
      return { data: [{ ...existente, reencolado: true }], error: null }
    }
    case 'analisis_tomar_job_v1': {
      const job = estado.jobs.find((j) => j.id === args.p_job_id && j.status === 'pendiente')
      if (!job) return { data: [], error: null }
      job.status = 'procesando'
      job.started_at = ahora()
      return {
        data: [{ id: job.id, caso_id: job.caso_id, tipo: job.tipo, intentos: job.intentos }],
        error: null,
      }
    }
    case 'analisis_routing_v1': {
      const tipo = args.p_tipo_tarea as string
      return { data: estado.routing.filter((r) => r.tipo_tarea === tipo && r.activo), error: null }
    }
    case 'analisis_modelos_v1':
      return { data: estado.modelos, error: null }
    case 'analisis_guardar_v1': {
      const casoId = args.p_caso_id as string
      const campos: Row = {
        job_id: args.p_job_id,
        resumen: args.p_resumen,
        diagnostico: args.p_diagnostico,
        severidad: args.p_severidad,
        confianza: args.p_confianza,
        hallazgos: args.p_hallazgos ?? [],
        modelo_usado: args.p_modelo_usado,
        tokens_total: args.p_tokens_total,
      }
      const existente = estado.analisis_caso.find((a) => a.caso_id === casoId)
      if (existente) Object.assign(existente, campos, { updated_at: ahora() })
      else estado.analisis_caso.push(aplicarDefaults('analisis_caso', { caso_id: casoId, ...campos }))
      const job = estado.jobs.find((j) => j.id === args.p_job_id)
      if (job)
        Object.assign(job, {
          status: 'listo',
          modelo_usado: args.p_modelo_usado,
          tokens_in: args.p_tokens_in,
          tokens_out: args.p_tokens_out,
          costo_usd: args.p_costo_usd,
          error: null,
          finished_at: ahora(),
        })
      return { data: null, error: null }
    }
    case 'analisis_fallar_job_v1': {
      const job = estado.jobs.find((j) => j.id === args.p_job_id)
      if (job)
        Object.assign(job, {
          status: 'fallido',
          intentos: args.p_intentos,
          error: String(args.p_error ?? '').slice(0, 2000),
          finished_at: ahora(),
        })
      return { data: null, error: null }
    }
    case 'suggestions_registrar_v1': {
      const fila = aplicarDefaults('suggestions', {
        tipo: args.p_tipo,
        origen: args.p_origen,
        problema: args.p_problema,
        evidencia: args.p_evidencia ?? [],
        cambio_sugerido: args.p_cambio_sugerido,
        dueno: args.p_dueno ?? null,
        metrica_esperada: args.p_metrica_esperada ?? null,
        impacto_esperado: args.p_impacto_esperado ?? null,
      })
      estado.suggestions.push(fila)
      return { data: fila.id, error: null }
    }
    default:
      return { data: null, error: { message: `rpc no soportado en el fake: ${name}` } }
  }
}

class FakeSchema {
  constructor(private readonly estado: FakeState) {}
  from(tabla: keyof FakeState): FakeQuery {
    return new FakeQuery(this.estado, tabla)
  }
  rpc(name: string, args: Record<string, unknown> = {}): Promise<Resultado> {
    return ejecutarRpc(this.estado, name, args)
  }
}

class FakeClient {
  constructor(private readonly estado: FakeState) {}
  schema(_name: 'ai' | 'api'): FakeSchema {
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
