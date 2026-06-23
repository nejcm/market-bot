import { describe, expect, test } from "bun:test";
import { createJobQueue, jobRequestArgv, type JobRunResult } from "../app/jobs";
import { handleResearchConsoleRequest } from "../app/server";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  const holder: { resolve?: (value: T) => void } = {};
  const promise = new Promise<T>((resolve) => {
    holder.resolve = resolve;
  });

  return {
    promise,
    resolve: (value: T) => {
      holder.resolve?.(value);
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(5);
  }

  throw new Error("Timed out waiting for condition");
}

describe("research console app jobs", () => {
  test("converts typed requests to allowlisted CLI argv", () => {
    expect(jobRequestArgv({ jobType: "daily", assetClass: "equity", depth: "deep" })).toEqual([
      "daily",
      "--asset",
      "equity",
      "--deep",
    ]);
    expect(jobRequestArgv({ jobType: "equity", symbol: "aapl", depth: "deep" })).toEqual([
      "equity",
      "aapl",
      "--deep",
    ]);
    expect(jobRequestArgv({ jobType: "crypto", symbol: "btc" })).toEqual(["crypto", "btc"]);
    expect(jobRequestArgv({ jobType: "research", subject: "AI biotech", depth: "deep" })).toEqual([
      "research",
      "AI",
      "biotech",
      "--deep",
    ]);
    expect(jobRequestArgv({ jobType: "cache-prune" })).toEqual(["cache", "prune"]);
    expect(() => jobRequestArgv({ jobType: "research", subject: " " })).toThrow(
      "Expected research subject",
    );
    expect(() => jobRequestArgv({ jobType: "shell", command: "echo nope" })).toThrow(
      "Unsupported job type",
    );
  });

  test("runs one queued job at a time", async () => {
    const first = deferred<JobRunResult>();
    const second = deferred<JobRunResult>();
    const mutableCalls: string[][] = [];
    const queue = createJobQueue((argv) => {
      mutableCalls.push([...argv]);
      return mutableCalls.length === 1 ? first.promise : second.promise;
    });

    const firstJob = queue.enqueue({ jobType: "score" });
    const secondJob = queue.enqueue({ jobType: "calibration" });
    await waitFor(() => queue.get(firstJob.id)?.status === "running");

    expect(queue.get(secondJob.id)?.status).toBe("queued");
    first.resolve({ exitCode: 0, stdout: "Score pass complete\n", stderr: "" });
    await waitFor(() => queue.get(secondJob.id)?.status === "running");
    second.resolve({ exitCode: 1, stdout: "", stderr: "failed\n" });
    await waitFor(() => queue.get(secondJob.id)?.status === "failed");

    expect([...mutableCalls]).toEqual([["score"], ["calibration"]]);
    expect(queue.get(firstJob.id)?.status).toBe("succeeded");
    expect(queue.get(secondJob.id)?.stderr).toBe("failed\n");
  });

  test("captures job output while the process is still running", async () => {
    const running = deferred<JobRunResult>();
    const queue = createJobQueue((_argv, onOutput) => {
      onOutput?.("stderr", "collecting sources\n");
      onOutput?.("stdout", "stage started\n");
      return running.promise;
    });

    const job = queue.enqueue({ jobType: "provider-health" });
    await waitFor(() => queue.get(job.id)?.stderr === "collecting sources\n");

    expect(queue.get(job.id)).toMatchObject({
      status: "running",
      stdout: "stage started\n",
      stderr: "collecting sources\n",
    });

    running.resolve({ exitCode: 0, stdout: "done\n", stderr: "complete\n" });
    await waitFor(() => queue.get(job.id)?.status === "succeeded");

    expect(queue.get(job.id)).toMatchObject({
      stdout: "done\n",
      stderr: "complete\n",
    });
  });

  test("caps retained jobs and captured output", async () => {
    const queue = createJobQueue(
      async () => ({ exitCode: 0, stdout: "1234567890", stderr: "abcdefghij" }),
      { maxOutputChars: 4, maxRetainedJobs: 2 },
    );

    const firstJob = queue.enqueue({ jobType: "score" });
    await waitFor(() => queue.get(firstJob.id)?.status === "succeeded");
    const secondJob = queue.enqueue({ jobType: "calibration" });
    await waitFor(() => queue.get(secondJob.id)?.status === "succeeded");
    const thirdJob = queue.enqueue({ jobType: "provider-health" });
    await waitFor(() => queue.get(thirdJob.id)?.status === "succeeded");

    expect(queue.get(firstJob.id)).toBeUndefined();
    expect(queue.list().map((job) => job.id)).toEqual([thirdJob.id, secondJob.id]);
    expect(queue.get(thirdJob.id)?.stdout).toBe("1234\n[truncated]");
    expect(queue.get(thirdJob.id)?.stderr).toBe("abcd\n[truncated]");
  });

  test("serves job API with injected queue", async () => {
    const queue = createJobQueue(async () => ({
      exitCode: 0,
      stdout: "data/runs/run-1\n",
      stderr: "",
    }));

    const createResponse = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/jobs", {
        method: "POST",
        body: JSON.stringify({ jobType: "provider-health" }),
      }),
      { jobQueue: queue },
    );

    expect(createResponse.status).toBe(202);
    const created = (await createResponse.json()) as { id: string };
    await waitFor(() => queue.get(created.id)?.status === "succeeded");

    const listResponse = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/jobs"),
      { jobQueue: queue },
    );

    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      jobs: [{ id: created.id, status: "succeeded", outputRunPath: "data/runs/run-1" }],
    });
  });

  test("rejects unsupported API job requests", async () => {
    const queue = createJobQueue(async () => ({ exitCode: 0, stdout: "", stderr: "" }));

    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/jobs", {
        method: "POST",
        body: JSON.stringify({ jobType: "shell", command: "echo nope" }),
      }),
      { jobQueue: queue },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Unsupported job type" });
    expect(queue.list()).toEqual([]);
  });

  test("rejects cross-origin job POSTs", async () => {
    const queue = createJobQueue(async () => ({ exitCode: 0, stdout: "", stderr: "" }));

    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/jobs", {
        method: "POST",
        headers: { origin: "https://example.test" },
        body: JSON.stringify({ jobType: "provider-health" }),
      }),
      { jobQueue: queue },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Job request origin is not allowed",
    });
    expect(queue.list()).toEqual([]);
  });
});
