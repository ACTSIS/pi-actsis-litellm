# Image generation in background jobs (issue #61)

Detached image rendering so the chat turn is not blocked while the gateway
renders. Opt-in per call; the blocking path stays the default.

## Specs

S1 (owner): "Un ajuste funcional para la generacion de imagenes, podriamos
    levantar la geenración en un hilo en paralelo, sin ocupar el hilo principal
    del chat?"

S2 (owner, option D): background is opt-in per call. The tool takes a boolean
    parameter `background` (default false = today's blocking behavior). When the
    model needs the result to decide the next step, waiting stays correct.

S3 (owner, option D): the manual path `/actsis-litellm:image --background`
    starts the same detached job.

S4: a detached call returns immediately with a job id and a tool-result text
    that (a) says the render is queued, (b) says the image will appear in the
    conversation by itself, and (c) tells the model NOT to call the tool again
    for the same prompt.

S5: on success the finished image is delivered as a custom message with
    customType `actsis-litellm:image` — rendered like today's `/image` output —
    WITHOUT triggering a new agent turn (`triggerTurn` stays false), and the
    session image store is updated at that moment so `image: "last"` works for
    the following edit.

S6: on failure the error is delivered as a visible custom message in the
    transcript plus `ui.notify`, and the job id is released.

S7: each detached job owns its own AbortController. The tool-call `signal`
    belongs to the active turn and must not be reused after `execute` returns.
    Cancellation: `/actsis-litellm:cancel-image <id|all>` reports which jobs it
    aborted (and says the render may keep running on the gateway GPU).

S8: while any job is in flight the UI shows it via `ctx.ui.setStatus` (job id +
    model + elapsed); the status key is cleared when the last job settles.

S9: an edit that resolves `image: "last"` while a render is still pending fails
    with a message that names the pending job id instead of an opaque error.

S10: `session_shutdown` aborts in-flight jobs idempotently (safe to run twice)
    and the user-facing text states that the render may keep running on the
    gateway GPU.

S11: concurrent detached jobs are capped (2). A call beyond the cap queues or is
    rejected with a message naming the running jobs — the gateway renders on a
    single GPU, so piling up requests only lengthens every wait.

Non-goals: persisting jobs across pi processes (closing pi kills the job while
the backend may keep rendering); changing the per-model/size timeouts from #57.

## Tasks

T1 (S1/S4/S7/S11): `extensions/lib/image-jobs.ts` — job registry (id, model,
   size, status, startedAt, AbortController, cap) + focused tests.
T2 (S2/S4): `background` tool parameter wired to the registry in
   `extensions/lib/image-tool.ts`; blocking path unchanged.
T3 (S3): `--background` flag on `/actsis-litellm:image` (`extensions/lib/image.ts`,
   `extensions/lib/commands.ts`, help text).
T4 (S5/S6): delivery on success/failure via the injected `sendMessage` +
   `ui.notify`; store updated on completion only.
T5 (S7): `/actsis-litellm:cancel-image` command + per-job AbortController.
T6 (S8/S9/S10/S11): status line, pending-`last` guard, `session_shutdown` abort,
   cap/queue behavior.
T7: docs (CHANGELOG + README/help) and delivery PR.

Route: T1-T6 delegated to gentle-ai-worker on `feat/61-image-background-jobs`;
T7 and the PR by the parent orchestrator.

## Log

L1 (2026-10-30, owner): "Un ajuste funcional para la generacion de imagenes,
   podriamos levantar la geenración en un hilo en paralelo, sin ocupar el hilo
   principal del chat?"
L2 (2026-10-30, owner): chose option D after being shown A (executionMode
   parallel only — does not free the turn), B (always background), C
   (`background` param, blocking default), D (C + `/image --background`).
L3 (2026-10-30, parent): runtime facts that shape the design — `pi.sendMessage`
   accepts `deliverAs`/`triggerTurn` and works after the tool returned;
   `session_shutdown` is the cancel hook; `onUpdate` heartbeats die when
   `execute` returns, so post-return progress must use `ctx.ui.setStatus`;
   `ToolDefinition.executionMode: "parallel"` only allows concurrent tool
   calls, the turn still waits. Issue #61, branch `feat/61-image-background-jobs`.
L4 (2026-10-30, parent): T1-T6 implemented by a delegated writer (`gentle-ai-worker`)
   on this branch. Parent verification against S1-S11 by reading the code, not the
   writer's report: per-job AbortController is the one passed to the fetcher while
   the tool-call `signal` stays on the blocking path; success delivery sends the
   custom message with no `triggerTurn` (index.ts calls `pi.sendMessage(message)`
   without options) and updates the store only after the render succeeds; the
   failure path emits a visible message plus `notify(..., "error")`; the status
   interval is cleared in `finally`; `session_shutdown` no-ops when nothing is
   active and its text names the gateway GPU; the cap message names the running
   ids. Suite 403/403 and typecheck green on the merged tree.
   Slice boundary (recorded per the work-unit rule): the implementation landed as
   ONE commit of ~914 authored lines across 12 files, over the ~400-line slice
   guidance on purpose — the compile unit is coupled (`index.ts` imports the new
   command handlers from `commands.ts`, and the detached runner is invoked from
   the tool), so splitting it would have produced commits that do not typecheck.
   Review workload is disclosed in the PR instead.
   Known verification gap (declared, not covered): the `session_shutdown` handler
   itself has no automated test because it is registered inline in `index.ts`;
   the underlying `cancelAll()` idempotency is covered by `test/image-jobs.test.ts`.
