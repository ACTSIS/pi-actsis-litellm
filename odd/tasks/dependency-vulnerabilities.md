# Feature: mitigar vulnerabilidades de dependencias (2 repos)

Cerrar las alertas de Dependabot y de `npm audit` de `pi-actsis-litellm` y
`opencode-actsis-litellm`, con evidencia de verificación por alerta y sin
regresión funcional. Doc primario: este archivo. Espejo:
`opencode-actsis-litellm/odd/tasks/dependency-vulnerabilities.md`.

## Inventario inicial (2026-11-11, `gh api .../dependabot/alerts`)

**pi-actsis-litellm — 6 alertas abiertas (4 high, 2 medium), todas en
`package-lock.json` y todas transitivas de devDependencies:**

| Paquete | Rango vulnerable | Corregida | Severidad | Origen |
| --- | --- | --- | --- | --- |
| undici | >= 8.0.0, < 8.12.2 | 8.12.2 | high ×4 (GHSA-2m5v-pch6-74hx, GHSA-4w7w-5xrc-9h26, GHSA-qrxm-fqhp-jwvm, GHSA-xjj6-f33q-929c) | `@earendil-works/pi-coding-agent` (devDependency) → `openai` |
| undici | >= 8.0.0, < 8.12.2 | 8.12.2 | medium (GHSA-9fm3-97px-rjf6) | ídem |
| brace-expansion | >= 4.0.0, < 5.0.12 | 5.0.12 | medium (GHSA-q2hr-2g5m-vwhr) | transitiva; `overrides` ya declarado pero **el lock no lo aplica** |

**opencode-actsis-litellm — 24 alertas abiertas:** undici (high ×4 + medium,
rangos 4.x/5.x/6.x y 8.x), vite 8.3.0–8.3.2 (1 high + 4 medium), glob
9.0.0–14.0.1, seroval 1.5.5–1.6.11, más un bloque de paquetes internos de npm
(`@npmcli/*`, sigstore, pacote, cacache…) y dos peers sin corrección
publicada (`@opencode/plugin *`, `@opencode/util *`).

## Specs

- **S1 — Cobertura.** Para toda alerta abierta que ya tenga versión corregida
  publicada, el lockfile del repo no debe contener ninguna instancia dentro
  del rango afectado: `gh api .../dependabot/alerts?state=open` y
  `npm audit --package-lock-only` deben quedar sin esa alerta.
- **S2 — Sin corrección no se inventa.** Las alertas sin versión corregida
  publicada (`@opencode/plugin`, `@opencode/util`) no se fuerzan: se
  documentan en el `## Log` con el paquete, el rango `*` y el motivo, y se
  proponen como seguimiento upstream.
- **S3 — Mecanismo mínimo.** La mitigación se hace con `overrides` de npm y,
  solo cuando el override no alcance, con el bump de la dependencia que la
  introduce. Prohibido `npm audit fix --force`, prohibido añadir dependencias
  nuevas, y cada cambio de rango debe quedar explicado en el CHANGELOG.
- **S4 — Sin regresión.** En ambos repos: suite completa y typecheck verdes
  (`npm test`/`npm run typecheck` en Pi; `npx vitest run`/`npx tsc --noEmit`
  en OpenCode), y `npm run bundle` en OpenCode produce `dist/` consistente.
  Si un override rompe la suite, se revierte **ese** override y se reporta
  como bloqueado con la salida exacta del fallo.
- **S5 — Instalación limpia.** `npm ci` debe funcionar en ambos repos sin
  flags extra (`--force`, `--legacy-peer-deps`); la deuda de peers de
  OpenCode queda resuelta o documentada con el conflicto exacto.

## Tasks

| ID | Spec | Route | Commit |
| --- | --- | --- | --- |
| T1 | S1, S3 — Pi: overrides de undici/brace-expansion + lock regenerado | inline | `chore(deps): override vulnerable undici and brace-expansion` |
| T2 | S4 — Pi: suite + typecheck + re-audit | inline | (evidencia en T1) |
| T3 | S1, S3 — OpenCode: overrides undici/vite/seroval/glob + lock | inline | `chore(deps): override vulnerable transitive dependencies` |
| T4 | S4, S5 — OpenCode: suite + typecheck + bundle + `npm ci` limpio | inline | `chore(deps): make npm ci work without peer flags` |
| T5 | S2 — registrar lo no mitigable y actualizar CHANGELOG en ambos | inline | `docs: record dependency vulnerability decisions` |
| T6 | S1, S4 — Pi: adaptar el código a `@earendil-works/pi-coding-agent@1.5.2` (unión discriminada `ProviderModelConfig`) sin cambio de comportamiento | writer | `refactor(catalog): follow the pi-coding-agent 1.5 model config union` |
| T7 | S1, S4 — Pi: verificación final (audit en cero, typecheck, suite) y CHANGELOG | inline | (evidencia en T6) |

## Log

- L1 (usuario, verbatim): "Es importantisimo revisar y mitigar todas las
  vulnerabilidades"
- L2: alcance interpretado = alertas de Dependabot/`npm audit` de los dos
  repos de este feature (los 6 de `pi-actsis-litellm` que se reportaron en el
  cierre anterior y el resto de OpenCode). Fuera de alcance: auditoría de
  código ajena a dependencias.
- L3: RDD está en `on`; el cierre de cada repo pasará por `gentle_review`
  `assess` y, si aplica, revisión nativa. Cambio de dependencias = risk item 5.
- L4 (hallazgo, 2026-11-11): en Pi, `@earendil-works/pi-coding-agent@0.87.1`
  **pinea `undici` a `8.10.2` exacto** y npm 9.2.0 no aplica `overrides`
  sobre un pin exacto (marca "overridden" pero conserva la versión), ni en
  forma plana ni anidada por padre, ni con árbol y lock limpios ni con
  `--prefer-online`. La única mitigación efectiva es subir la devDependency a
  `1.5.2` (la misma versión del runtime real), lo que deja `npm audit` en
  cero y cambia el tipo `ProviderModelConfig` a unión discriminada por `type`
  (`chat` | `image_generation` | `classifier`) — de ahí T6.
- L5 (cierre Pi, 2026-11-11): `npm audit` en **0 vulnerabilidades** (antes 4:
  2 high, 2 moderate). `npm run typecheck` en 0 y `npm test` 373/373 (la base
  de `main`; las 401 del feature de status incluyen sus tests propios, que no
  viven en esta rama). T6 resolvió 24 errores de tipo con `Extract` sobre el
  miembro de chat, sin añadir ningún campo en runtime: el payload del cache
  de catálogo queda byte-idéntico. El discriminante real en los tipos
  instalados es `"image"`, no `"image_generation"` (corrección al briefing).
