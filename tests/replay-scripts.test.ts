import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFixture } from "./support/run-fixtures";
import { readEvalSummary, runEvalBatch, runEvalSample } from "./support/run-fixtures/eval";
import { makeReplayProvider } from "../src/replay/llm-cassette";

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test.each(["completed", "failed-final-synthesis", "threw", "incomplete", "not-exercised"] as const)(
  "shared script runner writes diagnostics and summary before returning for %s samples",
  async (status) => {
    const root = await mkdtemp(join(tmpdir(), "market-bot-replay-batch-"));
    roots.push(root);
    const fixture = await loadFixture("equity-aapl-brief");
    for (const samples of [1, 2]) {
      const label = `batch-${String(samples)}`;
      // eslint-disable-next-line no-await-in-loop -- samples write isolated state sequentially
      const exitCode = await runEvalBatch({
        root,
        label,
        fixtures: [fixture.name],
        samples,
        runSample: async (name, sample) => {
          if (sample === "2") {
            const prior = await readEvalSummary(root, label);
            expect(prior.samples.map((record) => record.status)).toEqual([status]);
          }
          const result = await runEvalSample({
            root,
            label,
            fixture: name,
            sample,
            llm: "replay",
            provider: makeReplayProvider(fixture.llmCassette),
          });
          const record = { ...result, status: sample === "1" ? status : ("completed" as const) };
          await writeFile(join(result.sampleDir, "eval-sample.json"), JSON.stringify(record));
          return record;
        },
      });
      expect(exitCode).toBe(status === "completed" ? 0 : 1);
      // eslint-disable-next-line no-await-in-loop
      const summary = await readEvalSummary(root, label);
      expect(summary.samples[0]?.status).toBe(status);
      expect(summary.samples).toHaveLength(samples);
      for (const sample of summary.samples) {
        // eslint-disable-next-line no-await-in-loop
        const record = JSON.parse(
          await readFile(
            join(root, label, sample.fixture, sample.sample, "eval-sample.json"),
            "utf8",
          ),
        );
        expect(record.modelCalls.live).toBe(0);
        expect(record.modelCalls.replayed).toBe(3);
      }
    }
  },
);

test("live and selected-stage samples with zero live calls are not exercised", async () => {
  const root = await mkdtemp(join(tmpdir(), "market-bot-eval-no-calls-"));
  roots.push(root);
  const script = join(root, "no-calls.ts");
  await writeFile(
    script,
    `
import { mock } from "bun:test";
import { writeFile } from "node:fs/promises";
const fixtures = await import(${JSON.stringify(join(import.meta.dir, "support/run-fixtures/index.ts"))});
mock.module(${JSON.stringify(join(import.meta.dir, "support/run-fixtures/index.ts"))}, () => ({
  ...fixtures, runFixture: async () => ({}),
}));
const { runEvalSample } = await import(${JSON.stringify(join(import.meta.dir, "support/run-fixtures/eval.ts"))});
const results = [];
for (const mode of ["live", "final-synthesis"]) {
  results.push(await runEvalSample({
    root: ${JSON.stringify(root)}, label: mode, fixture: "equity-aapl-brief", sample: "1",
    llm: mode === "live" ? "live" : "replay",
    ...(mode === "final-synthesis" ? { liveStages: "final-synthesis" } : {}),
    provider: { name: "fake", generate: async () => { throw new Error("unexpected fake model call"); } },
  }));
}
await writeFile(${JSON.stringify(join(root, "results.json"))}, JSON.stringify(results));
`,
  );
  const child = Bun.spawn(
    [process.execPath, "--preload", join(import.meta.dir, "support/setup.ts"), script],
    {
      cwd: root,
      env: { MARKET_BOT_PROVIDER: "live-provider-must-not-be-created" },
      stdout: Bun.file(join(root, "stdout")),
      stderr: Bun.file(join(root, "stderr")),
    },
  );
  const exitCode = await child.exited;
  expect(exitCode, await readFile(join(root, "stderr"), "utf8")).toBe(0);
  const results = JSON.parse(await readFile(join(root, "results.json"), "utf8"));
  expect(results.map((result: { status: string }) => result.status)).toEqual([
    "not-exercised",
    "not-exercised",
  ]);
  expect(results.map((result: { modelCalls: { live: number } }) => result.modelCalls.live)).toEqual(
    [0, 0],
  );
});
