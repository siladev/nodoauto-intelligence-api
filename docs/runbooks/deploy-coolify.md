# Runbook — Desplegar `nodoauto-intelligence-api` (Coolify + `intelligence.nodoauto.com`)

Pasos para dejar el servicio **operativo y funcional** en el VPS (Coolify v4 + Traefik +
Cloudflare Full Strict), igual que la PWA (ADR-004). El servicio buildea desde su
`Dockerfile` (multi-stage, Node 24.12, healthcheck en `/health`).

> **Orden recomendado:** 0 (seed DB — bloqueante) → 1 (DNS) → 2 (Coolify app + env) →
> 3 (dominio/SSL) → 4 (smoke test). Sin el paso 0 el deploy "anda" (responde 202) pero
> **cada análisis cae a `fallido`** por falta de routing.

---

## 0. PREREQUISITO BLOQUEANTE — sembrar `ai.modelos` + `ai.routing` (database-first)

El servicio elige el modelo **leyendo `ai.routing` + `ai.modelos`** (routing en datos,
ADR-006 §1). Hoy esas tablas están **vacías** → sin al menos 1 modelo + 1 ruta para
`analisis_caso`, todo job termina en `fallido` (`RoutingError`).

Esto es **database-first**: el seed lo implementa y testea `nodoauto-database` (nueva
migración, p. ej. `107_ai_seed_routing.sql`), Silvina lo aplica, y recién entonces el
servicio funciona. **NO** se siembra desde este repo (es consumidor, no toca esquema).

SQL propuesto para solicitar a `nodoauto-database` (precios USD/millón de tokens y
context window al 2026-06; el costo es informativo y se recalibra con `ai.evals`):

```sql
-- Catálogo de modelos (Anthropic). alias = nombre estable interno; model_id = id exacto.
insert into ai.modelos (proveedor, model_id, alias, capacidades, costo_in_usd_mtok, costo_out_usd_mtok, contexto_tokens, activo)
values
  ('anthropic', 'claude-opus-4-8',   'opus',   '{razonamiento}'::text[],  5.0, 25.0, 1000000, true),
  ('anthropic', 'claude-sonnet-4-6', 'sonnet', '{razonamiento}'::text[],  3.0, 15.0, 1000000, true),
  ('anthropic', 'claude-haiku-4-5',  'haiku',  '{razonamiento}'::text[],  1.0,  5.0,  200000, true)
on conflict (proveedor, model_id) do nothing;

-- Routing del tipo de tarea `analisis_caso`: preferido sonnet (balance costo/calidad,
-- = comportamiento actual de la PWA), fallback haiku. Cambiar de modelo es UNA fila.
insert into ai.routing (tipo_tarea, modelo_preferido, modelo_fallback, max_tokens_out, activo)
select 'analisis_caso', pref.id, fb.id, 1024, true
from   ai.modelos pref, ai.modelos fb
where  pref.alias = 'sonnet' and fb.alias = 'haiku'
on conflict (tipo_tarea) do nothing;
```

Verificar (MCP solo-lectura) que quedó 1 ruta activa con preferido activo:

```sql
select r.tipo_tarea, mp.alias as preferido, mf.alias as fallback, r.activo
from ai.routing r
join ai.modelos mp on mp.id = r.modelo_preferido
left join ai.modelos mf on mf.id = r.modelo_fallback;
```

Tras aplicar, refrescar el baseline de `nodoauto-database` (las filas seed entran en
`12_ai`/seeds según el procedimiento de introspección de ese repo).

---

## 1. DNS — `intelligence.nodoauto.com` (Cloudflare)

En el panel Cloudflare del dominio `nodoauto.com`:

- Registro **A** (o **CNAME** al host del VPS) `intelligence` → IP del VPS (la misma que
  sirve la PWA).
- **Proxied (nube naranja) ON** — mantiene Cloudflare adelante (Full Strict + las reglas
  anti-bot ya vigentes, ver [[cloudflare-cache-y-bots]] / [[vps-hardening]]).
- TTL Auto.

El firewall del VPS solo acepta tráfico de Cloudflare (CF-only); al ir proxied, el
subdominio entra por el mismo camino que la PWA. No abrir puertos nuevos.

---

## 2. Coolify — crear la aplicación

1. **New Resource → Application → Public Repository** (o GitHub App) apuntando a
   `github.com/siladev/nodoauto-intelligence-api`, branch **`main`** (o `production` si
   se replica el patrón de la PWA; ver más abajo).
2. **Build Pack: Dockerfile** (el repo ya trae `Dockerfile` multi-stage + `.dockerignore`).
   No usar Nixpacks.
3. **Port (Ports Exposes): `8787`** — el server escucha en `PORT` (default 8787).
4. **Health Check:** path `/health`, puerto `8787` (el Dockerfile ya define un
   `HEALTHCHECK` interno contra `/health`; Coolify puede usar el suyo además).
5. **Deploy on push:** activar el webhook como en la PWA (push a la branch desplegable →
   build + deploy zero-downtime). Ver [[project_pipeline_deploy]].

### Branch desplegable (`main` vs `production`)

La PWA despliega desde `production` (puntero movido por el CI). Para el primer arranque
del servicio podés desplegar directo desde `main`. Si querés el mismo patrón trunk-based
(CI mueve `production`), replicá el workflow de promoción del repo de la PWA en una
sesión aparte — no es necesario para dejarlo funcionando hoy.

---

## 3. Variables de entorno (Coolify → Environment Variables)

Cargar como **secrets** (no en el repo). Ver `.env.example`. El boot valida y **falla
rápido** si falta alguna (`src/config/env.ts`):

| Variable | Valor |
|---|---|
| `SUPABASE_URL` | `https://onsclpwsspmfxitcnvld.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key del proyecto (Supabase → Settings → API). **Secreto.** |
| `ANTHROPIC_API_KEY` | API key de Anthropic. **Secreto.** (En F4 sale del env de la PWA.) |
| `SERVICE_SHARED_TOKEN` | token compartido PWA↔servicio (generar abajo). **Secreto.** |
| `PORT` | `8787` |
| `NODE_ENV` | `production` |
| `LOG_LEVEL` | `info` |

**Generar el `SERVICE_SHARED_TOKEN`** (32 bytes, url-safe):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

> El **mismo** valor de `SERVICE_SHARED_TOKEN` se cargará en la PWA en **F4** (server-only)
> para que llame al servidor con `Authorization: Bearer <token>`. Guardalo en el gestor de
> secretos; el browser nunca lo ve.

---

## 4. Dominio + SSL en Coolify

1. En la app → **Domains**: `https://intelligence.nodoauto.com`.
2. Coolify genera la label de Traefik y el cert (Let's Encrypt / o el modo que use la PWA
   con Cloudflare **Full Strict**). Confirmar que el esquema sea `https` y que Traefik rutea
   al puerto `8787`.
3. Redeploy.

---

## 5. Smoke test (post-deploy)

**a) Salud (sin auth):**

```bash
curl -s https://intelligence.nodoauto.com/health
# → {"ok":true,"servicio":"nodoauto-intelligence-api"}
```

**b) Auth de servicio — sin token debe dar 401:**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  https://intelligence.nodoauto.com/v1/analizar \
  -H 'content-type: application/json' -d '{"caso_id":"d6adcf00-eabc-4eb9-b6b6-e015bb8fe653"}'
# → 401
```

**c) Comando válido — 202 + job_id** (usar un `caso_id` real; ej. el caso vivo
`d6adcf00-eabc-4eb9-b6b6-e015bb8fe653`):

```bash
curl -s -X POST https://intelligence.nodoauto.com/v1/analizar \
  -H "authorization: Bearer $SERVICE_SHARED_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"caso_id":"d6adcf00-eabc-4eb9-b6b6-e015bb8fe653"}'
# → {"job_id":"...","status":"pendiente","idempotente":false}
# (un segundo POST idéntico → "idempotente":true, mismo job_id)
```

**d) Verificar el resultado del lado DB (MCP solo-lectura o panel):**

```sql
-- El job se procesó y registró costo/tokens/modelo:
select status, modelo_usado, tokens_in, tokens_out, costo_usd, error
from ai.jobs where caso_id = 'd6adcf00-eabc-4eb9-b6b6-e015bb8fe653' and tipo = 'analisis_caso';

-- El análisis quedó escrito:
select status, severidad, confianza, modelo_usado, tokens_total
from ai.analisis_caso where caso_id = 'd6adcf00-eabc-4eb9-b6b6-e015bb8fe653';
```

**e) Contrato de lectura (lo que la PWA usará en F4)** — refleja el resultado con `status`:

```sql
select caso_id, status, severidad, confianza, modelo_usado, analizado_at
from api.analisis_caso_v1
where caso_id = 'd6adcf00-eabc-4eb9-b6b6-e015bb8fe653';
```

Si `ai.jobs.status` quedó en `fallido`, leer `ai.jobs.error` (server-side): lo más probable
es que falte el paso 0 (seed de routing) o las env (`ANTHROPIC_API_KEY`).

---

## 6. Degradación (verificación de diseño)

Apagar el servicio en Coolify y repetir la query del paso 5e: la lectura por
`api.analisis_caso_v1` **sigue respondiendo** (con el `status` del último job). El servicio
**no es punto único de falla** para la lectura (ADR-005 §3). Volver a encender.

---

## 7. Pendiente posterior (no bloquea el deploy)

- **F4:** la PWA consume `api.analisis_caso_v1` server-side, reemplaza `/api/analizar-caso`
  y **saca `ANTHROPIC_API_KEY` de su env** (pasa a vivir solo acá). Sesión aparte.
- Worker dedicado si el volumen crece (hoy procesa in-process tras el 202) — abrir ticket.
- Replicar el patrón `production` + promoción por CI si se quiere el mismo trunk-based de
  la PWA.
