# ADR-006 — puntero

La spec de este servicio (routing multi-modelo, los tres loops de mejora, el contrato
HTTP `POST /v1/analizar`, la superficie `ai.*` y el contrato de lectura
`api.analisis_caso_v1`) vive en el repo dueño de la plataforma:

→ `../../../nodoauto-database/docs/decisions/006-intelligence-routing-loops-conocimiento.md`

Y su marco general (ownership de base de datos, integración híbrida PWA↔Intelligence,
Intelligence propone-no-dispone) en ADR-005, mismo directorio del repo-DB:

→ `../../../nodoauto-database/docs/decisions/005-database-owner-independiente.md`

Para leer los originales, la sesión hace `/add-dir` a `nodoauto-database`
(ADR-005 §13: un dato, un dueño; los demás repos APUNTAN, no copian).
