import { describe, it, expect } from 'vitest'
import { encolarJob, reencolarJob, procesarJob } from '../../src/services/jobs.js'
import type { Inferencia } from '../../src/lib/anthropic.js'
import { fakeDb, nuevoEstado, type FakeState } from '../helpers/fakeDb.js'

const CASO = '22222222-2222-2222-2222-222222222222'

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
        max_tokens_out: 1024,
        activo: true,
      },
    ],
    ...parcial,
  })
}

const inferirOk: Inferencia = async () => ({
  texto: JSON.stringify({
    resumen: 'r',
    diagnostico: 'd',
    severidad: 'media',
    confianza: 0.7,
    hallazgos: [{ titulo: 't', detalle: 'x', dtc: 'P0300' }],
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
    const fallo = await procesarJob(db, async () => ({ texto: 'no json', tokensIn: 1, tokensOut: 1 }), job.id)
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
    const ok = await procesarJob(db, inferirOk, job.id)
    expect(ok.status).toBe('listo')
    expect(estado.jobs[0].status).toBe('listo')
  })

  it('re-analiza un job `listo` (tras mejorar prompt/modelo): vuelve a `pendiente`', async () => {
    const estado = estadoConCatalogo()
    const db = fakeDb(estado)
    const { job } = await encolarJob(db, CASO, 'analisis_caso')
    await procesarJob(db, inferirOk, job.id)
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
  it('procesa OK: escribe ai.analisis_caso y cierra el job en listo con costo/tokens', async () => {
    const estado = estadoConCatalogo()
    const db = fakeDb(estado)
    const { job } = await encolarJob(db, CASO, 'analisis_caso')

    const r = await procesarJob(db, inferirOk, job.id)
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
  })

  it('marca fallido si el modelo devuelve algo que no es JSON valido', async () => {
    const estado = estadoConCatalogo()
    const db = fakeDb(estado)
    const { job } = await encolarJob(db, CASO, 'analisis_caso')

    const inferirBasura: Inferencia = async () => ({ texto: 'no soy json', tokensIn: 1, tokensOut: 1 })
    const r = await procesarJob(db, inferirBasura, job.id)

    expect(r.status).toBe('fallido')
    expect(estado.jobs[0].status).toBe('fallido')
    expect(estado.jobs[0].error).toBeTruthy()
    expect(estado.analisis_caso).toHaveLength(0)
  })

  it('marca fallido si no hay routing activo para el tipo', async () => {
    const estado = estadoConCatalogo({ routing: [] })
    const db = fakeDb(estado)
    const { job } = await encolarJob(db, CASO, 'analisis_caso')

    const r = await procesarJob(db, inferirOk, job.id)
    expect(r.status).toBe('fallido')
    expect(estado.jobs[0].status).toBe('fallido')
  })

  it('omite un job que ya no esta pendiente (no reprocesa)', async () => {
    const estado = estadoConCatalogo()
    const db = fakeDb(estado)
    const { job } = await encolarJob(db, CASO, 'analisis_caso')

    const primero = await procesarJob(db, inferirOk, job.id)
    expect(primero.status).toBe('listo')

    const segundo = await procesarJob(db, inferirOk, job.id)
    expect(segundo.status).toBe('omitido')
  })
})
