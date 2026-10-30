export type ImageJobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface ImageJob {
  id: string;
  model: string;
  size: string;
  status: ImageJobStatus;
  startedAt: number;
  controller: AbortController;
}

export const MAX_CONCURRENT_IMAGE_JOBS = 2;

export const IMAGE_JOB_STATUS_KEY = "actsis-litellm:image-jobs";

export class ImageJobRegistry {
  private jobs = new Map<string, ImageJob>();
  private counter = 0;

  get size(): number {
    return this.jobs.size;
  }

  create(model: string, size: string): ImageJob {
    const running = this.running();
    if (running.length >= MAX_CONCURRENT_IMAGE_JOBS) {
      throw new Error(
        `Too many concurrent image renders (${running.length}/${MAX_CONCURRENT_IMAGE_JOBS}). ` +
          `Running jobs: ${running.map((j) => j.id).join(", ")}. ` +
          `Wait for one to finish or cancel it with /actsis-litellm:cancel-image <id>.`,
      );
    }
    const id = `img-${++this.counter}`;
    const controller = new AbortController();
    const job: ImageJob = {
      id,
      model,
      size,
      status: "queued",
      startedAt: Date.now(),
      controller,
    };
    this.jobs.set(id, job);
    return job;
  }

  get(id: string): ImageJob | undefined {
    return this.jobs.get(id);
  }

  list(): ImageJob[] {
    return Array.from(this.jobs.values());
  }

  running(): ImageJob[] {
    return this.list().filter((j) => j.status === "running");
  }

  active(): ImageJob[] {
    return this.list().filter((j) => j.status === "queued" || j.status === "running");
  }

  start(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== "queued") return false;
    job.status = "running";
    return true;
  }

  settle(id: string, status: "done" | "failed" | "cancelled"): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.status = status;
    return true;
  }

  remove(id: string): boolean {
    return this.jobs.delete(id);
  }

  cancel(id: string): ImageJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.status === "done" || job.status === "failed" || job.status === "cancelled") {
      return undefined;
    }
    job.status = "cancelled";
    job.controller.abort();
    return job;
  }

  cancelAll(): string[] {
    const ids: string[] = [];
    for (const job of this.list()) {
      if (job.status === "queued" || job.status === "running") {
        this.cancel(job.id);
        ids.push(job.id);
      }
    }
    return ids;
  }
}
