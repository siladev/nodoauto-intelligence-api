import { describe, it, expect } from 'vitest'
import { resolverModelo, RoutingError, type ModeloRow, type RoutingRow } from '../../src/domain/routing.js'

// Routing multi-modelo EN DATOS (ADR-006 §1): la eleccion sale de ai.routing +
// ai.modelos, no del codigo. resolverModelo es pura → se testea sin DB.

const opus: ModeloRow = {
  id: 'm-opus',
  proveedor: 'anthropic',
  model_id: 'claude-opus-4-8',
  alias: 'opus',
  capacidades: ['razonamiento'],
  costo_in_usd_mtok: 15,
  costo_out_usd_mtok: 75,
  contexto_tokens: 200000,
  activo: true,
}
const sonnet: ModeloRow = {
  ...opus,
  id: 'm-sonnet',
  model_id: 'claude-sonnet-4-6',
  alias: 'sonnet',
  costo_in_usd_mtok: 3,
  costo_out_usd_mtok: 15,
  activo: true,
}

function routing(over: Partial<RoutingRow> = {}): RoutingRow {
  return {
    id: 'r1',
    tipo_tarea: 'analisis_caso',
    modelo_preferido: 'm-opus',
    modelo_fallback: 'm-sonnet',
    presupuesto_usd_dia: null,
    max_tokens_out: 1024,
    activo: true,
    ...over,
  }
}

describe('resolverModelo', () => {
  it('elige el modelo preferido cuando esta activo', () => {
    const r = resolverModelo('analisis_caso', [routing()], [opus, sonnet])
    expect(r.modelo.id).toBe('m-opus')
    expect(r.usoFallback).toBe(false)
  })

  it('cae al fallback cuando el preferido esta inactivo', () => {
    const r = resolverModelo(
      'analisis_caso',
      [routing()],
      [{ ...opus, activo: false }, sonnet],
    )
    expect(r.modelo.id).toBe('m-sonnet')
    expect(r.usoFallback).toBe(true)
  })

  it('lanza si no hay routing activo para el tipo de tarea', () => {
    expect(() => resolverModelo('otro', [routing()], [opus, sonnet])).toThrow(RoutingError)
  })

  it('lanza si el routing del tipo esta inactivo', () => {
    expect(() =>
      resolverModelo('analisis_caso', [routing({ activo: false })], [opus, sonnet]),
    ).toThrow(RoutingError)
  })

  it('lanza si preferido y fallback estan inactivos/ausentes', () => {
    expect(() =>
      resolverModelo(
        'analisis_caso',
        [routing({ modelo_fallback: null })],
        [{ ...opus, activo: false }],
      ),
    ).toThrow(RoutingError)
  })
})
