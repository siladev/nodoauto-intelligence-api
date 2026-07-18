import { describe, it, expect } from 'vitest'
import {
  elegirTipoTarea,
  TIPO_TAREA_DEFAULT,
  TIPO_TAREA_ESCALADO,
  UMBRAL_DTCS_DIFICIL,
} from '../../src/domain/tiering.js'
import type { GroundingPayload } from '../../src/domain/grounding.js'

// Tiering PURO portado de la base $0 de la PWA (tiering.ts): elige el TIPO DE TAREA
// del routing, nunca un model_id (ADR-006 §1: modelo/techo viven en ai.routing).

function payload(over: {
  glosario?: number
  precedentes?: number
  dtcs?: number
}): GroundingPayload {
  return {
    caso: {
      id: 'c1',
      modelo_id: null,
      combustible: null,
      vehiculo: null,
      dtcs: Array.from({ length: over.dtcs ?? 0 }, (_, i) => `P030${i}`),
    },
    glosario: Array.from({ length: over.glosario ?? 0 }, (_, i) => ({
      codigo: `P030${i}`,
      nombre_corto: null,
      descripcion: null,
      sintomas: null,
      causas: null,
      condiciones_logicas: null,
      sistema: null,
    })),
    precedentes: Array.from({ length: over.precedentes ?? 0 }, () => ({
      vehiculo: 'v',
      titulo: 't',
      solucion: null,
    })),
    manual: [],
    siglas: [],
  }
}

describe('elegirTipoTarea — tiering puro (DEC-029 / ADR-008 §4)', () => {
  it('sin conocimiento Y sin precedentes → escala (el modelo razonaria de cero)', () => {
    expect(elegirTipoTarea(payload({ dtcs: 1 }))).toBe(TIPO_TAREA_ESCALADO)
  })

  it('grounding null (caso sin paquete de anclaje) cuenta como sin datos → escala', () => {
    expect(elegirTipoTarea(null)).toBe(TIPO_TAREA_ESCALADO)
  })

  it(`multi-sistema: ${UMBRAL_DTCS_DIFICIL}+ DTCs escalan aunque haya anclaje`, () => {
    expect(
      elegirTipoTarea(payload({ glosario: 3, precedentes: 2, dtcs: UMBRAL_DTCS_DIFICIL })),
    ).toBe(TIPO_TAREA_ESCALADO)
  })

  it('con anclaje (glosario o precedentes) y pocos DTCs → tipo default (barato)', () => {
    expect(elegirTipoTarea(payload({ glosario: 1, dtcs: 1 }))).toBe(TIPO_TAREA_DEFAULT)
    expect(elegirTipoTarea(payload({ precedentes: 1, dtcs: 2 }))).toBe(TIPO_TAREA_DEFAULT)
  })

  it('los tipos de tarea matchean el seed del routing (mig 155), no un model_id', () => {
    expect(TIPO_TAREA_DEFAULT).toBe('analisis_caso')
    expect(TIPO_TAREA_ESCALADO).toBe('analisis_caso_complejo')
  })
})
