import { describe, it, expect, vi } from 'vitest'
import { createApp, type AppDeps } from '../../src/http/app.js'
import type { Inferencia } from '../../src/lib/anthropic.js'
import { fakeDb, nuevoEstado, type FakeState } from '../helpers/fakeDb.js'

// Test del CONTRATO HTTP del comando (ADR-005 §3): 202 + job_id, idempotencia, auth
// de servicio y re-verificacion de autorizacion. NUNCA devuelve el analisis.

const TOKEN = 'token-de-servicio-para-tests'
const CASO = '33333333-3333-4333-8333-333333333333'
const AUTOR = '44444444-4444-4444-8444-444444444444'
const OTRO = '55555555-5555-4555-8555-555555555555'

const inferirNoop: Inferencia = async () => ({ texto: '{}', tokensIn: 0, tokensOut: 0 })

function montar(estado: FakeState, over: Partial<AppDeps> = {}) {
  const disparo = vi.fn()
  const deps: AppDeps = {
    db: fakeDb(estado),
    inferir: inferirNoop,
    dispararProcesamiento: disparo,
    tokenServicio: TOKEN,
    ...over,
  }
  return { app: createApp(deps), disparo }
}

function estadoConCaso(): FakeState {
  return nuevoEstado({
    casos: [
      {
        id: CASO,
        slug: 'caso',
        autor_id: AUTOR,
        estado_resolucion: 'abierto',
        titulo: 't',
        descripcion: 'd',
        reporte_cliente: null,
        dtcs: null,
        anio: null,
        urgencia: null,
      },
    ],
    usuarios: [{ id: OTRO, rol: 'usuario' }],
  })
}

function pedir(app: ReturnType<typeof montar>['app'], body: unknown, token = TOKEN) {
  return app.request('/v1/analizar', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
}

describe('POST /v1/analizar', () => {
  it('401 sin token de servicio', async () => {
    const { app } = montar(estadoConCaso())
    const res = await app.request('/v1/analizar', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ caso_id: CASO }),
    })
    expect(res.status).toBe(401)
  })

  it('400 ante comando invalido (caso_id ausente)', async () => {
    const { app } = montar(estadoConCaso())
    const res = await pedir(app, { tipo: 'analisis_caso' })
    expect(res.status).toBe(400)
  })

  it('404 si el caso no existe', async () => {
    const { app, disparo } = montar(nuevoEstado())
    const res = await pedir(app, { caso_id: CASO })
    expect(res.status).toBe(404)
    expect(disparo).not.toHaveBeenCalled()
  })

  it('403 si el usuario no es autor ni elevado', async () => {
    const { app, disparo } = montar(estadoConCaso())
    const res = await pedir(app, { caso_id: CASO, usuario_id: OTRO })
    expect(res.status).toBe(403)
    expect(disparo).not.toHaveBeenCalled()
  })

  it('202 + job_id y dispara procesamiento al crear', async () => {
    const estado = estadoConCaso()
    const { app, disparo } = montar(estado)
    const res = await pedir(app, { caso_id: CASO, usuario_id: AUTOR })
    expect(res.status).toBe(202)
    const body = (await res.json()) as { job_id: string; status: string; idempotente: boolean }
    expect(body.job_id).toBeTruthy()
    expect(body.status).toBe('pendiente')
    expect(body.idempotente).toBe(false)
    expect(disparo).toHaveBeenCalledTimes(1)
    expect(disparo).toHaveBeenCalledWith(body.job_id)
    // NUNCA devuelve el analisis por HTTP.
    expect(JSON.stringify(body)).not.toContain('diagnostico')
  })

  it('retry idempotente: mismo job, sin volver a disparar procesamiento', async () => {
    const estado = estadoConCaso()
    const { app, disparo } = montar(estado)

    const r1 = await pedir(app, { caso_id: CASO, usuario_id: AUTOR })
    const b1 = (await r1.json()) as { job_id: string }

    const r2 = await pedir(app, { caso_id: CASO, usuario_id: AUTOR })
    const b2 = (await r2.json()) as { job_id: string; idempotente: boolean }

    expect(r2.status).toBe(202)
    expect(b2.job_id).toBe(b1.job_id)
    expect(b2.idempotente).toBe(true)
    expect(disparo).toHaveBeenCalledTimes(1) // solo el primero dispara
    expect(estado.jobs).toHaveLength(1)
  })

  it('reanalizar: re-encola un job `fallido` (mismo id) y vuelve a disparar procesamiento', async () => {
    const estado = estadoConCaso()
    const { app, disparo } = montar(estado)

    const r1 = await pedir(app, { caso_id: CASO, usuario_id: AUTOR })
    const b1 = (await r1.json()) as { job_id: string }
    // Dejar el job `fallido` (sin tocar el flujo de inferencia, directo en el estado).
    estado.jobs[0].status = 'fallido'
    estado.jobs[0].error = 'truncado'

    const r2 = await pedir(app, { caso_id: CASO, usuario_id: AUTOR, reanalizar: true })
    const b2 = (await r2.json()) as { job_id: string; status: string; idempotente: boolean }

    expect(r2.status).toBe(202)
    expect(b2.job_id).toBe(b1.job_id) // mismo job, re-encolado
    expect(b2.status).toBe('pendiente')
    expect(b2.idempotente).toBe(false)
    expect(disparo).toHaveBeenCalledTimes(2) // el primero y el reanalisis
    expect(disparo).toHaveBeenLastCalledWith(b1.job_id)
    expect(estado.jobs).toHaveLength(1)
  })

  it('reanalizar sobre un job `procesando`: no-op (idempotente, no re-dispara)', async () => {
    const estado = estadoConCaso()
    const { app, disparo } = montar(estado)

    await pedir(app, { caso_id: CASO, usuario_id: AUTOR })
    estado.jobs[0].status = 'procesando' // job en vuelo

    const res = await pedir(app, { caso_id: CASO, usuario_id: AUTOR, reanalizar: true })
    const body = (await res.json()) as { status: string; idempotente: boolean }

    expect(res.status).toBe(202)
    expect(body.status).toBe('procesando')
    expect(body.idempotente).toBe(true)
    expect(disparo).toHaveBeenCalledTimes(1) // solo el encolar inicial
  })
})
