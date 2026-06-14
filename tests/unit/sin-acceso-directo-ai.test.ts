import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// DIENTE anti-regresion (ADR-006 §7): `ai` esta OCULTO a PostgREST. El servicio NO puede
// tocar ai.* directo con supabase-js (`db.schema('ai').from(...)` → PGRST106, el bug que
// dejaba todo job en `fallido`/500). El UNICO camino es via los contratos `api.*_v1` (mig
// 108). Este test recorre src/ y falla si reaparece un acceso directo a `ai`.

const SRC = join(process.cwd(), 'src')

function archivosTs(dir: string): string[] {
  const out: string[] = []
  for (const entrada of readdirSync(dir)) {
    const ruta = join(dir, entrada)
    if (statSync(ruta).isDirectory()) out.push(...archivosTs(ruta))
    else if (entrada.endsWith('.ts')) out.push(ruta)
  }
  return out
}

describe('soberania de acceso a datos — `ai` solo por contratos api (ADR-006 §7)', () => {
  const fuentes = archivosTs(SRC).map((ruta) => ({ ruta, txt: readFileSync(ruta, 'utf8') }))

  it('ningun modulo de src/ accede a `ai` por PostgREST (db.schema("ai"))', () => {
    const ofensores = fuentes
      .filter(({ txt }) => /\.schema\(\s*['"]ai['"]\s*\)/.test(txt))
      .map(({ ruta }) => ruta)
    expect(ofensores, `acceso directo a ai (usa db.schema('api').rpc): ${ofensores.join(', ')}`).toEqual([])
  })

  it('el servicio escribe/lee ai a traves del schema `api` (rpc de los contratos _v1)', () => {
    const usaApi = fuentes.some(({ txt }) => /\.schema\(\s*['"]api['"]\s*\)\.rpc\(/.test(txt))
    expect(usaApi, 'se esperaba al menos un db.schema("api").rpc(...) tras el puente').toBe(true)
  })
})
