# Agent image tool: natural image generation/editing from chat

Owner request: ask for an image (generation or edit) NATURALLY in the chat;
the pi agent uses a TOOL (`generate_image`) to call the gateway, choosing
among the available image models (asking the user when relevant). Extends the
`/image` command (issue #47, PR #49) with a model-callable tool.

## Specs

S1 (owner): "sería increible que pudieramos pedir naturalmente desde el chat la
    generación o edició de una imagen, y el agente vía tool pueda ir y
    generarla, preguntando al usuario que modelo disponible utilizar"
    — natural chat request -> agent tool call -> gateway -> rendered image.

S2: Model selection policy: explicit tool param > heuristic (an image input
    present -> the editing-capable model, currently qwen-image-edit) >
    default `sdxl-pixel-art`. Available models are DISCOVERED from the
    gateway (`/v1/models`, mode=image_generation) — never hardcoded: the
    tool description carries the discovered list so the agent can ask the
    user to pick between real options.

S3: Editing path: tool accepts an image input ("last" = last generated/
    rendered image in this session, or a file path) -> multipart
    POST /v1/images/edits; no image input -> POST /v1/images/generations.

S4: Timeouts adaptive by model (Qwen 512 = 300 s, Qwen 1024 = 600 s,
    SDXL = 180 s floor from issue #47 S4); progress via onUpdate.

S5: Result renders with the existing image renderer; tool result text
    reports model/size/file/cost; the in-session image store updates for
    follow-up edits.

## Tasks

T1 (S2): image-model discovery from /v1/models (mode filter) + dynamic
       tool description builder.
T2 (S5/S3): session image store ("last") + image input resolution.
T3 (S1/S3): registerTool "actsis-litellm:generate_image": schema, execute
       (generations or edits), timeout by model/size, progress, renderer
       injection via pi.sendMessage.
T4: tests (mirror image-command.test.ts patterns): discovery filter,
       default-model policy, timeout map, last-image resolution, execute
       happy path with stubbed transport.
T5: docs (CHANGELOG/README) + commits + delivery flow (issue -> PR -> merge).

## Log

L1 (2026-10-29): Owner approved implementation ("Iniciemos") after the
   natural-request design discussion; issue #47's /image command exists
   (PR #49) but hardcodes the model — this tool supersedes its UX for
   natural requests while /image stays as the manual shortcut.L2 (2026-10-29): Implemented — extensions/lib/image-tool.ts (discovery,
   store, registry builder) + index.ts wiring (tool + throttled
   before_agent_start re-registration with discovered models; registerTool
   replaces same-name registrations and refreshes tools, per pi loader).
   Tests: test/image-tool.test.ts (26 new; suite 373/373, typecheck clean).
   NOTE: test order slipped — implementation first, tests written against
   it (recorded per test-first rule); the suite is the regression guard.
L3 (2026-10-29): Delivered — issue #50, PR #51, squash merge 61ed4aa to
   main. Live smoke: fresh headless pi session, a NATURAL chat request
   ("Generá una imagen pixel-art de un zorro rojo, tamaño 512") made the
   agent discover and call the tool -> gateway generation succeeded
   (SpendLogs sdxl-pixel-art 0.00245 at 16:00); the agent offered a
   follow-up edit referencing the image, confirming the S1 flow.
   Note: unrelated pre-existing warning in the extension loader about
   gentle-engram's peerDependencies (typebox) — out of scope here.
L4 (2026-10-29): Fix delivery — owner's cross-PC report: SDXL T2I ok,
   edits with qwen-image-edit always 400. Root cause: tool multipart field
   'files' unrecognized by LiteLLM's /v1/images/edits passthrough (request
   forwarded without the multipart body). Fixed to 'image[]' + regression
   test on the real FormData; verified end-to-end vs production (EDIT 200
   in 144 s). Issue #52, PR #53, merge 15ef11a to main.
L5 (2026-10-29): Description fix — owner's local session: asked for a 3D
   render, the agent inferred "qwen-image-edit = edit-only" from the name +
   description wording and re-styled a pixel-art image instead. Reworked
   description (both use cases per model; sdxl style baked in; 3D/realistic
   routing guidance) + regression test. Issue #54, PR #55, merge ba66e11.
