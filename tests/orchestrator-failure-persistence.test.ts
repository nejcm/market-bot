import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { InstrumentCommand } from "../src/cli/args";
import type { ModelProvider } from "../src/model/types";
import { FinalSynthesisRejectedError } from "../src/research/final-synthesis";
import { persistResearchJob } from "../src/research/orchestrator";
import type { CollectedSources } from "../src/sources/types";
import { collectedSources as collectedSourceBundle } from "./support/fixtures";
import {
  config,
  createDataDirRegistry,
  marketSnapshots,
  mockPredictions,
  modelReport,
  newsSources,
} from "./support/orchestrator-helpers";

const { cleanupDataDirs, tempDataDir } = createDataDirRegistry();
const command: InstrumentCommand = {
  jobType: "equity",
  assetClass: "equity",
  symbol: "AAPL",
  depth: "brief",
};

afterEach(cleanupDataDirs);

function modelPayload(summary: string): string {
  return JSON.stringify({
    ...JSON.parse(modelReport("AAPL")),
    summary,
    predictions: mockPredictions(2, "AAPL"),
  });
}

function providerReturningFinal(content: string): ModelProvider {
  return {
    name: "mock",
    generate: async (request) => {
      const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
      return {
        content: prompt.stage === "final-synthesis" ? content : modelReport("AAPL"),
        tokenEstimate: 100,
        costEstimateUsd: 0.01,
      };
    },
  };
}

function sources(overrides: Partial<CollectedSources> = {}): CollectedSources {
  return collectedSourceBundle({
    rawSnapshots: [],
    marketSnapshots,
    newsSources,
    sourceGaps: [],
    ...overrides,
  });
}

async function rejectAndCapture(
  dataDir: string,
  provider: ModelProvider,
  collectedSources: CollectedSources = sources(),
): Promise<FinalSynthesisRejectedError> {
  try {
    await persistResearchJob({
      command,
      config: { ...config, dataDir },
      provider,
      collectedSources,
      now: new Date("2026-05-19T00:00:00.000Z"),
      endClock: () => new Date("2026-05-19T00:01:00.000Z"),
    });
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(FinalSynthesisRejectedError);
    return error as FinalSynthesisRejectedError;
  }
  throw new Error("Expected final synthesis rejection");
}

describe("Failed Run Artifact persistence", () => {
  test("persists rejected synthesis diagnostics without completed report files", async () => {
    const dataDir = tempDataDir("market-bot-failed-run");
    const error = await rejectAndCapture(
      dataDir,
      providerReturningFinal(modelPayload("Buy AAPL after catalyst.")),
    );
    const [runId] = await readdir(dataDir);
    const runDir = join(dataDir, runId ?? "missing");
    const rootFiles = await readdir(runDir);
    const failure = JSON.parse(await readFile(join(runDir, "failure.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const stages = JSON.parse(await readFile(join(runDir, "stages.json"), "utf8")) as readonly {
      readonly stage: string;
    }[];

    expect(error.runDir).toBe(runDir);
    expect(error.message).toMatch(/Report failed validation after 4 final-synthesis call\(s\)/u);
    expect(rootFiles).toEqual(
      expect.arrayContaining([
        "failure.json",
        "rejected-report.json",
        "stages.json",
        "raw",
        "normalized",
      ]),
    );
    expect(rootFiles).not.toContain("report.json");
    expect(rootFiles).not.toContain("report.md");
    expect(rootFiles).not.toContain("trace.json");
    expect(rootFiles).not.toContain("analytics.json");
    expect(failure).toMatchObject({
      schemaVersion: 1,
      runId,
      phase: "final-synthesis",
      jobType: "equity",
      assetClass: "equity",
      symbol: "AAPL",
      depth: "brief",
      languageViolations: [{ field: "summary", match: "Buy AAPL" }],
      sourceGapsAsOf: "pre-synthesis",
    });
    expect(stages.filter((stage) => stage.stage === "final-synthesis")).toHaveLength(4);
    expect(JSON.parse(await readFile(join(runDir, "rejected-report.json"), "utf8"))).toMatchObject({
      summary: "Buy AAPL after catalyst.",
    });
  });

  test("records an empty draft violation list when deterministic assembly is rejected", async () => {
    const dataDir = tempDataDir("market-bot-failed-assembly");
    const sourceId = "extended-sec-test";
    const error = await rejectAndCapture(
      dataDir,
      providerReturningFinal(modelPayload("AAPL evidence is sourced.")),
      sources({
        extendedSources: [
          {
            id: sourceId,
            title: "AAPL SEC evidence",
            fetchedAt: "2026-05-19T00:00:00.000Z",
            kind: "extended-evidence",
            assetClass: "equity",
            symbol: "AAPL",
            provider: "sec-edgar",
          },
        ],
        extendedEvidence: {
          instrument: { assetClass: "equity", symbol: "AAPL" },
          items: [
            {
              category: "sec-edgar",
              title: "AAPL SEC evidence",
              summary: "Buy AAPL after catalyst.",
              sourceIds: [sourceId],
              observedAt: "2026-05-19T00:00:00.000Z",
            },
          ],
          gaps: [],
        },
      }),
    );
    const failure = JSON.parse(
      await readFile(join(error.runDir ?? "missing", "failure.json"), "utf8"),
    ) as { readonly languageViolations?: unknown };

    expect(failure.languageViolations).toEqual([]);
  });

  test("preserves the validator error when diagnostics persistence fails", async () => {
    const dataDir = tempDataDir("market-bot-failed-write");
    const randomUuid = spyOn(crypto, "randomUUID").mockReturnValue(
      "12345678-1234-1234-1234-123456789abc",
    );
    const runDir = join(dataDir, "2026-05-19T00-00-00-000Z-12345678");
    await mkdir(join(runDir, "raw"), { recursive: true });
    await mkdir(join(runDir, "normalized"), { recursive: true });
    await mkdir(join(runDir, "failure.json"));
    const stderr: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      const text = String(chunk);
      stderr.push(text);
      if (text.includes("Failed to persist run diagnostics:")) {
        throw new Error("stderr unavailable");
      }
      return true;
    }) as typeof process.stderr.write;

    try {
      const error = await rejectAndCapture(
        dataDir,
        providerReturningFinal(modelPayload("Buy AAPL after catalyst.")),
      );
      expect(error.message).toMatch(/Report failed validation after 4 final-synthesis call\(s\)/u);
      expect(error.runDir).toBeUndefined();
      expect(stderr.join("")).toContain("Failed to persist run diagnostics:");
      expect(await readdir(runDir)).toEqual(
        expect.arrayContaining(["failure.json", "rejected-report.json", "stages.json"]),
      );
    } finally {
      process.stderr.write = originalWrite;
      randomUuid.mockRestore();
    }
  });
});
