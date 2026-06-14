# Runbook — Desplegar `nodoauto-intelligence-api` (Coolify + `intelligence.nodoauto.com`)

Pasos para dejar el servicio **operativo y funcional** en el VPS (Coolify v4 + Traefik +
Cloudflare Full Strict), igual que la PWA (ADR-004). El servicio buildea desde su
`Dockerfile` (multi-stage, Node 24.12, healthcheck en `/health`).

## Modelo mental (cómo "sube" el repo y de dónde sale el contenedor)

- El repo **ya está en GitHub** (`siladev/nodoauto-intelligence-api`). Coolify **clona
  desde GitHub** — no se "sube" el repo a Coolify ni se pushea una imagen a un registry.
- **No se pre-construye una imagen ni se "crea el contenedor" como paso aparte.** En Coolify
  se crea una **Application** conectada al repo con Build Pack **Dockerfile**; en cada deploy
  Coolify hace `docker build` desde el `Dockerfile` del repo (en el VPS) y corre el contenedor.
  Por eso no hace falta Docker local.

## Secuencia recomendada (de-risked: verificar el contenedor antes del pipeline)

Crear y **verificar** la app en Coolify apuntando a `main` (que ya existe) ANTES de mergear
el PR de producción. Así probás que la imagen buildea y el contenedor levanta sano, y recién
después atás el pipeline `production`:

1. **GitHub App** → dar acceso al repo (§2). Sin esto Coolify no lo ve.
2. **Coolify → New Application** desde el repo, **branch `main`**, Dockerfile, puerto 8787,
   healthcheck `/health` (§3).
3. **Env** (los 4 secrets + PORT/NODE_ENV, §4). El contenedor **no levanta sin ellos**
   (validación fail-fast al boot).
4. **Deploy manual** en Coolify → verificar build OK y `/health` 200 (prueba el contenedor
   de punta a punta, sin tocar el pipeline todavía).
5. **Mergear el PR** `feat/ci-promote-production` → el job `promote` **crea `production`**.
6. **Coolify:** cambiar branch monitoreada a **`production`** + Auto Deploy ON (+ branch
   protection en `production`). Ver "Flujo de producción" en §3.
7. **Cloudflare** subdominio (§1) + **dominio** en Coolify (§5).
8. **Seed routing** (§0, bloqueante para el análisis) → **smoke test** (§6) → degradación (§7).

> **Bloqueante a no olvidar:** sin el seed de `ai.modelos`/`ai.routing` (§0) el deploy "anda"
> (responde 202 y `/health` 200) pero **cada análisis cae a `fallido`** por falta de routing.
> El `/health` y la verificación del contenedor (paso 4) NO dependen del seed.

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

Panel: **dash.cloudflare.com → dominio `nodoauto.com` → DNS → Records**.

1. **Primero copiá la IP del VPS** de un registro existente que ya apunte al VPS (el de la
   PWA, p. ej. el `A` de `@`/`nodoauto.com` o `www`). Anotá ese IPv4.
2. **Add record:**
   - **Type:** `A`
   - **Name:** `intelligence` (Cloudflare lo expande a `intelligence.nodoauto.com`)
   - **IPv4 address:** la IP del VPS del paso 1
   - **Proxy status:** **Proxied** (nube naranja) — mantiene CF Full Strict + reglas
     anti-bot vigentes (ver [[cloudflare-cache-y-bots]] / [[vps-hardening]])
   - **TTL:** Auto
   - **Save**

El firewall del VPS solo acepta tráfico de Cloudflare (CF-only); al ir proxied, el
subdominio entra por el mismo camino que la PWA. **No abrir puertos nuevos.**

---

## 2. GitHub — dar acceso del repo al GitHub App de Coolify (repo privado)

El repo es **privado**, así que Coolify necesita acceso vía su **GitHub App** (la misma que
ya usa la PWA). El flujo de deploy es **PR → Merge → Coolify** (no push directo a una rama
de tarea): Coolify observa la rama integrada y despliega cuando esa rama avanza por un merge.

**Cómo CHEQUEAR qué usa la PWA hoy (para replicar exactamente):**
- Coolify → abrí la aplicación de la **PWA** → pestaña **Configuration → General / Source**.
  Mirá el campo **Source** (dice `GitHub App: <nombre>` o `Deploy Key`) y el campo
  **Branch** (qué rama observa: `main` o `production`).
- O en el sidebar de Coolify → **Sources** → ahí figura el/los GitHub App instalados.

**Dar acceso al repo nuevo (si el GitHub App NO está en "All repositories"):**
- GitHub → tu avatar → **Settings → Applications → Installed GitHub Apps** → el app de
  Coolify → **Configure** → **Repository access** → **Only select repositories** → agregá
  `siladev/nodoauto-intelligence-api` → **Save**. (Si está en "All repositories", ya tiene
  acceso y no hay que tocar nada.)

---

## 3. Coolify — crear la aplicación

1. **New Resource → Application → Private Repository (with GitHub App)** → elegí el **mismo
   GitHub App** que la PWA → repo `siladev/nodoauto-intelligence-api`.
2. **Branch:** **`production`** (igual que la PWA: el CI mueve `production` tras pasar los
   gates; ver "Flujo de producción" abajo). ⚠️ Cambiá la branch a `production` recién cuando
   el CI haya creado esa rama (primer merge a `main` con el job `promote`), si no Coolify
   observa una rama que aún no existe.
3. **Build Pack: Dockerfile** (el repo trae `Dockerfile` multi-stage + `.dockerignore`).
   **No** usar Nixpacks.
4. **Port (Ports Exposes): `8787`** — el server escucha en `PORT` (default 8787).
5. **Health Check:** path `/health`, puerto `8787` (el Dockerfile ya define un
   `HEALTHCHECK` interno; Coolify puede usar el suyo además).
6. **Auto Deploy: ON** — Coolify recibe el webhook del GitHub App y, al avanzar la rama
   observada (por un **merge** de PR), buildea y despliega zero-downtime. Ver
   [[project_pipeline_deploy]].

### Flujo de producción (idéntico a la PWA, `docs/runbooks/deploy.md` del repo PWA)

```
PR → Merge a `main`
  └─ GitHub Actions (.github/workflows/ci.yml)
       job `gates`:   tsc · test · build
       job `promote`: si gates verde Y push a main → git push origin HEAD:production
            └─ webhook GitHub → Coolify (rama `production`)
                 └─ docker build (Dockerfile) → health check `/health` → rolling swap
```

Si cualquier gate falla, `production` no avanza y prod queda intacto. El job `promote`
hace **fast-forward only** (sin `--force`): si `production` divergió, falla a propósito.

**Puesta en marcha (una vez):**
1. Mergear a `main` el PR que agrega el job `promote` al CI (rama `feat/ci-promote-production`).
   Ese merge dispara el CI; el job `promote` **crea `production`** desde el SHA verificado.
2. (Recomendado) GitHub → Settings → Branches → regla para `production` que **bloquee
   pushes manuales** (solo el workflow de Actions la mueve). Igual que la PWA.
3. En Coolify, poné la **branch monitoreada = `production`** (paso 3.2 de arriba). Auto Deploy ON.

A partir de ahí: PR → Merge a `main` → gates verdes → `production` avanza sola → Coolify
despliega. Rollback: Coolify → Deployments → *Redeploy* de la imagen anterior, o
`git push origin <SHA-anterior>:production --force-with-lease`.

---

## 4. Variables de entorno (Coolify → Environment Variables)

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

## 5. Dominio + SSL en Coolify

1. En la app → **Domains**: `https://intelligence.nodoauto.com`.
2. Coolify genera la label de Traefik y el cert (Let's Encrypt / o el modo que use la PWA
   con Cloudflare **Full Strict**). Confirmar que el esquema sea `https` y que Traefik rutea
   al puerto `8787`.
3. Redeploy.

---

## 6. Smoke test (post-deploy)

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

## 7. Degradación (verificación de diseño)

Apagar el servicio en Coolify y repetir la query del paso 5e: la lectura por
`api.analisis_caso_v1` **sigue respondiendo** (con el `status` del último job). El servicio
**no es punto único de falla** para la lectura (ADR-005 §3). Volver a encender.

---

## 8. Pendiente posterior (no bloquea el deploy)

- **F4:** la PWA consume `api.analisis_caso_v1` server-side, reemplaza `/api/analizar-caso`
  y **saca `ANTHROPIC_API_KEY` de su env** (pasa a vivir solo acá). Sesión aparte.
- Worker dedicado si el volumen crece (hoy procesa in-process tras el 202) — abrir ticket.
- Replicar el patrón `production` + promoción por CI si se quiere el mismo trunk-based de
  la PWA.
