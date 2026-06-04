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

describe("research console jobs", () => {
  test("converts typed requests to allowlisted CLI argv", () => {
    expect(jobRequestArgv({ jobType: "daily", assetClass: "equity", depth: "deep" })).toEqual([
      "daily",
      "--asset",
      "equity",
      "--deep",
    ]);
    expect(jobRequestArgv({ jobType: "ticker", symbol: "aapl", assetClass: "equity" })).toEqual([
      "ticker",
      "aapl",
      "--asset",
      "equity",
    ]);
    expect(jobRequestArgv({ jobType: "cache-prune" })).toEqual(["cache", "prune"]);
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
});
