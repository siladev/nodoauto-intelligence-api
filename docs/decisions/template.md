# ADR-NNN: Título corto de la decisión

- **Fecha:** AAAA-MM-DD
- **Estado:** aceptada | reemplazada por ADR-XXX-NNN
- **ID canónico:** ADR-INTEL-NNN — convención 2026-08-01: todo ADR se cita SIEMPRE
  con prefijo de repo (`ADR-APP-` / `ADR-DB-` / `ADR-INTEL-`); "ADR-NNN" a secas
  está prohibido (los números se repiten entre repos y ya causó ambigüedad).
  Numeración por repo; este arranca en ADR-INTEL-001. Los archivos existentes de
  otros repos no se renombran.
- **Implementación (asiento AAAA-MM-DD):** cumplida | parcial | incumplida — 1 frase.
  Se actualiza cuando la realidad cambia; el índice del vault lo lee de acá.

## Contexto

Qué problema o restricción motivó la decisión (2-4 líneas).

## Decisión

Qué se decidió, en una frase afirmativa. Alternativas descartadas y por qué
(1 línea cada una).

## Consecuencias

Qué implica hacia adelante: qué se gana, qué deuda o límite acepta, qué la
haría revisitar.

<!--
Cuándo escribir un ADR: toda decisión técnica costosa de revertir
(elección de versión/librería/patrón de infra). 10 líneas alcanzan.
Las decisiones de PRODUCTO van al vault (nodoauto-vault/06_DECISIONES,
formato una-decisión-un-archivo con validación de Silvina), no acá.
La spec de plataforma que gobierna este servicio vive en el repo-DB
(ADR-DB-005/006/007/008): ese marco se APUNTA, no se copia.
-->
