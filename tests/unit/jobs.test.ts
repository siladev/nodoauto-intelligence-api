import { describe, it, expect, vi } from 'vitest'
import { encolarJob, reencolarJob, procesarJob } from '../../src/services/jobs.js'
import type { Inferencia } from '../../src/lib/anthropic.js'
import { fakeDb, nuevoEstado, type FakeState } from '../helpers/fakeDb.js'

const CASO = '22222222-2222-2222-2222-222222222222'
const OTRO_CASO = '99999999-9999-4999-8999-999999999999'

function estadoConCatalogo(parcial: Partial<FakeState> = {}): FakeState {
  return nuevoEstado({
    casos: [
      {
        id: CASO,
        slug: 'caso',
        autor_id: 'u1',
        estado_resolucion: 'abierto',
        titulo: 'titulo',
        descripcion: 'descripcion larga del sintoma',
        reporte_cliente: null,
        dtcs: ['P0300'],
        anio: 2015,
        urgencia: 'media',
      },
    ],
    modelos: [
      {
        id: 'm-sonnet',
        proveedor: 'anthropic',
        model_id: 'claude-sonnet-4-6',
        alias: 'sonnet',
        capacidades: ['razonamiento'],
        costo_in_usd_mtok: 3,
        costo_out_usd_mtok: 15,
        contexto_tokens: 200000,
        activo: true,
      },
    ],
    routing: [
      {
        id: 'r1',
        tipo_tarea: 'analisis_caso',
        modelo_preferido: 'm-sonnet',
        modelo_fallback: null,
        presupuesto_usd_dia: null,
        max_tokens_out: 4096,
        activo: true,
      },
    ],
    // Con conocimiento del glosario y 1 solo DTC, el tiering elige 'analisis_caso'
    // (la fila de routing de arriba). Los tests de tiering/escalado lo pisan.
    grounding: {
      [CASO]: {
        caso: { id: CASO, modelo_id: null, combustible: null, vehiculo: null, dtcs: ['P0300'] },
        glosario: [
          {
            codigo: 'P0300',
            nombre_corto: 'Fallo de encendido',
            descripcion: 'd',
            sintomas: null,
            causas: null,
            condiciones_logicas: null,
            sistema: 'Motor — Encendido',
          },
        ],
        precedentes: [],
        manual: [],
        siglas: [],
      },
    },
    ...parcial,
  })
}

const inferirOk: Inferencia = async () => ({
  texto: JSON.stringify({
    resumen: 'r',
    diagnostico: 'd',
    severidad: 'media',
    confianza: 0.7,
    hallazgos: [{ titulo: 't', detalle: 'x', dtc: 'P0300', cita: '[Glosario P0300]' }],
  }),
  tokensIn: 1_000_000,
  tokensOut: 1_000_000,
})

describe('encolarJob — idempotencia por (caso_id, tipo)', () => {
  it('crea el job la primera vez y lo recupera (sin duplicar) la segunda', async () => {
    const estado = estadoConCatalogo()
    const db = fakeDb(estado)

    const primero = await encolarJob(db, CASO, 'analisis_caso')
    expect(primero.creado).toBe(true)

    const segundo = await encolarJob(db, CASO, 'analisis_caso')
    expect(segundo.creado).toBe(false)
    expect(segundo.job.id).toBe(primero.job.id)

    expect(estado.jobs).toHaveLength(1)
  })
})

describe('reencolarJob — re-analisis controlado (ADR-006)', () => {
  it('reintenta un job `fallido`: lo resetea a `pendiente`, limpia error y suma intentos', async () => {
    const estado = estadoConCatalogo()
    const db = fakeDb(estado)
    const { job } = await encolarJob(db, CASO, 'analisis_caso')

    // Lo dejamos `fallido` (como el caso real d6adcf00 con max_tokens_out=1024).
    const fallo = await procesarJob(db, async () => ({ texto: 'no json', tokensIn: 1, tokensOut: 1 }), job)
    expect(fallo.status).toBe('fallido')
    expect(estado.jobs[0].intentos).toBe(1)

    const r = await reencolarJob(db, CASO, 'analisis_caso')
    expect(r.reencolado).toBe(true)
    expect(r.job.id).toBe(job.id)
    expect(r.job.status).toBe('pendiente')
    expect(estado.jobs).toHaveLength(1)
    expect(estado.jobs[0].status).toBe('pendiente')
    expect(estado.jobs[0].error).toBeNull()
    expect(estado.jobs[0].finished_at).toBeNull()
    expect(estado.jobs[0].intentos).toBe(2)

    // Y ahora SI se puede reprocesar (con el bug ya corregido).
    const ok = await procesarJob(db, inferirOk, job)
    expect(ok.status).toBe('listo')
    expect(estado.jobs[0].status).toBe('listo')
  })

  it('re-analiza un job `listo` (tras mejorar prompt/modelo): vuelve a `pendiente`', async () => {
    const estado = estadoConCatalogo()
    const db = fakeDb(estado)
    const { job } = await encolarJob(db, CASO, 'analisis_caso')
    await procesarJob(db, inferirOk, job)
    expect(estado.jobs[0].status).toBe('listo')

    const r = await reencolarJob(db, CASO, 'analisis_caso')
    expect(r.reencolado).toBe(true)
    expect(estado.jobs[0].status).toBe('pendiente')
    expect(estado.jobs[0].modelo_usado).toBeNull()
    expect(estado.jobs[0].tokens_in).toBeNull()
  })

  it('crea el job si todavia no existe (se comporta como encolar)', async () => {
    const estado = estadoConCatalogo()
    const db = fakeDb(estado)

    const r = await reencolarJob(db, CASO, 'analisis_caso')
    expect(r.reencolado).toBe(true)
    expect(r.job.status).toBe('pendiente')
    expect(estado.jobs).toHaveLength(1)
  })

  it('NO pisa un job en vuelo: si esta `procesando`, es no-op (reencolado=false)', async () => {
    const estado = estadoConCatalogo()
    const db = fakeDb(estado)
    const { job } = await encolarJob(db, CASO, 'analisis_caso')
    // Simular un job tomado por un worker (en vuelo).
    estado.jobs[0].status = 'procesando'

    const r = await reencolarJob(db, CASO, 'analisis_caso')
    expect(r.reencolado).toBe(false)
    expect(r.job.id).toBe(job.id)
    expect(estado.jobs[0].status).toBe('procesando')
  })
})

describe('procesarJob — caja negra', () => {
  it('procesa OK: escribe ai.analisis_caso (con citas) y cierra el job en listo con costo/tokens', async () => {
    const estado = estadoConCatalogo()
    const db = fakeDb(estado)
    const { job } = await encolarJob(db, CASO, 'analisis_caso')

    const r = await procesarJob(db, inferirOk, job)
    expect(r.status).toBe('listo')

    const jobFinal = estado.jobs[0]
    expect(jobFinal.status).toBe('listo')
    expect(jobFinal.modelo_usado).toBe('m-sonnet')
    expect(jobFinal.tokens_in).toBe(1_000_000)
    expect(jobFinal.tokens_out).toBe(1_000_000)
    expect(jobFinal.costo_usd).toBe(18) // (1*3 + 1*15) por millon

    expect(estado.analisis_caso).toHaveLength(1)
    const analisis = estado.analisis_caso[0]
    expect(analisis.caso_id).toBe(CASO)
    expect(analisis.severidad).toBe('media')
    expect(analisis.tokens_total).toBe(2_000_000)
    expect(analisis.hallazgos).toEqual([
      { titulo: 't', detalle: 'x', dtc: 'P0300', cita: '[Glosario P0300]' },
    ])
  })

  it('el prompt de la inferencia lleva el grounding (bloque del glosario)', async () => {
    const estado = estadoConCatalogo()
    const db = fakeDb(estado)
    const { job } = await encolarJob(db, CASO, 'analisis_caso')

    let promptVisto = ''
    const inferirEspia: Inferencia = async (args) => {
      promptVisto = args.user
      return inferirOk({ ...args })
    }
    await procesarJob(db, inferirEspia, job)
    expect(promptVisto).toContain('DATOS VERIFICADOS DEL GLOSARIO')
    expect(promptVisto).toContain('P0300 (Fallo de encendido)')
  })

  it('marca fallido si el modelo devuelve algo que no es JSON valido', async () => {
    const estado = estadoConCatalogo()
    const db = fakeDb(estado)
    const { job } = await encolarJob(db, CASO, 'analisis_caso')

    const inferirBasura: Inferencia = async () => ({ texto: 'no soy json', tokensIn: 1, tokensOut: 1 })
    const r = await procesarJob(db, inferirBasura, job)

    expect(r.status).toBe('fallido')
    expect(estado.jobs[0].status).toBe('fallido')
    expect(estado.jobs[0].error).toBeTruthy()
    expect(estado.analisis_caso).toHaveLength(0)
  })

  it('marca fallido si no hay routing activo para el tipo de tarea (RoutingError)', async () => {
    const estado = estadoConCatalogo({ routing: [] })
    const db = fakeDb(estado)
    const { job } = await encolarJob(db, CASO, 'analisis_caso')

    const r = await procesarJob(db, inferirOk, job)
    expect(r.status).toBe('fallido')
    expect(estado.jobs[0].status).toBe('fallido')
    expect(String(estado.jobs[0].error)).toContain('Sin routing activo')
  })

  it('omite un job que ya no esta pendiente (no reprocesa)', async () => {
    const estado = estadoConCatalogo()
    const db = fakeDb(estado)
    const { job } = await encolarJob(db, CASO, 'analisis_caso')

    const primero = await procesarJob(db, inferirOk, job)
    expect(primero.status).toBe('listo')

    const segundo = await procesarJob(db, inferirOk, job)
    expect(segundo.status).toBe('omitido')
  })
})

describe('procesarJob — tiering → tipo de tarea del routing (ADR-008 §4)', () => {
  it('caso SIN anclaje usa la fila de routing escalada, pero el tipo del JOB no cambia', async () => {
    const estado = estadoConCatalogo({
      modelos: [
        {
          id: 'm-haiku', proveedor: 'anthropic', model_id: 'claude-haiku-4-5', alias: 'haiku',
          capacidades: [], costo_in_usd_mtok: 1, costo_out_usd_mtok: 5, contexto_tokens: 200000, activo: true,
        },
        {
          id: 'm-sonnet', proveedor: 'anthropic', model_id: 'claude-sonnet-4-6', alias: 'sonnet',
          capacidades: [], costo_in_usd_mtok: 3, costo_out_usd_mtok: 15, contexto_tokens: 200000, activo: true,
        },
      ],
      routing: [
        {
          id: 'r1', tipo_tarea: 'analisis_caso', modelo_preferido: 'm-haiku',
          modelo_fallback: null, presupuesto_usd_dia: null, max_tokens_out: 4096, activo: true,
        },
        {
          id: 'r2', tipo_tarea: 'analisis_caso_complejo', modelo_preferido: 'm-sonnet',
          modelo_fallback: null, presupuesto_usd_dia: null, max_tokens_out: 4096, activo: true,
        },
      ],
      // Sin conocimiento ni precedentes → escala.
      grounding: {
        [CASO]: {
          caso: { id: CASO, modelo_id: null, combustible: null, vehiculo: null, dtcs: ['P0300'] },
          glosario: [], precedentes: [], manual: [], siglas: [],
        },
      },
    })
    const db = fakeDb(estado)
    const { job } = await encolarJob(db, CASO, 'analisis_caso')

    const r = await procesarJob(db, inferirOk, job)
    expect(r.status).toBe('listo')
    // Uso la fila escalada (sonnet), pero el JOB sigue siendo 'analisis_caso'.
    expect(estado.jobs[0].modelo_usado).toBe('m-sonnet')
    expect(estado.jobs[0].tipo).toBe('analisis_caso')
  })
})

describe('procesarJob — guard de presupuesto (DEC-029: techo → queda pendiente)', () => {
  function estadoConTecho(): FakeState {
    const estado = estadoConCatalogo()
    estado.routing[0].presupuesto_usd_dia = 0.5
    // Gasto ya materializado hoy (otro caso, job cerrado): 0.60 >= 0.50.
    estado.jobs.push({
      id: 'job-viejo',
      caso_id: OTRO_CASO,
      tipo: 'analisis_caso',
      status: 'listo',
      modelo_usado: 'm-sonnet',
      tokens_in: 10,
      tokens_out: 10,
      costo_usd: 0.6,
      intentos: 0,
      error: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    })
    return estado
  }

  it('techo alcanzado: el job QUEDA `pendiente` (ni se toma), sin inferir y sin gastar', async () => {
    const estado = estadoConTecho()
    const db = fakeDb(estado)
    const { job } = await encolarJob(db, CASO, 'analisis_caso')

    const inferirEspia = vi.fn(inferirOk)
    const r = await procesarJob(db, inferirEspia, job)

    expect(r.status).toBe('pendiente')
    const jobFila = estado.jobs.find((j) => j.id === job.id)
    expect(jobFila?.status).toBe('pendiente') // NUNCA `fallido` por presupuesto
    expect(jobFila?.started_at).toBeNull() // ni siquiera se tomo
    expect(jobFila?.costo_usd).toBeNull() // sin gasto
    expect(inferirEspia).not.toHaveBeenCalled()
    expect(estado.analisis_caso).toHaveLength(0)
  })

  it('con presupuesto disponible el mismo job procesa normal', async () => {
    const estado = estadoConTecho()
    estado.routing[0].presupuesto_usd_dia = 100 // techo holgado
    const db = fakeDb(estado)
    const { job } = await encolarJob(db, CASO, 'analisis_caso')

    const r = await procesarJob(db, inferirOk, job)
    expect(r.status).toBe('listo')
  })
})

describe('procesarJob — benchmark con modelo forzado (ADR-008 §3)', () => {
  function estadoConBenchmark(): FakeState {
    const estado = estadoConCatalogo({
      modelos: [
        {
          id: 'm-haiku', proveedor: 'anthropic', model_id: 'claude-haiku-4-5', alias: 'haiku',
          capacidades: [], costo_in_usd_mtok: 1, costo_out_usd_mtok: 5, contexto_tokens: 200000, activo: true,
        },
        {
          id: 'm-sonnet', proveedor: 'anthropic', model_id: 'claude-sonnet-4-6', alias: 'sonnet',
          capacidades: [], costo_in_usd_mtok: 3, costo_out_usd_mtok: 15, contexto_tokens: 200000, activo: true,
        },
      ],
    })
    estado.routing[0].modelo_preferido = 'm-haiku'
    // Analisis VIGENTE pre-existente: el benchmark JAMAS debe pisarlo.
    estado.analisis_caso.push({
      id: 'a-vigente',
      caso_id: CASO,
      job_id: null,
      resumen: 'analisis vigente',
      diagnostico: 'no me pises',
      severidad: 'info',
      confianza: 0.5,
      hallazgos: [],
      modelo_usado: 'm-haiku',
      tokens_total: 10,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    return estado
  }

  it('corre con el modelo forzado por alias y guarda en ai.benchmarks, SIN tocar el analisis vigente', async () => {
    const estado = estadoConBenchmark()
    const db = fakeDb(estado)
    const { job } = await reencolarJob(db, CASO, 'benchmark:sonnet')

    let modeloUsado = ''
    const inferirEspia: Inferencia = async (args) => {
      modeloUsado = args.modelId
      return inferirOk(args)
    }
    const r = await procesarJob(db, inferirEspia, job)

    expect(r.status).toBe('listo')
    expect(modeloUsado).toBe('claude-sonnet-4-6') // forzado, no el preferido del routing (haiku)

    // El resultado va a ai.benchmarks (append), nunca a analisis_guardar_v1.
    expect(estado.benchmarks).toHaveLength(1)
    expect(estado.benchmarks[0].caso_id).toBe(CASO)
    expect(estado.benchmarks[0].modelo).toBe('m-sonnet')
    expect(estado.benchmarks[0].costo_usd).toBe(18)

    // El analisis VIGENTE queda intacto (invariante ADR-008).
    expect(estado.analisis_caso).toHaveLength(1)
    expect(estado.analisis_caso[0].resumen).toBe('analisis vigente')
    expect(estado.analisis_caso[0].diagnostico).toBe('no me pises')

    // El job del benchmark cierra en listo y su gasto entra al contador global.
    const jobFila = estado.jobs.find((j) => j.id === job.id)
    expect(jobFila?.status).toBe('listo')
    expect(jobFila?.costo_usd).toBe(18)
  })

  it('alias invalido o inactivo → job `fallido` con mensaje claro, sin inferir', async () => {
    const estado = estadoConBenchmark()
    const db = fakeDb(estado)
    const { job } = await reencolarJob(db, CASO, 'benchmark:gpt9')

    const inferirEspia = vi.fn(inferirOk)
    const r = await procesarJob(db, inferirEspia, job)

    expect(r.status).toBe('fallido')
    expect(inferirEspia).not.toHaveBeenCalled()
    const jobFila = estado.jobs.find((j) => j.id === job.id)
    expect(jobFila?.status).toBe('fallido')
    expect(String(jobFila?.error)).toContain('alias de modelo invalido o inactivo: "gpt9"')
    expect(estado.benchmarks).toHaveLength(0)
    // El analisis vigente sigue intacto.
    expect(estado.analisis_caso[0].resumen).toBe('analisis vigente')
  })

  it('re-comandar el benchmark re-corre la tupla (reencolar) y APPENDEA otra corrida', async () => {
    const estado = estadoConBenchmark()
    const db = fakeDb(estado)

    const primera = await reencolarJob(db, CASO, 'benchmark:sonnet')
    await procesarJob(db, inferirOk, primera.job)
    const segunda = await reencolarJob(db, CASO, 'benchmark:sonnet')
    expect(segunda.reencolado).toBe(true)
    expect(segunda.job.id).toBe(primera.job.id) // mismo job (UNIQUE caso_id+tipo)
    await procesarJob(db, inferirOk, segunda.job)

    expect(estado.benchmarks).toHaveLength(2) // historial append-only
    expect(estado.analisis_caso[0].resumen).toBe('analisis vigente')
  })
})
