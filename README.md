# nodoauto-intelligence-api

Capa de inteligencia de **NODO AUTO** (ADR-005 fase F3 / ADR-006). Servicio HTTP
(Hono + TypeScript, Node 24) que recibe **comandos** de análisis, elige modelo por
routing-en-datos, ejecuta la inferencia (Anthropic) y escribe el resultado en el schema
oculto `ai.*` por `service_role`. **No devuelve el análisis por HTTP**: la PWA lo lee por
el contrato `api.analisis_caso_v1`.

Hermano de `nodoauto-app` (PWA) y `nodoauto-database` (dueño del esquema). Este repo es
**consumidor** de la plataforma de datos: no crea ni altera esquema.

## Arquitectura (resumen)

```
PWA (server-side)                 nodoauto-intelligence-api              Supabase
─────────────────                 ─────────────────────────              ────────
POST /v1/analizar  ──Bearer──▶    1. auth de servicio
{caso_id, tipo,                   2. re-verifica autorización  ◀───────  public.casos
 usuario_id}                      3. encola idempotente        ───────▶  ai.jobs (UNIQUE caso_id,tipo)
            ◀── 202 + job_id ──   4. (background) routing       ◀───────  ai.routing + ai.modelos
                                  5. inferencia (Anthropic)
                                  6. valida + persiste         ───────▶  ai.analisis_caso + ai.jobs(costo/tokens)

lee análisis  ◀─────────────────────────────────────────────  api.analisis_caso_v1 (status + resultado)
```

- **Comando, no consulta** (ADR-005 §3): 202 + id; el resultado se lee por `api.*`.
- **Idempotente** por `(caso_id, tipo)`: un retry no duplica.
- **Degradación:** si el servicio está caído, la lectura del contrato sigue funcionando
  con `status` `pendiente`/`fallido`. No es punto único de falla.
- **Propone, no aplica** (ADR-005 §14): el camino de mejoras escribe `ai.suggestions`
  (con evidencia); ninguna ruta aplica cambios de código/contenido.

## Endpoints

| Método | Ruta            | Auth            | Respuesta |
|--------|-----------------|-----------------|-----------|
| `GET`  | `/health`       | — (health check)| `{ ok }` |
| `POST` | `/v1/analizar`  | Bearer servicio | `202 { job_id, status, idempotente }` |

`POST /v1/analizar` body: `{ "caso_id": uuid, "tipo"?: "analisis_caso", "usuario_id"?: uuid }`.

## Desarrollo

```bash
cp .env.example .env   # cargar secretos (NUNCA se commitean)
npm install
npm run dev            # tsx watch
npm run typecheck      # tsc --noEmit
npm run test           # vitest
npm run build          # -> dist/
npm start              # node dist/server.js
```

### Variables de entorno

Ver `.env.example`. Todas obligatorias salvo `PORT`/`NODE_ENV`/`LOG_LEVEL`:
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `SERVICE_SHARED_TOKEN`.

## Deploy

Docker (multi-stage) + Coolify, como la PWA (ADR-004). Healthcheck contra `/health`.

## Reglas

Ver [`AGENTS.md`](AGENTS.md). Spec: ADR-006 / ADR-005 (en `nodoauto-database`, ver
[`docs/decisions/`](docs/decisions/006-intelligence-routing-loops-conocimiento.md)).
