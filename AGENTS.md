# Nodo Auto Intelligence API — Reglas

> **⚠️ ESTÁNDAR DE CALIDAD: PRODUCCIÓN — NO MVP.**
> Nada acá es prototipo. Cada tarea cerrada queda **100% operativa, sin errores y con
> tests**. No se avanza con bugs, TODOs activos (sin ticket `C-XX`/`S-XX`) ni tests
> faltantes. `tsc --noEmit` EXIT 0 · `npm run test` verde · `npm run build` limpio.

## Preámbulo universal (idéntico en los 3 repos — ADR-005 §13)

- **Git trunk-based:** dos ramas permanentes (`main` = tronco integrado/verificado,
  `production` = puntero a lo desplegado, movido SOLO por el bot del CI). Ramas de
  tarea cortas y desechables: nacen de `origin/main`, se mergean por PR, se borran.
  Nunca `git add .` (stagear por archivo). Un agente por repo a la vez.
- **Primer push de rama nueva:** SIEMPRE `git push -u origin <rama>` (nombre explícito
  + `-u`); `git push` pelado falla en el primer push. No hay `gh`: el PR lo abre Silvina
  por el link que devuelve GitHub. Commits de `siladev`, **sin** `Co-Authored-By`.
- **Mentalidad de seguridad:** validación estricta de toda entrada externa (Zod con
  `max()`), secretos solo por env en módulos server-side, nunca devolver detalle crudo
  de error (Postgres/proveedor) al cliente — al cliente, mensaje genérico; el detalle a
  logs server-side. Defensa en profundidad: no confiar en una sola capa.
- **ADRs:** toda decisión costosa de revertir deja un ADR corto. Las decisiones de
  plataforma viven en `nodoauto-database/docs/decisions/` (este repo apunta).

## 1. Qué es este servicio (ADR-005 §3/§9/§14 · ADR-006)

`nodoauto-intelligence-api` es la capa de inteligencia de NODO AUTO. Es un **CONSUMIDOR**
de la plataforma de datos (`nodoauto-database` es dueño del esquema). Su trabajo:

- Recibe **comandos** HTTP (`POST /v1/analizar`) y responde **202 + job_id**. El HTTP
  transporta comandos y devuelve aceptación; **NUNCA devuelve el análisis** (ADR-005 §3).
- Procesa como caja negra: routing multi-modelo, inferencia, validación, persistencia.
- **Escribe `ai.*`** (jobs, análisis, suggestions) con **service_role**. `ai` es un
  schema **OCULTO** (no expuesto a PostgREST). La PWA **lee el resultado** por el
  contrato `api.analisis_caso_v1`, no por HTTP a este servicio.
- **Degradación:** si el servicio está caído, la PWA igual renderiza leyendo el contrato
  con `status`. El servicio NO es punto único de falla para la lectura.

## 2. Dos salidas, nunca mezcladas (ADR-005 §9 · ADR-006 §2)

1. **Análisis para usuarios → EN VIVO.** `ai.jobs` + `ai.analisis_caso`. Loop 1.
2. **Propuestas de mejora → NUNCA en vivo.** `ai.suggestions` (con **evidencia**
   obligatoria — sin evidencia no entra al triage). Loops 2 (contenido) y 3 (código).
   El servicio **DETECTA y PROPONE, NO aplica** (ADR-005 §14). NO hay —ni habrá en el
   runtime— ruta que aplique un cambio de código o contenido. El embudo es: triage de
   Silvina (vault) → gates del repo dueño → prod → verificación por métrica (`ai.evals`).

## 3. Disciplina de datos (es CONSUMIDOR, no dueño del esquema)

- **NO toca esquema.** Nada de DDL, migraciones ni edición de tipos del esquema `ai`.
  Un cambio de esquema se SOLICITA a `nodoauto-database` (database-first): implementa +
  testea, Silvina aplica, se sincroniza, recién entonces el servicio consume.
  `src/domain/database.types.ts` es un **espejo a mano y acotado** de las migraciones
  104/106 — solo las columnas que el servicio usa; se actualiza contra la migración, no
  inventando columnas.
- **Routing en DATOS:** elegir modelo se hace leyendo `ai.routing` + `ai.modelos`, nunca
  hardcodeando un `model_id` en el código (ADR-006 §1).
- **Cross-domain solo-lectura:** el servicio LEE `public.casos`/`public.usuarios` para
  re-verificar autorización; **nunca muta `public`** (ADR-005 ley 2). Referencias
  blandas (`caso_id`), sin FK física cross-domain.
- **Egress acotado / columnas explícitas:** prohibido `select('*')` sobre tablas que
  crecen. Constantes `COLUMNAS_*` por tabla.
- **`service_role` ignora RLS** → toda mutación por id filtra por dueño en código cuando
  aplica. RLS no es la única capa.

## 4. Seguridad del servicio

- **Auth de servicio server-to-server:** `Authorization: Bearer <SERVICE_SHARED_TOKEN>`,
  comparación en tiempo constante. El browser nunca conoce el token (vive server-side en
  la PWA). No hay sesión de usuario en este servicio.
- **Re-verificación de autorización** contra la DB antes de encolar (defensa en
  profundidad): el caso debe existir y el solicitante poder tocarlo.
- **Idempotencia:** comandos idempotentes por `(caso_id, tipo)` (UNIQUE en `ai.jobs`).
  Un retry no duplica trabajo.
- **Inyección en IA:** el comando NO recibe texto libre del cliente (solo `caso_id` +
  `tipo`); el contenido del caso sale de la DB y se **sanea** antes de incrustarlo en el
  prompt. El contenido del caso es DATO, nunca instrucciones.
- **Secretos por env**, validados al boot (`src/config/env.ts`, fail-fast). El único
  módulo que lee `process.env` es ese. Nunca loguear secretos (logger con `redact`).

## 5. Checklist de cierre (en orden)

1. `npm run typecheck` (tsc --noEmit) → EXIT 0
2. `npm run test` → verde (incluye `security.test.ts` por AGENTS §5)
3. `npm run build` → dist limpio
4. Estados explícitos en todo flujo (pendiente/procesando/listo/fallido visibles vía job)
5. Tests creados/actualizados en `tests/unit/` para toda feature nueva

## 6. No-goals (de esta fase F3)

- La PWA **todavía NO consume** el contrato (eso es F4: reemplazar `/api/analizar-caso`
  y sacar `ANTHROPIC_API_KEY` del env de la PWA).
- Sin lógica de IA en la DB. Sin autonomía sobre código/contenido. Sin worker
  distribuido ni cola externa (el procesamiento es in-process tras el 202; cuando crezca,
  se evalúa un worker dedicado como tarea con ticket).
