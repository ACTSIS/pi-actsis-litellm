import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ImageJobRegistry, MAX_CONCURRENT_IMAGE_JOBS, IMAGE_JOB_STATUS_KEY } from "../extensions/lib/image-jobs.ts";

describe("ImageJobRegistry (T1)", () => {
  it("creates jobs with stable short ids and tracks status", () => {
    const registry = new ImageJobRegistry();
    const job = registry.create("sdxl-pixel-art", "512x512");
    assert.match(job.id, /^img-\d+$/);
    assert.equal(job.model, "sdxl-pixel-art");
    assert.equal(job.size, "512x512");
    assert.equal(job.status, "queued");
    assert.ok(job.startedAt > 0);
    assert.ok(job.controller);
    assert.deepEqual(registry.list(), [job]);
  });

  it("transitions queued -> running -> done", () => {
    const registry = new ImageJobRegistry();
    const job = registry.create("m", "512x512");
    assert.ok(registry.start(job.id));
    assert.equal(registry.get(job.id)?.status, "running");
    assert.ok(registry.settle(job.id, "done"));
    assert.equal(registry.get(job.id)?.status, "done");
    assert.deepEqual(registry.running(), []);
  });

  it("rejects creation beyond the concurrency cap naming running jobs (S11)", () => {
    const registry = new ImageJobRegistry();
    const j1 = registry.create("m", "512x512");
    registry.start(j1.id);
    const j2 = registry.create("m", "512x512");
    registry.start(j2.id);
    assert.throws(
      () => registry.create("m", "512x512"),
      (err: unknown) => {
        const msg = (err as Error).message;
        assert.match(msg, /2\/2/);
        assert.match(msg, new RegExp(j1.id));
        assert.match(msg, new RegExp(j2.id));
        return true;
      },
    );
  });

  it("cancel(id) aborts the job's own controller and marks it cancelled (S7)", () => {
    const registry = new ImageJobRegistry();
    const job = registry.create("m", "512x512");
    registry.start(job.id);
    assert.equal(job.controller.signal.aborted, false);
    const cancelled = registry.cancel(job.id);
    assert.ok(cancelled);
    assert.equal(cancelled!.id, job.id);
    assert.equal(cancelled!.status, "cancelled");
    assert.equal(job.controller.signal.aborted, true);
  });

  it("cancel(id) is a no-op for settled jobs", () => {
    const registry = new ImageJobRegistry();
    const job = registry.create("m", "512x512");
    registry.settle(job.id, "done");
    assert.equal(registry.cancel(job.id), undefined);
  });

  it("cancelAll() aborts every active job and returns their ids", () => {
    const registry = new ImageJobRegistry();
    const j1 = registry.create("m", "512x512");
    registry.start(j1.id);
    const j2 = registry.create("m", "512x512");
    registry.start(j2.id);
    const ids = registry.cancelAll();
    assert.deepEqual(ids, [j1.id, j2.id]);
    assert.equal(j1.controller.signal.aborted, true);
    assert.equal(j2.controller.signal.aborted, true);
  });

  it("list() exposes all jobs including settled ones", () => {
    const registry = new ImageJobRegistry();
    const j1 = registry.create("m", "512x512");
    registry.settle(j1.id, "done");
    const j2 = registry.create("m", "512x512");
    assert.deepEqual(registry.list().map((j) => j.id).sort(), [j1.id, j2.id].sort());
  });
});
