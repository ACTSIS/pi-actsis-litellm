# Feature: issue-47-image-command

Implement `/image` in the extension: pixel-art generation via the gateway's
`/v1/images/generations` (model `sdxl-pixel-art`), rendered into the session.

## Specs

- S1 (verbatim, issue #47): "`/image <prompt>` → `POST {gateway}/v1/images/generations`
  with the existing authenticated credential (`extractUsableApiKey`), body
  `{"model":"sdxl-pixel-art","prompt":"...","n":1,"size":"512x512","output_format":"png"}`."
- S2 (verbatim, issue #47): "Render the returned `data[].b64_json` as an image
  attachment in the current session (pi TUI supports image parts); fallback:
  save under a session temp path and print the file path."
- S3 (verbatim, issue #47): "Optional flags: `--size 512|768|1024` (default 512
  for latency), maybe `--model <image-model-id>` for future image models
  (sd-server is currently single-model; upstream id is `sd-cpp-local`, gateway
  alias is the routing key)."
- S4 (verbatim, issue #47): "UX: generation is synchronous (14-48 s; OpenAI
  images API is sync) — show a progress notification; guard with a client-side
  timeout ≥ 180 s."
- S5 (verbatim, issue #47, acceptance): "`/image a dragon` produces a rendered
  pixel-art dragon image in the session."
- S6 (verbatim, issue #47, acceptance): "Works with the same OAuth/API-key
  credential used by the chat models (no new login flow)."
- S7 (verbatim, issue #47, acceptance): "Model picker behavior unchanged (no
  image model leaking into the chat list)."
- S8 (verbatim, issue #47, acceptance): "Timeout + friendly error on gateway
  failure; no partial/spent generation silently lost (spend shows in /usage)."

## Tasks

- [x] T1 → S1, S3, S4: client `fetchImageGeneration` (request shape, flags,
  timeout 180 s, error typing) — extensions/lib/image.ts.
- [x] T2 → S1, S2, S5, S6, S8: `/image` command wired to the usable
  credential, progress notify, displayed custom message + saved png fallback
  (extensions/lib/image.ts, extensions/lib/image-renderer.ts, commands.ts).
- [x] T3 → S1, S4, S7, S8: registration + help text + README docs + changelog;
  picker-untouched regression from catalog tests (352 pass).

## Log

- L1 (user, 2026-10-29 session): "Trabajemos con las issues" (#48 + #47).
- L2 (design decision): the image is rendered as a DISPLAYED custom message
  (`pi.sendMessage({ customType: "actsis-litellm:image", display: true })`)
  with a registered pi-tui renderer — it never triggers a model turn. The
  spec's `sendUserMessage` idea would have fired an agent turn per image;
  `sendMessage` display path satisfies S2/S5 without that cost. details carry
  the saved file path for text-only terminals (kitty/iterm2 render inline).
- L3 (live evidence, 2026-10-29): POST /v1/images/generations with
  ricardo.pinto's Acceso-Completo session token returned 1 png in 13.4 s at
  512x512 (365860 b64 chars, valid PNG magic). Full unit suite 352 pass.
- L4 (evidence recorded): T1-T3 in commit feat/48-catalog-scope (image
  command commit).

## Log

- L1 (user, 2026-10-29 session): "Trabajemos con las issues" (#48 + #47).- L5 (delivery 2026-10-29): PR #49 (Closes #47) merged to main at 6f3a9cc;
  CI green. Delivery found a test-env defect (env restore left later tests
  without a gateway URL on CI, which has no ~/.pi files): fixed by setting
  ACTSIS_LITELLM_URL per test (commit 742a1ef). In-TUI verification of
  /image after an interactive pi session remains as the last acceptance
  item (needs a real session, done by the user).
