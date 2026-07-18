import { describe, it, expect } from 'vitest'
import { armarPrompt, parsearAnalisis, calcularCosto, type CasoRow } from '../../src/domain/analisis.js'
import type { GroundingPayload } from '../../src/domain/grounding.js'

const casoBase: CasoRow = {
  id: 'c1',
  slug: 'caso-1',
  autor_id: 'u1',
  estado_resolucion: 'abierto',
  titulo: 'No arranca en frio',
  descripcion: 'El motor no arranca cuando hace frio por la mañana.',
  reporte_cliente: 'Cliente dice que tarda en arrancar.',
  dtcs: ['P0300', 'P0171'],
  anio: 2015,
  urgencia: 'media',
}

const groundingCompleto: GroundingPayload = {
  caso: {
    id: 'c1',
    modelo_id: 'm1',
    combustible: 'hibrido',
    vehiculo: 'BYD Song Plus 2023',
    dtcs: ['P0171', 'P0300'],
  },
  glosario: [
    {
      codigo: 'P0300',
      nombre_corto: 'Fallo de encendido aleatorio',
      descripcion: 'Fallos de encendido detectados en multiples cilindros.',
      sintomas: ['Marcha irregular', 'Perdida de potencia'],
      causas: [{ causa: 'Bujias desgastadas', porcentaje: 40 }, { descripcion: 'Bobina defectuosa' }],
      condiciones_logicas: 'Se activa cuando el ECM detecta fallos en 200 revoluciones.',
      sistema: 'Motor — Encendido',
    },
  ],
  precedentes: [
    { vehiculo: 'Chery Tiggo 3 2018', titulo: 'Tironeo en frio', solucion: 'Cambio de bujias e inyectores limpiados.' },
  ],
  manual: [
    {
      sistema: 'motor',
      tipo: 'par_apriete',
      titulo: 'Torque de bujias',
      valor: '25 Nm',
      contenido: 'Aplicar torque en frio, en cruz.',
      pagina_fuente: 214,
      manual_titulo: 'Manual de taller Song Plus',
      fuente_referencia: 'BYD-SP-2023',
      fuente_edicion: '2023',
    },
  ],
  siglas: [
    { sigla: 'DHT', nombre_espanol: 'Transmision hibrida dedicada', definicion: 'Arquitectura hibrida de BYD.' },
  ],
}

const groundingVacio: GroundingPayload = {
  caso: { id: 'c1', modelo_id: null, combustible: null, vehiculo: null, dtcs: ['P0300', 'P0171'] },
  glosario: [],
  precedentes: [],
  manual: [],
  siglas: [],
}

describe('armarPrompt', () => {
  it('incluye titulo, año, descripcion y dtcs', () => {
    const { system, user } = armarPrompt(casoBase, null)
    expect(system).toContain('JSON')
    expect(user).toContain('No arranca en frio')
    expect(user).toContain('2015')
    expect(user).toContain('P0300, P0171')
  })

  it('reporta "ninguno" cuando no hay dtcs y "desconocido" sin año', () => {
    const { user } = armarPrompt({ ...casoBase, dtcs: null, anio: null }, null)
    expect(user).toContain('DTCs detectados: ninguno')
    expect(user).toContain('Año: desconocido')
  })

  it('sanea contenido almacenado: quita caracteres de control (anti-inyeccion)', () => {
    const sucio = { ...casoBase, titulo: `hola${String.fromCharCode(0)}mundo${String.fromCharCode(27)}` }
    const { user } = armarPrompt(sucio, null)
    expect(user).toContain('holamundo')
    expect(user).not.toContain(String.fromCharCode(0))
    expect(user).not.toContain(String.fromCharCode(27))
  })

  it('el system prompt EXIGE cita por hallazgo y prohibe inventar fuentes (DEC-029)', () => {
    const { system } = armarPrompt(casoBase, groundingCompleto)
    expect(system).toContain('"cita":"string|null"')
    expect(system).toContain('cada hallazgo DEBE indicar en "cita" la fuente')
    expect(system).toContain('NUNCA inventes una fuente')
  })

  // Regla ANTI-DOWNGRADE (DEC-029): con grounding completo el prompt ancla AL MENOS
  // tanto como la base $0 de la PWA (glosario con definicion/sintomas/causas/
  // condiciones + precedentes con solucion) y SUMA manual OEM citado + siglas.
  it('con grounding completo arma los 4 bloques con los datos duros y las citas', () => {
    const { user } = armarPrompt(casoBase, groundingCompleto)

    // Identidad del vehiculo (marca + modelo canonico + año, VEH-1).
    expect(user).toContain('Vehiculo: BYD Song Plus 2023')

    // Bloque glosario: al menos lo que anclaba la base $0 de la app.
    expect(user).toContain('DATOS VERIFICADOS DEL GLOSARIO')
    expect(user).toContain('P0300 (Fallo de encendido aleatorio)')
    expect(user).toContain('Definición: Fallos de encendido detectados en multiples cilindros.')
    expect(user).toContain('Síntomas típicos: Marcha irregular; Perdida de potencia')
    expect(user).toContain('Causas probables conocidas: Bujias desgastadas (40%), Bobina defectuosa')
    expect(user).toContain('Condiciones de activación: Se activa cuando el ECM detecta fallos')

    // Bloque precedentes: mismo formato [vehiculo] titulo → Solución.
    expect(user).toContain('CASOS REALES YA RESUELTOS')
    expect(user).toContain('• [Chery Tiggo 3 2018] Tironeo en frio → Solución: Cambio de bujias')

    // Bloque manual OEM: SIEMPRE con cita (fuente_referencia + pagina_fuente).
    expect(user).toContain('MANUAL OEM')
    expect(user).toContain('Torque de bujias: 25 Nm — Aplicar torque en frio, en cruz.')
    expect(user).toContain('(Fuente: BYD-SP-2023, ed. 2023, p. 214)')

    // Bloque siglas (arquitectura segun combustible).
    expect(user).toContain('ARQUITECTURA DEL VEHÍCULO')
    expect(user).toContain('• DHT (Transmision hibrida dedicada): Arquitectura hibrida de BYD.')
  })

  it('bloques vacios NO generan texto de relleno', () => {
    const { user } = armarPrompt(casoBase, groundingVacio)
    expect(user).not.toContain('GLOSARIO')
    expect(user).not.toContain('CASOS REALES')
    expect(user).not.toContain('MANUAL OEM')
    expect(user).not.toContain('ARQUITECTURA')
  })

  it('grounding null (caso sin paquete): cae a la base sin bloques, sin romper', () => {
    const conGrounding = armarPrompt(casoBase, null)
    expect(conGrounding.user).toContain('Titulo: No arranca en frio')
    expect(conGrounding.user).not.toContain('GLOSARIO')
    expect(conGrounding.user).not.toContain('Vehiculo:')
  })
})

describe('parsearAnalisis', () => {
  it('parsea y valida un JSON correcto (con cita en hallazgos)', () => {
    const json = JSON.stringify({
      resumen: 'r',
      diagnostico: 'd',
      severidad: 'media',
      confianza: 0.8,
      hallazgos: [{ titulo: 't', detalle: 'x', dtc: 'P0300', cita: '[Glosario P0300]' }],
    })
    const a = parsearAnalisis(json)
    expect(a.severidad).toBe('media')
    expect(a.hallazgos).toHaveLength(1)
    expect(a.hallazgos[0].cita).toBe('[Glosario P0300]')
  })

  it('la cita es nullable con default null (hallazgo sin fuente provista)', () => {
    const a = parsearAnalisis(
      JSON.stringify({ resumen: 'r', diagnostico: 'd', hallazgos: [{ titulo: 't', detalle: 'x' }] }),
    )
    expect(a.hallazgos[0].cita).toBeNull()
  })

  // Regresion del bug de prod (job bc45934b, haiku): el modelo envolvio el JSON en
  // fences/preambulo y JSON.parse directo fallaba → job `fallido` sin evidencia.
  it('tolera el JSON envuelto en fences de markdown', () => {
    const a = parsearAnalisis('```json\n{"resumen":"r","diagnostico":"d"}\n```')
    expect(a.resumen).toBe('r')
  })

  it('tolera preambulo y epilogo de texto alrededor del objeto', () => {
    const a = parsearAnalisis(
      'Aqui esta el analisis pedido:\n{"resumen":"r","diagnostico":"d"}\nEspero que sirva.',
    )
    expect(a.diagnostico).toBe('d')
  })

  it('lanza si la respuesta no es JSON, con un snippet como evidencia (va a ai.jobs.error)', () => {
    expect(() => parsearAnalisis('no soy json')).toThrow(/inicio: "no soy json"/)
  })

  // Regresion del bug de prod (job 1ef8e7df, benchmark sonnet): dtc con varios
  // codigos ("P0101, P0299") superaba max(10) y tiraba el analisis entero.
  it('normaliza dtc a UN solo codigo OBD-II valido (el primero presente)', () => {
    const a = parsearAnalisis(
      JSON.stringify({
        resumen: 'r',
        diagnostico: 'd',
        hallazgos: [
          { titulo: 't', detalle: 'x', dtc: 'P0101, P0299' },
          { titulo: 't', detalle: 'x', dtc: 'Sensor MAP (p0107)' },
          { titulo: 't', detalle: 'x', dtc: 'sin codigo asociado' },
        ],
      }),
    )
    expect(a.hallazgos.map((h) => h.dtc)).toEqual(['P0101', 'P0107', null])
  })

  it('lanza si el JSON no cumple el schema (confianza > 1)', () => {
    expect(() =>
      parsearAnalisis(JSON.stringify({ resumen: 'r', diagnostico: 'd', confianza: 5 })),
    ).toThrow()
  })
})

describe('calcularCosto', () => {
  it('calcula USD por millon de tokens y redondea a 4 decimales', () => {
    const costo = calcularCosto({ costo_in_usd_mtok: 3, costo_out_usd_mtok: 15 }, 1_000_000, 1_000_000)
    expect(costo).toBe(18)
  })

  it('devuelve null si el modelo no tiene costos cargados', () => {
    expect(calcularCosto({ costo_in_usd_mtok: null, costo_out_usd_mtok: null }, 100, 100)).toBeNull()
  })
})
