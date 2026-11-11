# Feature: usuario y team de LiteLLM en el comando status

Mostrar en `/actsis-litellm:status` (Pi) el usuario conectado al gateway y el
team de LiteLLM con el que se habilitó la conexión. Feature doc primario: este
archivo. Espejo OpenCode: `opencode-actsis-litellm/odd/tasks/status-identity.md`
(misma Specs S1–S8).

## Specs

Sin credencial alguna, el status no hace red y responde `User: no credential` /
`Team: no credential` (S1, S2).

### S1 — El status muestra el usuario conectado

Formato exacto de la línea (partes disponibles, separadas por `, ` dentro del
paréntesis):

- con email, alias y rol: `User: ricardo.pinto@actsis.com (RPINTO, proxy_admin)`
- sin rol: `User: ricardo.pinto@actsis.com (RPINTO)`
- sin alias: `User: ricardo.pinto@actsis.com (proxy_admin)`
- sin email: `User: RPINTO (proxy_admin)`
- sin email ni alias: `User: 2ed0da75-556d-4c8f-99da-727d7e085fd4`
- nada resoluble: `User: unknown`
- sin credencial: `User: no credential`
- fallo al consultar identidad: `User: unavailable (<motivo en una sola línea>)`

El valor de identidad nunca se repite dentro del paréntesis.

### S2 — El status muestra el team de la conexión

Team de la conexión = `credential.teamId` (el que fijó el login/consent).

- alias resuelto: `Team: Acceso-Completo (ad59169e-f0c9-45a3-aa73-eec187533bdf)`
- alias no resoluble, teamId presente: `Team: ad59169e-f0c9-45a3-aa73-eec187533bdf (alias unavailable)`
- sin teamId (API key o sesión sin team): `Team: none (no team bound)`
- sin credencial: `Team: no credential`

### S3 — Fuente de la identidad

`GET {baseUrl}/user/info` con `Authorization: Bearer <credential>`. Se lee
`user_info` y, si no existe, el nivel raíz (`user_id`). Allowlist de campos
aceptados: `user_id`, `user_email`, `user_alias`, `user_role` (strings no
vacíos) y `teams` (array de strings). Cualquier otro campo se descarta. Si el
fetch falla o el cuerpo no es JSON objeto, la identidad queda vacía (S1/S2
degradan; S6).

### S4 — Alias del team

1. `GET {baseUrl}/team/list`: si el cuerpo es un array, construir
   `team_id -> team_alias` con los `team_alias` que sean strings no vacíos.
2. Si (1) falla, no es array o no contiene el team buscado:
   `GET {baseUrl}/team/info?team_id=<teamId>` y usar `team_alias` si es string
   no vacío.
3. Si (1) y (2) no resuelven: se muestra solo el id (S2).

Ambos intentos son best-effort: su fallo nunca rompe el status (S6).

### S5 — El payload crudo no se expone

La respuesta de `/user/info` incluye `keys[].token` en claro. La identidad se
reduce a la allowlist de S3 en memoria, **no se imprime** nada fuera de las
líneas S1/S2 y **no se persiste en disco** (ni en el cache de catálogo ni en
archivos nuevos).

### S6 — La identidad es no fatal

Si la consulta de identidad o de alias falla, el resto de líneas del status
(`Provider:`, `Auth:`, `Credential source:`, `Catalog:`, `Catalog scope:`,
`Gateway:`, `Budget:`) queda exactamente igual que hoy y el comando responde
con las líneas degradadas de S1/S2. Un `AuthError` (401/403) se refleja como
motivo, no como excepción.

### S7 — Paridad y posición de las líneas

Ambos clientes emiten las dos líneas nuevas con el mismo texto y en este orden:

- Pi (`/actsis-litellm:status`): después de `Credential source:` y antes de
  `Catalog:`.
- OpenCode (`actsis_litellm_status`): después de `Auth:` y antes de `Catalog:`.

### S8 — Documentación

README (tabla de comandos + sección de status) y CHANGELOG (sección
"Sin publicar") actualizados en ambos repos, en español como el resto del
CHANGELOG.

## Tasks

| ID | Spec | Route | Commit |
| --- | --- | --- | --- |
| T1 | S3, S4, S5 — módulo `extensions/lib/identity.ts` + `test/identity.test.ts` | writer (pi) | `feat(status): fetch gateway user identity and team alias` |
| T2 | S1, S2, S6, S7, S8 — cablear en `buildStatusHandler`, tests de status, docs | writer (pi) | `feat(status): show connected user and team` |
| T3 | S3, S4, S5 — módulo `src/identity.ts` + tests | writer (opencode) | `feat(status): fetch gateway user identity and team alias` |
| T4 | S2 — preservar y extraer `teamId` de la metadata de la credencial | writer (opencode) | `feat(status): expose credential teamId to status` |
| T5 | S1, S2, S6, S7, S8 — cablear en `status()`, tests, docs | writer (opencode) | `feat(status): show connected user and team` |

## Log

- L1 (usuario, verbatim): "Necesitamos arreglar algo importantisimo, nuestro
  comando status no trae el nombre del usuario conectado al gateway, ni en Pi ni
  en Opencode, y ya algunos usuarios me han pedido que ajuste eso, porque no
  saben con que usuario estan conectados ni con que team de LiteLLM habilitaron
  la conexión"
- L2: alcance autorizado = Pi + OpenCode en el mismo trabajo (respuesta del
  usuario a la pregunta de alcance).
- L3: autorizado leer la configuración/credencial local y consultar el gateway
  real (respuesta del usuario).
- L4 (evidencia del gateway `https://ai.actsis.internal`, 2026-11-11):
  `GET /user/info` → `{"user_id":…,"user_info":{…,"user_alias":"RPINTO",
  "user_email":"ricardo.pinto@actsis.com","user_role":"proxy_admin",
  "teams":["9fd46572-…","ad59169e-…"],"team_id":null,…},"keys":[{"token":
  "<en claro>",…}]}`; `GET /team/list` → `team_id ad59169e-…` tiene
  `team_alias:"Acceso-Completo"`; `GET /team/info?team_id=` en este gateway
  **no** devuelve `team_alias`; `GET /v1/user/info` → 404 (la ruta buena es la
  sin `/v1`).
- L5 (cierre Pi, 2026-11-11): T1 y T2 completadas y verificadas. Evidencia
  end-to-end contra el gateway real con la credencial almacenada:
  `User: ricardo.pinto@actsis.com (RPINTO, proxy_admin)` y
  `Team: Acceso-Completo (ad59169e-f0c9-45a3-aa73-eec187533bdf)`. `npm test`
  400/400 y `npm run typecheck` en 0.
- L6 (frontera de slice, 2026-11-11): 1124 líneas autoradas en
  `feat/status-identity` — 667 de tests, 299 de código de producción, 160 de
  docs — por encima de la guía de ~400 por PR. Estrategia de entrega (Git):
  PR encadenado o dos PRs — **A** = T1 (`extensions/lib/identity.ts` +
  `test/identity.test.ts`), **B** = T2 (`commands.ts`, `test/commands.test.ts`,
  README, CHANGELOG). Push y creación de PR son decisión del usuario.
