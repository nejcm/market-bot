import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { InstrumentCommand } from "../src/cli/args";
import {
  attachReusableWebCompanyProfile,
  findReusableWebCompanyProfile,
  latestSecFilingDate,
} from "../src/research/web-company-profile-reuse";
import type { WebCompanyProfileArtifact } from "../src/sources/extended-evidence/web-company-profile";
import type { ExtendedEvidence, Source } from "../src/domain/types";
import { collectedSources } from "./support/fixtures";

const tmpDirs: string[] = [];

const command: InstrumentCommand = {
  jobType: "equity",
  assetClass: "equity",
  symbol: "AAPL",
  depth: "deep",
};

const webSource: Source = {
  id: "web-aapl-12345678",
  title: "Apple business profile",
  url: "https://example.com/apple-profile",
  fetchedAt: "2026-05-01T00:00:00.000Z",
  kind: "web",
  assetClass: "equity",
  symbol: "AAPL",
  provider: "exa",
};

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function tempRunsDir(): string {
  const dir = join(
    tmpdir(),
    `market-bot-web-profile-reuse-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    "runs",
  );
  tmpDirs.push(dirname(dir));
  return dir;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function profile(
  input: {
    readonly sourceIds?: readonly string[];
    readonly generatedAt?: string;
  } = {},
): WebCompanyProfileArtifact {
  const sourceIds = input.sourceIds ?? [webSource.id];
  const answer = { answer: "Apple sells devices and services.", sourceIds };
  return {
    version: 1,
    generatedAt: input.generatedAt ?? "2026-05-01T00:00:00.000Z",
    symbol: "AAPL",
    companyName: "Apple Inc.",
    questions: {
      whatItDoes: answer,
      howItMakesMoney: answer,
      customers: answer,
      geography: answer,
      purchaseRecurrence: answer,
      pricingPower: answer,
      recessionCyclicality: answer,
    },
    recentMaterialEvents: [{ claim: "Apple reports services revenue.", sourceIds }],
    factLedger: [{ claim: "Apple sells hardware and services.", sourceIds }],
    openGaps: [],
    sourceIds,
    secFilingBasisDate: "2026-04-25",
  };
}

async function writePriorRun(input: {
  readonly dataDir: string;
  readonly runId: string;
  readonly symbol: string;
  readonly sourceIds?: readonly string[];
  readonly sources?: readonly Source[];
  readonly generatedAt?: string;
}): Promise<void> {
  const runDir = join(input.dataDir, input.runId);
  await writeJson(join(runDir, "report.json"), {
    runId: input.runId,
    jobType: "equity",
    assetClass: "equity",
    symbol: input.symbol,
    generatedAt: input.generatedAt ?? "2026-05-01T00:00:00.000Z",
    summary: "Prior profile run.",
    keyFindings: [],
    bullCase: [],
    bearCase: [],
    risks: [],
    catalysts: [],
    scenarios: [],
    confidence: "medium",
    dataGaps: [],
    predictions: [],
    sources: input.sources ?? [webSource],
    notFinancialAdvice: true,
    extras: { depth: "deep" },
  });
  await writeJson(
    join(runDir, "normalized", "web-company-profile.json"),
    profile({
      ...(input.sourceIds !== undefined ? { sourceIds: input.sourceIds } : {}),
      ...(input.generatedAt !== undefined ? { generatedAt: input.generatedAt } : {}),
    }),
  );
}

describe("web company profile reuse", () => {
  test("reuses fresh same-symbol profile when no newer SEC filing exists", async () => {
    const dataDir = tempRunsDir();
    await writePriorRun({ dataDir, runId: "prior-aapl", symbol: "AAPL" });

    const reuse = await findReusableWebCompanyProfile({
      dataDir,
      command,
      now: new Date("2026-05-20T00:00:00.000Z"),
      reuseDays: 30,
      currentSecFilingDate: "2026-04-25",
    });

    expect(reuse?.profile.companyName).toBe("Apple Inc.");
    expect(reuse?.sources.map((source) => source.id)).toEqual([webSource.id]);
    expect(reuse?.gap.message).toContain("19 days old");
  });

  test("rejects reuse when a newer current SEC filing exists", async () => {
    const dataDir = tempRunsDir();
    await writePriorRun({ dataDir, runId: "prior-aapl", symbol: "AAPL" });

    const reuse = await findReusableWebCompanyProfile({
      dataDir,
      command,
      now: new Date("2026-05-20T00:00:00.000Z"),
      reuseDays: 30,
      currentSecFilingDate: "2026-05-10",
    });

    expect(reuse).toBeUndefined();
  });

  test("rejects profiles older than the reuse TTL", async () => {
    const dataDir = tempRunsDir();
    await writePriorRun({ dataDir, runId: "prior-aapl", symbol: "AAPL" });

    const reuse = await findReusableWebCompanyProfile({
      dataDir,
      command,
      now: new Date("2026-06-02T00:00:00.000Z"),
      reuseDays: 30,
      currentSecFilingDate: "2026-04-25",
    });

    expect(reuse).toBeUndefined();
  });

  test("rejects profiles generated in the future", async () => {
    const dataDir = tempRunsDir();
    await writePriorRun({
      dataDir,
      runId: "prior-aapl",
      symbol: "AAPL",
      generatedAt: "2026-06-01T00:00:00.000Z",
    });

    const reuse = await findReusableWebCompanyProfile({
      dataDir,
      command,
      now: new Date("2026-05-20T00:00:00.000Z"),
      reuseDays: 30,
      currentSecFilingDate: "2026-04-25",
    });

    expect(reuse).toBeUndefined();
  });

  test("rejects different symbols", async () => {
    const dataDir = tempRunsDir();
    await writePriorRun({ dataDir, runId: "prior-msft", symbol: "MSFT" });

    const reuse = await findReusableWebCompanyProfile({
      dataDir,
      command,
      now: new Date("2026-05-20T00:00:00.000Z"),
      reuseDays: 30,
      currentSecFilingDate: "2026-04-25",
    });

    expect(reuse).toBeUndefined();
  });

  test("rejects profiles with unresolved source IDs", async () => {
    const dataDir = tempRunsDir();
    await writePriorRun({
      dataDir,
      runId: "prior-aapl-bad-source",
      symbol: "AAPL",
      sourceIds: ["missing-source"],
      sources: [webSource],
    });

    const reuse = await findReusableWebCompanyProfile({
      dataDir,
      command,
      now: new Date("2026-05-20T00:00:00.000Z"),
      reuseDays: 30,
      currentSecFilingDate: "2026-04-25",
    });

    expect(reuse).toBeUndefined();
  });

  test("attaches reused profile, cited web sources, and freshness gap", () => {
    const attached = attachReusableWebCompanyProfile({
      command,
      collectedSources: collectedSources(),
      reuse: {
        profile: profile(),
        sources: [webSource],
        runDirName: "prior-aapl",
        gap: {
          source: "web-company-profile",
          message: "Reused web company profile from 2026-05-01T00:00:00.000Z (19 days old).",
          provider: "market-bot",
          capability: "extended-evidence",
          cause: "stale-fallback",
          evidenceQualityImpact: "extended-evidence-cap",
        },
      },
    });

    expect(attached.webCompanyProfile?.sourceIds).toEqual([webSource.id]);
    expect(attached.extendedSources).toEqual([webSource]);
    expect(attached.sourceGaps).toHaveLength(1);
    expect(attached.extendedEvidence?.items).toEqual([
      expect.objectContaining({ category: "web-company-profile", sourceIds: [webSource.id] }),
    ]);
  });

  test("reads the current SEC filing date from extended evidence", () => {
    const evidence: ExtendedEvidence = {
      instrument: { assetClass: "equity", symbol: "AAPL" },
      items: [
        {
          category: "sec-edgar",
          title: "Older filing",
          summary: "Older filing.",
          sourceIds: ["sec-old"],
          observedAt: "2026-05-01T00:00:00.000Z",
          metrics: { filingDate: "2026-04-01" },
        },
        {
          category: "sec-edgar",
          title: "Latest filing",
          summary: "Latest filing.",
          sourceIds: ["sec-new"],
          observedAt: "2026-05-10T00:00:00.000Z",
          metrics: { filingDate: "2026-05-10" },
        },
      ],
      gaps: [],
    };

    expect(latestSecFilingDate(evidence)).toBe("2026-05-10");
  });
});
