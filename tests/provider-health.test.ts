import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import type { AssetClass, JobType, Source, SourceGap } from "../src/domain/types";
import {
  buildProviderHealthSummary,
  parseSourceGap,
  writeProviderHealthSummary,
} from "../src/health/provider-health";
import { INDEX_SCHEMA_VERSION } from "../src/run-artifact-index";
import { RUN_ARTIFACT_FILES } from "../src/run-artifact-layout";
import { deepEquityEvidenceBundle } from "./support/fixtures";

let tmpDir = "";
let dataDir = "";

interface RunFixture {
  readonly runId: string;
  readonly jobType: JobType;
  readonly assetClass: AssetClass;
  readonly symbol?: string;
  readonly depth?: "brief" | "deep";
  readonly generatedAt?: string;
  readonly sources?: readonly Partial<Source>[];
  readonly gaps?: readonly SourceGap[];
  readonly selectedNewsSourceCount?: number;
  readonly repeatFallbackKeptCount?: number;
  readonly relevantRepeatKeptCount?: number;
  readonly predictions?: readonly { readonly horizonTradingDays: number }[];
  readonly scores?: readonly { readonly resolved: boolean }[];
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "provider-health-test-"));
  dataDir = join(tmpDir, "runs");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, undefined, 2)}\n`, "utf8");
}

function newsSource(id: string): Partial<Source> {
  return {
    id,
    title: id,
    fetchedAt: "2026-06-01T00:00:00.000Z",
    kind: "news",
    provider: "yahoo",
  };
}

function marketSource(id: string, symbol: string, exchange = "NASDAQ"): Partial<Source> {
  return {
    id,
    title: id,
    fetchedAt: "2026-06-01T00:00:00.000Z",
    kind: "market-data",
    assetClass: "equity",
    symbol,
    provider: "yahoo",
    identity: { exchange, quoteCurrency: exchange === "NASDAQ" ? "USD" : "GBP" },
  };
}

async function writeRun(fixture: RunFixture): Promise<void> {
  const generatedAt = fixture.generatedAt ?? "2026-06-01T00:00:00.000Z";
  const sources = fixture.sources ?? [newsSource(`${fixture.runId}-news`)];

  await writeJson(join(dataDir, fixture.runId, "report.json"), {
    runId: fixture.runId,
    generatedAt,
    jobType: fixture.jobType,
    assetClass: fixture.assetClass,
    ...(fixture.symbol !== undefined ? { symbol: fixture.symbol } : {}),
    ...(fixture.depth !== undefined ? { depth: fixture.depth } : {}),
    sources,
    predictions: fixture.predictions ?? [],
  });
  await writeJson(
    join(dataDir, fixture.runId, "normalized", "source-gaps.json"),
    fixture.gaps ?? [],
  );
  if (fixture.jobType === "equity" && fixture.depth === "deep" && fixture.symbol !== undefined) {
    const base = deepEquityEvidenceBundle();
    await writeJson(
      join(dataDir, fixture.runId, RUN_ARTIFACT_FILES.evidenceBundle),
      deepEquityEvidenceBundle({
        run: { symbol: fixture.symbol, analysisAsOf: generatedAt },
        governance: {
          ...base.governance,
          sourceGaps: fixture.gaps ?? [],
          sourcePlan: {
            ...base.governance.sourcePlan,
            generatedAt,
            run: {
              jobType: "equity",
              assetClass: "equity",
              symbol: fixture.symbol,
              depth: "deep",
            },
          },
          evidenceLanes: { ...base.governance.evidenceLanes, generatedAt },
          sourceLedger: { ...base.governance.sourceLedger, generatedAt },
        },
        context: {
          historicalContext: { ...base.context.historicalContext, generatedAt },
        },
      }),
    );
  }
  await writeJson(join(dataDir, fixture.runId, "analytics.json"), {
    newsDedupe: {
      selectedNewsSourceCount:
        fixture.selectedNewsSourceCount ??
        sources.filter((source) => source.kind === "news").length,
      persistentSuppressedNewsSourceCount: 0,
      repeatFallbackKeptCount: fixture.repeatFallbackKeptCount ?? 0,
      ...(fixture.relevantRepeatKeptCount !== undefined
        ? { relevantRepeatKeptCount: fixture.relevantRepeatKeptCount }
        : {}),
    },
    evidenceQuality: {
      extendedEvidence: { itemCount: fixture.depth === "deep" ? 1 : 0, gapCount: 0 },
      marketContext: {
        itemCount: fixture.jobType === "equity" || fixture.jobType === "crypto" ? 0 : 1,
        gapCount: 0,
      },
    },
  });
  await writeJson(join(dataDir, fixture.runId, "score.json"), {
    scores: fixture.scores ?? [],
  });
}

async function writeCalibration(): Promise<void> {
  await writeJson(join(tmpDir, "calibration", "summary.json"), {
    generatedAt: "2026-06-02T00:00:00.000Z",
  });
}

async function writeBaselineRuns(
  overrides: Readonly<Record<string, Partial<RunFixture>>> = {},
): Promise<void> {
  const fixtures: readonly RunFixture[] = [
    { runId: "daily-equity", jobType: "daily", assetClass: "equity" },
    { runId: "weekly-equity", jobType: "weekly", assetClass: "equity" },
    { runId: "daily-crypto", jobType: "daily", assetClass: "crypto" },
    { runId: "weekly-crypto", jobType: "weekly", assetClass: "crypto" },
    { runId: "ticker-equity", jobType: "equity", assetClass: "equity", symbol: "AAPL" },
    { runId: "ticker-crypto", jobType: "crypto", assetClass: "crypto", symbol: "BTC" },
    {
      runId: "deep-equity",
      jobType: "equity",
      assetClass: "equity",
      symbol: "MSFT",
      depth: "deep",
    },
    {
      runId: "international-equity",
      jobType: "equity",
      assetClass: "equity",
      symbol: "VOD.L",
      sources: [
        newsSource("international-news"),
        marketSource("international-market", "VOD.L", "LSE"),
      ],
    },
  ];

  for (const fixture of fixtures) {
    await writeRun({ ...fixture, ...overrides[fixture.runId] });
  }
}

describe("provider health", () => {
  test("keeps news repeat counters independent and ignores absent relevant-repeat fields", async () => {
    await writeRun({
      runId: "relevant-repeat",
      jobType: "equity",
      assetClass: "equity",
      relevantRepeatKeptCount: 6,
    });
    await writeRun({
      runId: "fallback-repeat",
      jobType: "equity",
      assetClass: "equity",
      repeatFallbackKeptCount: 4,
    });
    await writeRun({ runId: "no-repeats", jobType: "equity", assetClass: "equity" });

    const result = await writeProviderHealthSummary(dataDir, new Date("2026-06-02T12:00:00.000Z"));

    expect(result.summary.realRunValidation.repeatFallbackKept).toBe(4);
    expect(result.summary.realRunValidation.relevantRepeatKept).toBe(6);
    await expect(readFile(result.markdownPath, "utf8")).resolves.toContain(
      "| Relevant repeat kept | 6 |",
    );
  });

  test("includes Failed Run Artifacts, their Source Gaps, and outcome rows", async () => {
    await writeRun({ runId: "completed", jobType: "equity", assetClass: "equity" });
    await writeJson(join(dataDir, "failed", RUN_ARTIFACT_FILES.failure), {
      runId: "failed",
      generatedAt: "2026-06-01T01:00:00.000Z",
      jobType: "equity",
      assetClass: "equity",
    });
    await writeJson(join(dataDir, "failed", RUN_ARTIFACT_FILES.outcomes), [
      {
        subsystem: "final-synthesis",
        expectation: "expected",
        outcome: "failed",
        code: "validation-exhausted",
      },
    ]);
    await writeJson(join(dataDir, "failed", RUN_ARTIFACT_FILES.sourceGaps), [
      {
        source: "failed-provider",
        provider: "failed-provider",
        message: "collection gap from rejected run",
      },
    ]);

    const result = await writeProviderHealthSummary(dataDir, new Date("2026-06-02T12:00:00.000Z"));
    const { summary } = result;

    expect(summary.runCount).toBe(2);
    expect(summary.runsByJobType).toEqual({ equity: 2 });
    expect(summary.gapOverview.total).toBe(1);
    expect(summary.routes.map((route) => route.route)).toContain("failed-provider");
    expect(summary.subsystemOutcomes.failedRunCount).toBe(1);
    expect(summary.subsystemOutcomes.byOutcome.failed).toBe(1);
    expect(summary.subsystemOutcomes.ledgerStatus).toEqual({ ok: 1, absent: 1, malformed: 0 });
    expect(
      summary.subsystemOutcomes.ledgerStatus.ok +
        summary.subsystemOutcomes.ledgerStatus.absent +
        summary.subsystemOutcomes.ledgerStatus.malformed,
    ).toBe(summary.runCount);
    const markdown = await readFile(result.markdownPath, "utf8");
    expect(markdown).toContain("| Failed Run Artifacts | 1 |");
    expect(markdown).toContain("| Outcome ledger ok | 1 |");
    expect(markdown).toContain("| Outcome ledger absent | 1 |");
    expect(markdown).toContain(
      "Failed Run Artifacts count `failure.json`. Outcome-ledger status counts `outcomes.json` for every run. Those are different questions.",
    );
    expect(markdown).not.toContain("| Failed runs |");
    expect(markdown).not.toContain("| Ledger ok |");
    await expect(readFile(result.markdownPath, "utf8")).resolves.toContain(
      "| Outcome failed | 1 |",
    );
    await expect(readFile(result.markdownPath, "utf8")).resolves.toContain(
      "| Code validation-exhausted | 1 |",
    );
  });

  test("keeps failed runs out of existing real-run and coverage aggregates", async () => {
    await writeRun({
      runId: "completed-deep",
      jobType: "equity",
      assetClass: "equity",
      symbol: "AAPL",
      depth: "deep",
    });
    await writeJson(join(dataDir, "failed-deep", RUN_ARTIFACT_FILES.failure), {
      runId: "failed-deep",
      generatedAt: "2026-06-01T01:00:00.000Z",
      jobType: "equity",
      assetClass: "equity",
      symbol: "MSFT",
      depth: "deep",
    });

    const summary = await buildProviderHealthSummary(dataDir, new Date("2026-06-02T12:00:00.000Z"));
    const deepCoverage = summary.validation.requiredCoverage.find(
      (item) => item.key === "deep-equity-ticker",
    );

    expect(summary.runCount).toBe(2);
    expect(summary.subsystemOutcomes.failedRunCount).toBe(1);
    expect(summary.realRunValidation.instrumentRuns).toBe(1);
    expect(summary.realRunValidation.deepInstrumentRuns).toBe(1);
    expect(deepCoverage).toEqual(
      expect.objectContaining({ met: true, runIds: ["completed-deep"] }),
    );
  });

  test("distinguishes absent and schema-invalid outcome ledgers", async () => {
    await writeRun({ runId: "absent", jobType: "equity", assetClass: "equity" });
    await writeRun({ runId: "malformed", jobType: "equity", assetClass: "equity" });
    await writeJson(join(dataDir, "malformed", RUN_ARTIFACT_FILES.outcomes), { outcomes: [] });

    const summary = await buildProviderHealthSummary(dataDir, new Date("2026-06-02T12:00:00.000Z"));

    expect(summary.subsystemOutcomes.ledgerStatus).toEqual({ ok: 0, absent: 1, malformed: 1 });
    expect(
      summary.subsystemOutcomes.ledgerStatus.ok +
        summary.subsystemOutcomes.ledgerStatus.absent +
        summary.subsystemOutcomes.ledgerStatus.malformed,
    ).toBe(summary.runCount);
    expect(summary.subsystemOutcomes.count).toBe(0);
  });

  test("reads deep-equity source gaps from the bundle and ignores legacy sidecars", async () => {
    const runDir = join(dataDir, "deep-bundle");
    const generatedAt = "2026-06-01T00:00:00.000Z";
    const base = deepEquityEvidenceBundle();
    await writeJson(join(runDir, RUN_ARTIFACT_FILES.report), {
      runId: "deep-bundle",
      generatedAt,
      jobType: "equity",
      assetClass: "equity",
      symbol: "AAPL",
      sources: [],
      predictions: [],
      extras: { depth: "deep" },
    });
    await writeJson(
      join(runDir, RUN_ARTIFACT_FILES.evidenceBundle),
      deepEquityEvidenceBundle({
        run: { symbol: "AAPL", analysisAsOf: generatedAt },
        governance: {
          ...base.governance,
          sourceGaps: [
            {
              source: "bundle-provider",
              provider: "bundle",
              cause: "missing-credential",
              message: "missing bundle credential",
            },
          ],
          sourcePlan: { ...base.governance.sourcePlan, generatedAt },
          evidenceLanes: { ...base.governance.evidenceLanes, generatedAt },
          sourceLedger: { ...base.governance.sourceLedger, generatedAt },
        },
        context: {
          historicalContext: { ...base.context.historicalContext, generatedAt },
        },
      }),
    );
    await writeJson(join(runDir, RUN_ARTIFACT_FILES.sourceGaps), [
      { source: "legacy-provider", message: "legacy gap" },
    ]);

    const summary = await buildProviderHealthSummary(dataDir, new Date("2026-06-02T12:00:00.000Z"));

    expect(summary.routes.map((route) => route.route)).toContain("bundle-provider");
    expect(summary.routes.map((route) => route.route)).not.toContain("legacy-provider");
  });

  test("emits degraded unknown coverage for absent and malformed deep-equity bundles", async () => {
    const generatedAt = "2026-06-01T00:00:00.000Z";
    for (const runId of ["bundle-absent", "bundle-malformed"]) {
      await writeJson(join(dataDir, runId, RUN_ARTIFACT_FILES.report), {
        runId,
        generatedAt,
        jobType: "equity",
        assetClass: "equity",
        symbol: "AAPL",
        sources: [],
        predictions: [],
        extras: { depth: "deep" },
      });
    }
    await mkdir(dirname(join(dataDir, "bundle-malformed", RUN_ARTIFACT_FILES.evidenceBundle)), {
      recursive: true,
    });
    await writeFile(
      join(dataDir, "bundle-malformed", RUN_ARTIFACT_FILES.evidenceBundle),
      "{",
      "utf8",
    );

    const summary = await buildProviderHealthSummary(dataDir, new Date("2026-06-02T12:00:00.000Z"));

    expect(summary.routes).toContainEqual(
      expect.objectContaining({
        route: "deep-equity-evidence-bundle",
        provider: "run-artifact",
        total: 2,
        causes: {
          "provider-data-missing": 1,
          "validation-failed": 1,
        },
      }),
    );
    expect(summary.validation.routeClassifications).toContainEqual(
      expect.objectContaining({
        route: "deep-equity-evidence-bundle",
        classification: "blocking",
      }),
    );
  });

  test("preserves validated optional source gap telemetry while parsing", () => {
    const attempts = {
      count: 2,
      elapsedMs: 125,
      failures: [
        { attempt: 1, classification: "timeout", message: "timed out" },
        { attempt: 2, classification: "server-error", message: "HTTP 503" },
      ],
    };
    expect(
      parseSourceGap({
        source: "sec-edgar",
        message: "missing",
        symbol: "AAPL",
        triage: "diagnostic",
        attempts,
      }),
    ).toEqual(expect.objectContaining({ symbol: "AAPL", triage: "diagnostic", attempts }));
    expect(parseSourceGap({ source: "sec-edgar", message: "missing" })).not.toHaveProperty(
      "symbol",
    );
    expect(
      parseSourceGap({
        source: "sec-edgar",
        message: "missing",
        attempts: { ...attempts, count: 0 },
      }),
    ).not.toHaveProperty("attempts");
  });

  test("fails when FRED baseline coverage is missing", async () => {
    await writeBaselineRuns({
      "daily-equity": {
        gaps: [
          {
            source: "fred-macro",
            provider: "fred",
            capability: "market-context",
            cause: "missing-credential",
            message: "missing MARKET_BOT_FRED_API_KEY",
          },
        ],
      },
    });
    await writeCalibration();

    const summary = await buildProviderHealthSummary(dataDir, new Date("2026-06-02T12:00:00.000Z"));

    expect(summary.version).toBe(3);
    expect(summary.validation.status).toBe("fail");
    expect(summary.validation.routeClassifications).toContainEqual(
      expect.objectContaining({
        route: "fred-macro",
        classification: "blocking",
      }),
    );
  });

  test("fails when the Run Artifact Index schema is unsupported", async () => {
    await writeBaselineRuns();
    await writeCalibration();
    const db = new Database(join(tmpDir, "index.sqlite"), { create: true });
    db.exec("PRAGMA user_version = 4");
    db.close();

    const summary = await buildProviderHealthSummary(dataDir, new Date("2026-06-02T12:00:00.000Z"));

    expect(summary.runArtifactIndex).toMatchObject({
      state: "unsupported-schema",
      expectedSchemaVersion: INDEX_SCHEMA_VERSION,
      currentSchemaVersion: 4,
      rebuildCommand: "bun run src/cli.ts index rebuild",
    });
    expect(summary.validation.status).toBe("fail");
    expect(summary.validation.routeClassifications).toContainEqual(
      expect.objectContaining({
        route: "run-artifact-index",
        classification: "blocking",
      }),
    );
  });

  test("passes when the Run Artifact Index is missing", async () => {
    await writeBaselineRuns();
    await writeCalibration();

    const summary = await buildProviderHealthSummary(dataDir, new Date("2026-06-02T12:00:00.000Z"));

    expect(summary.runArtifactIndex.state).toBe("missing");
    expect(summary.validation.status).toBe("pass");
    expect(summary.validation.routeClassifications).not.toContainEqual(
      expect.objectContaining({ route: "run-artifact-index" }),
    );
  });

  test("passes when the Run Artifact Index is disabled", async () => {
    const originalIndexDisable = process.env.MARKET_BOT_INDEX_DISABLE;
    process.env.MARKET_BOT_INDEX_DISABLE = "1";
    try {
      await writeBaselineRuns();
      await writeCalibration();

      const summary = await buildProviderHealthSummary(
        dataDir,
        new Date("2026-06-02T12:00:00.000Z"),
      );

      expect(summary.runArtifactIndex.state).toBe("disabled");
      expect(summary.validation.status).toBe("pass");
      expect(summary.validation.routeClassifications).not.toContainEqual(
        expect.objectContaining({ route: "run-artifact-index" }),
      );
    } finally {
      if (originalIndexDisable === undefined) {
        delete process.env.MARKET_BOT_INDEX_DISABLE;
      } else {
        process.env.MARKET_BOT_INDEX_DISABLE = originalIndexDisable;
      }
    }
  });

  test("warns when baseline is met with only optional provider gaps", async () => {
    await writeBaselineRuns({
      "daily-equity": {
        gaps: [
          {
            source: "marketaux-news",
            provider: "marketaux",
            capability: "news",
            cause: "missing-credential",
            message: "missing MARKET_BOT_MARKETAUX_API_TOKEN",
          },
          {
            source: "finnhub-news",
            provider: "finnhub",
            capability: "news",
            cause: "missing-credential",
            message: "missing MARKET_BOT_FINNHUB_API_KEY",
          },
          {
            source: "massive-supplemental-market",
            provider: "massive",
            capability: "market-data",
            cause: "fetch-failed",
            message: "massive-supplemental-market source request failed with status 403",
          },
        ],
      },
      "deep-equity": {
        gaps: [
          {
            source: "tradier-options",
            provider: "tradier",
            capability: "extended-evidence",
            cause: "missing-credential",
            message: "missing MARKET_BOT_TRADIER_TOKEN",
          },
        ],
      },
      "ticker-crypto": {
        gaps: [
          {
            source: "glassnode-on-chain",
            provider: "glassnode",
            capability: "extended-evidence",
            cause: "missing-credential",
            message: "missing MARKET_BOT_GLASSNODE_API_KEY",
          },
        ],
      },
    });
    await writeCalibration();

    const summary = await buildProviderHealthSummary(dataDir, new Date("2026-06-02T12:00:00.000Z"));

    expect(summary.validation.status).toBe("warn");
    expect(summary.validation.blockingIssueCount).toBe(0);
    expect(summary.validation.warningIssueCount).toBe(5);
    expect(summary.validation.informationalIssueCount).toBe(0);
    expect(summary.validation.routeClassifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          route: "massive-supplemental-market",
          classification: "expected",
        }),
        expect.objectContaining({ route: "tradier-options", classification: "expected" }),
        expect.objectContaining({ route: "glassnode-on-chain", classification: "expected" }),
        expect.objectContaining({ route: "marketaux-news", classification: "expected" }),
        expect.objectContaining({ route: "finnhub-news", classification: "expected" }),
      ]),
    );
  });

  test("passes when only informational route classifications exist", async () => {
    await writeBaselineRuns({
      "daily-equity": {
        gaps: [
          {
            source: "news-seen",
            provider: "news-seen",
            capability: "news",
            cause: "repeat-fallback",
            message: "news repeat fallback kept",
          },
        ],
      },
    });
    await writeCalibration();

    const summary = await buildProviderHealthSummary(dataDir, new Date("2026-06-02T12:00:00.000Z"));

    expect(summary.validation.status).toBe("pass");
    expect(summary.validation.blockingIssueCount).toBe(0);
    expect(summary.validation.warningIssueCount).toBe(0);
    expect(summary.validation.informationalIssueCount).toBe(1);
    expect(summary.validation.routeClassifications).toContainEqual(
      expect.objectContaining({
        route: "news-seen",
        classification: "informational",
      }),
    );
  });

  test("fails when a required validation lane has no usable news", async () => {
    await writeBaselineRuns({
      "daily-equity": {
        sources: [],
        selectedNewsSourceCount: 0,
      },
    });
    await writeCalibration();

    const summary = await buildProviderHealthSummary(dataDir, new Date("2026-06-02T12:00:00.000Z"));

    expect(summary.validation.status).toBe("fail");
    expect(summary.validation.routeClassifications).toContainEqual(
      expect.objectContaining({
        route: "news:market-overview-equity-short",
        classification: "blocking",
      }),
    );
  });

  test("treats international SEC and Tradier unsupported coverage as nonblocking", async () => {
    await writeBaselineRuns({
      "international-equity": {
        gaps: [
          {
            source: "sec-edgar",
            provider: "sec",
            capability: "extended-evidence",
            cause: "unsupported-coverage",
            message: "sec-edgar does not support VOD.L",
          },
          {
            source: "tradier-options",
            provider: "tradier",
            capability: "extended-evidence",
            cause: "unsupported-coverage",
            message: "tradier-options does not support VOD.L",
          },
        ],
      },
    });
    await writeCalibration();

    const summary = await buildProviderHealthSummary(dataDir, new Date("2026-06-02T12:00:00.000Z"));

    expect(summary.validation.status).toBe("warn");
    expect(summary.validation.requiredCoverage).toContainEqual(
      expect.objectContaining({
        key: "international-equity-ticker",
        met: true,
        runIds: ["international-equity"],
      }),
    );
    expect(summary.validation.routeClassifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ route: "sec-edgar", classification: "expected" }),
        expect.objectContaining({ route: "tradier-options", classification: "expected" }),
      ]),
    );
  });

  test("fails when a required run shape is missing", async () => {
    await writeRun({ runId: "daily-equity", jobType: "daily", assetClass: "equity" });
    await writeCalibration();

    const summary = await buildProviderHealthSummary(dataDir, new Date("2026-06-02T12:00:00.000Z"));

    expect(summary.validation.status).toBe("fail");
    expect(summary.validation.requiredCoverage).toContainEqual(
      expect.objectContaining({
        key: "market-overview-crypto-medium",
        met: false,
      }),
    );
    expect(summary.validation.routeClassifications).toContainEqual(
      expect.objectContaining({
        route: "coverage:market-overview-crypto-medium",
        classification: "blocking",
      }),
    );
  });

  test("warns for absent calibration before horizons mature", async () => {
    await writeBaselineRuns({
      "daily-equity": {
        predictions: [{ horizonTradingDays: 5 }],
      },
    });

    const summary = await buildProviderHealthSummary(dataDir, new Date("2026-06-02T12:00:00.000Z"));

    expect(summary.validation.status).toBe("warn");
    expect(summary.validation.blockingIssueCount).toBe(0);
    expect(summary.validation.routeClassifications).toContainEqual(
      expect.objectContaining({
        route: "calibration",
        classification: "expected",
      }),
    );
  });

  test("fails when matured predictions have no scoring pass", async () => {
    await writeBaselineRuns({
      "daily-equity": {
        generatedAt: "2026-05-01T00:00:00.000Z",
        predictions: [{ horizonTradingDays: 5 }],
      },
    });
    await writeCalibration();

    const summary = await buildProviderHealthSummary(dataDir, new Date("2026-06-02T12:00:00.000Z"));

    expect(summary.validation.status).toBe("fail");
    expect(summary.validation.routeClassifications).toContainEqual(
      expect.objectContaining({
        route: "scoring:due",
        classification: "blocking",
      }),
    );
  });

  test("writes json and markdown health views", async () => {
    await writeRun({
      runId: "run-1",
      generatedAt: "2026-06-01T00:00:00.000Z",
      jobType: "daily",
      assetClass: "crypto",
      depth: "brief",
      gaps: [
        {
          source: "unknown-provider",
          provider: "unknown",
          capability: "news",
          cause: "fetch-failed",
          message: "provider returned a | separated message",
        },
      ],
    });

    const result = await writeProviderHealthSummary(dataDir, new Date("2026-06-02T12:00:00.000Z"));

    await expect(readFile(result.jsonPath, "utf8")).resolves.toContain('"version": 3');
    await expect(readFile(result.markdownPath, "utf8")).resolves.toContain("## Validation");
    await expect(readFile(result.markdownPath, "utf8")).resolves.toContain(
      String.raw`provider returned a \| separated message`,
    );
  });
});
