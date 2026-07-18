import { describe, it, expect } from 'vitest'
import {
  normalizarGrounding,
  construirContextoGrounding,
  type GroundingPayload,
} from '../../src/domain/grounding.js'

// Normalizacion defensiva del jsonb del contrato api.analisis_grounding_v1 (mig 155)
// + construccion de los bloques de anclaje. Claves del payload CONGELADAS:
// caso / glosario / precedentes / manual / siglas.

describe('normalizarGrounding', () => {
  it('caso inexistente (el contrato devuelve NULL) → null', () => {
    expect(normalizarGrounding(null)).toBeNull()
    expect(normalizarGrounding(undefined)).toBeNull()
  })

  it('forma irreconocible (sin clave caso, array, escalar) → null', () => {
    expect(normalizarGrounding('basura')).toBeNull()
    expect(normalizarGrounding([])).toBeNull()
    expect(normalizarGrounding({ glosario: [] })).toBeNull()
  })

  it('bloques ausentes o malformados → arrays vacios (nunca revienta)', () => {
    const g = normalizarGrounding({ caso: { id: 'c1', dtcs: 'no-array' }, manual: 'x' })
    expect(g).not.toBeNull()
    expect(g?.caso.dtcs).toEqual([])
    expect(g?.glosario).toEqual([])
    expect(g?.precedentes).toEqual([])
    expect(g?.manual).toEqual([])
    expect(g?.siglas).toEqual([])
  })

  it('payload completo conserva los 5 bloques', () => {
    const g = normalizarGrounding({
      caso: { id: 'c1', modelo_id: 'm1', combustible: 'gnc', vehiculo: 'VW Polo 2020', dtcs: ['P0300'] },
      glosario: [{ codigo: 'P0300' }],
      precedentes: [{ vehiculo: 'v', titulo: 't', solucion: null }],
      manual: [{ titulo: 'x' }],
      siglas: [{ sigla: 'GNC' }],
    })
    expect(g?.caso.vehiculo).toBe('VW Polo 2020')
    expect(g?.caso.dtcs).toEqual(['P0300'])
    expect(g?.glosario).toHaveLength(1)
    expect(g?.precedentes).toHaveLength(1)
    expect(g?.manual).toHaveLength(1)
    expect(g?.siglas).toHaveLength(1)
  })
})

describe('construirContextoGrounding', () => {
  const vacio: GroundingPayload = {
    caso: { id: 'c1', modelo_id: null, combustible: null, vehiculo: null, dtcs: [] },
    glosario: [],
    precedentes: [],
    manual: [],
    siglas: [],
  }

  it("null o bloques vacios → '' (sin texto de relleno)", () => {
    expect(construirContextoGrounding(null)).toBe('')
    expect(construirContextoGrounding(vacio)).toBe('')
  })

  it('solo genera los bloques con datos (sin encabezados huerfanos)', () => {
    const soloSiglas = construirContextoGrounding({
      ...vacio,
      siglas: [{ sigla: 'BMS', nombre_espanol: 'Gestor de bateria', definicion: 'Modulo que supervisa la bateria HV.' }],
    })
    expect(soloSiglas).toContain('ARQUITECTURA DEL VEHÍCULO')
    expect(soloSiglas).toContain('• BMS (Gestor de bateria): Modulo que supervisa la bateria HV.')
    expect(soloSiglas).not.toContain('GLOSARIO')
    expect(soloSiglas).not.toContain('MANUAL OEM')
    expect(soloSiglas).not.toContain('CASOS REALES')
  })

  it('el bloque de manual SIEMPRE lleva la cita fuente_referencia + pagina_fuente', () => {
    const conManual = construirContextoGrounding({
      ...vacio,
      manual: [
        {
          sistema: 'frenos',
          tipo: 'especificacion',
          titulo: 'Espesor minimo de disco',
          valor: '22 mm',
          contenido: null,
          pagina_fuente: 88,
          manual_titulo: 'Manual de taller',
          fuente_referencia: 'CHERY-T8-2021',
          fuente_edicion: null,
        },
      ],
    })
    expect(conManual).toContain('citá SIEMPRE manual y página')
    expect(conManual).toContain('• [frenos] Espesor minimo de disco: 22 mm (Fuente: CHERY-T8-2021, p. 88)')
  })

  it('sanea el contenido de la DB antes de interpolar (defensa en profundidad)', () => {
    const sucio = construirContextoGrounding({
      ...vacio,
      precedentes: [
        { vehiculo: 'v', titulo: `hola${String.fromCharCode(0)}mundo`, solucion: null },
      ],
    })
    expect(sucio).toContain('holamundo')
    expect(sucio).not.toContain(String.fromCharCode(0))
  })
})
