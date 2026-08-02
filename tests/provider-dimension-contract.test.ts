import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  COMPLETENESS_REASON_CODE_LABELS,
  completenessReasonCodeLabel,
  equitySnapshotView,
} from "../app/client/run-workspace-view";
import type { RunDetail } from "../app/types";
import type { DeepEquityEvidenceBundleV1 } from "../src/deep-equity/types";
import type {
  EquityAnalysisCompleteness,
  EquityAnalysisCompletenessDimension,
  MarketSnapshot,
  ResearchReport,
  VerifiedMarketSnapshot,
} from "../src/domain/types";
import { validateResearchReport } from "../src/report/schema";
import type { FinancialLensArtifact } from "../src/sources/extended-evidence/financial-lens";
import type { FundamentalHistoryArtifact } from "../src/sources/extended-evidence/fundamental-history";
import type {
  PeerImpliedRange,
  ValuationCompsArtifact,
} from "../src/sources/extended-evidence/valuation-comps";
import type { ValuationWorkbenchArtifact } from "../src/sources/extended-evidence/valuation-workbench-contract";
import { violatesResearchOnly } from "../src/domain/research-language";
import { loadRunArtifact } from "../src/run-artifacts";

const REPLAY_FIXTURES = [
  "equity-aapl-brief",
  "equity-aapl-deep",
  "equity-analysis-comprehensive",
  "equity-analysis-estimated-suppressed",
  "equity-fpi-ifrs-semiannual",
  "equity-fpi-quarterly",
  "equity-nbis-deep",
  "equity-web-fallback-deep",
] as const;

const PROVIDER_DEGRADATION_REASON_CODES: ReadonlySet<string> = new Set([
  "expectations-provider-credential-missing",
  "expectations-provider-entitlement-blocked",
  "ownership-provider-credential-missing",
  "ownership-provider-entitlement-blocked",
]);
const COMPLETENESS_DIMENSION_DISPLAY_LABELS = [
  "Primary financials",
  "Valuation",
  "Expectations",
  "Capital & ownership",
  "Operating KPIs",
] as const;

interface GoldenOutput {
  readonly report: ResearchReport;
  readonly normalized: Readonly<Record<string, unknown>>;
}

interface GoldenReport {
  readonly fixture: string;
  readonly report: ResearchReport & {
    readonly equityAnalysisCompleteness: EquityAnalysisCompleteness;
  };
  readonly normalized: Readonly<Record<string, unknown>>;
}

interface GoldenRunDetail extends RunDetail {
  readonly valuationComps?: ValuationCompsArtifact;
}

function artifact<T>(value: unknown): T | undefined {
  return value !== null && typeof value === "object" ? (value as T) : undefined;
}

async function loadGoldenReports(): Promise<readonly GoldenReport[]> {
  return Promise.all(
    REPLAY_FIXTURES.map(async (fixture) => {
      const path = join(import.meta.dir, "fixtures", "runs", fixture, "golden-output.json");
      const output = JSON.parse(await readFile(path, "utf8")) as GoldenOutput;
      const completeness = output.report.equityAnalysisCompleteness;
      if (completeness === undefined) {
        throw new Error(`${fixture} has no equity analysis completeness contract`);
      }
      return {
        fixture,
        report: {
          ...output.report,
          equityAnalysisCompleteness: completeness,
        },
        normalized: output.normalized,
      };
    }),
  );
}

function goldenRunDetail(golden: GoldenReport): GoldenRunDetail {
  const { report, normalized } = golden;
  const evidenceBundle = artifact<DeepEquityEvidenceBundleV1>(normalized["evidence-bundle.json"]);
  const marketSnapshots =
    artifact<readonly MarketSnapshot[]>(normalized["market-snapshots.json"]) ??
    evidenceBundle?.evidence.marketSnapshots;
  const verifiedMarketSnapshot =
    artifact<VerifiedMarketSnapshot>(normalized["verified-market-snapshot.json"]) ??
    evidenceBundle?.evidence.verifiedMarketSnapshot;
  const financialLenses =
    artifact<FinancialLensArtifact>(normalized["financial-lenses.json"]) ??
    evidenceBundle?.derived.financialLenses;
  const fundamentalHistory =
    artifact<FundamentalHistoryArtifact>(normalized["fundamental-history.json"]) ??
    evidenceBundle?.derived.fundamentalHistory;
  const valuationComps =
    artifact<ValuationCompsArtifact>(normalized["valuation-comps.json"]) ??
    evidenceBundle?.derived.valuationComps;
  const valuationWorkbench =
    artifact<ValuationWorkbenchArtifact>(normalized["valuation-workbench.json"]) ??
    evidenceBundle?.derived.valuationWorkbench;
  const peerImpliedRange = valuationComps?.impliedPriceRange;
  return {
    summary: {
      runId: report.runId,
      generatedAt: report.generatedAt,
      jobType: "equity",
      assetClass: "equity",
      ...(report.symbol === undefined ? {} : { symbol: report.symbol }),
      ...(report.evidenceQuality === undefined ? {} : { confidence: report.evidenceQuality }),
      findingCount: report.keyFindings.length,
      predictionCount: report.predictions.length,
      sourceCount: report.sources.length,
      dataGapCount: report.dataGaps.length,
      hasScore: false,
      availableFiles: Object.keys(normalized).map((path) => `normalized/${path}`),
    },
    report: report as unknown as Record<string, unknown>,
    ...(marketSnapshots === undefined ? {} : { marketSnapshots }),
    ...(verifiedMarketSnapshot === undefined ? {} : { verifiedMarketSnapshot }),
    ...(financialLenses === undefined ? {} : { financialLenses }),
    ...(fundamentalHistory === undefined ? {} : { fundamentalHistory }),
    ...(valuationComps === undefined ? {} : { valuationComps }),
    ...(peerImpliedRange === undefined
      ? {}
      : { peerImpliedRange: peerImpliedRange as PeerImpliedRange }),
    ...(valuationWorkbench === undefined ? {} : { valuationWorkbench }),
  };
}

async function renderRunWorkspaceComponent(detail: RunDetail): Promise<string> {
  const subprocess = Bun.spawn(
    [process.execPath, "run", resolve(import.meta.dir, "support/render-run-workspace.ts")],
    {
      stdin: new Blob([JSON.stringify(detail)]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [body, error, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(error);
  }
  return body;
}

function renderedText(html: string): string {
  return html
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll("&amp;", "&")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function snapshotCitationIds(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => snapshotCitationIds(entry));
  }
  if (value === null || typeof value !== "object") {
    return [];
  }
  return Object.entries(value).flatMap(([key, entry]) =>
    key === "sourceIds" && Array.isArray(entry)
      ? entry.filter((sourceId): sourceId is string => typeof sourceId === "string")
      : snapshotCitationIds(entry),
  );
}

function snapshotCards(value: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => snapshotCards(entry));
  }
  if (value === null || typeof value !== "object") {
    return [];
  }
  const record = value as Record<string, unknown>;
  const nested = Object.values(record).flatMap((entry) => snapshotCards(entry));
  return typeof record.key === "string" &&
    typeof record.label === "string" &&
    typeof record.state === "string"
    ? [record, ...nested]
    : nested;
}

function snapshotScalars(value: unknown): readonly (string | number)[] {
  if (typeof value === "string" || typeof value === "number") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => snapshotScalars(entry));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap((entry) => snapshotScalars(entry));
  }
  return [];
}

function completenessDimensions(
  completeness: EquityAnalysisCompleteness,
): readonly EquityAnalysisCompletenessDimension[] {
  return Object.values(completeness.dimensions);
}

function hasConfiguredReasonLabel(reasonCode: string): boolean {
  if (COMPLETENESS_REASON_CODE_LABELS[reasonCode] !== undefined) {
    return true;
  }
  const separatorIndex = reasonCode.indexOf(":");
  return (
    separatorIndex > 0 &&
    COMPLETENESS_REASON_CODE_LABELS[reasonCode.slice(0, separatorIndex)] !== undefined
  );
}

function completenessContract(): EquityAnalysisCompleteness {
  const dimension = {
    status: "complete" as const,
    reasonCodes: [] as string[],
    asOf: "2026-07-04T00:00:00.000Z",
    sourceIds: [] as string[],
  };
  return {
    version: 1,
    financialCoreStatus: "complete",
    coverageLevel: "comprehensive",
    asOf: "2026-07-04T00:00:00.000Z",
    dimensions: {
      primaryFinancials: { ...dimension },
      valuation: { ...dimension },
      expectations: { ...dimension },
      capitalOwnership: { ...dimension },
      operatingKpis: { ...dimension },
    },
  };
}

function historicalReport(completeness?: unknown): Record<string, unknown> {
  return {
    runId: "historical-run",
    jobType: "equity",
    assetClass: "equity",
    symbol: "TEST",
    generatedAt: "2026-07-04T00:00:00.000Z",
    summary: "Historical equity research artifact.",
    keyFindings: [],
    bullCase: [],
    bearCase: [],
    risks: [],
    catalysts: [],
    scenarios: [],
    confidence: "medium",
    dataGaps: [],
    predictions: [],
    sources: [],
    notFinancialAdvice: true,
    ...(completeness === undefined ? {} : { equityAnalysisCompleteness: completeness }),
  };
}

async function loadHistoricalCompleteness(completeness?: unknown): Promise<{
  readonly reportStatus: string;
  readonly completeness: EquityAnalysisCompleteness | undefined;
}> {
  const root = await mkdtemp(join(tmpdir(), "market-bot-completeness-reader-"));
  const runDir = join(root, "historical-run");
  try {
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "report.json"),
      `${JSON.stringify(historicalReport(completeness), null, 2)}\n`,
      "utf8",
    );
    const loaded = await loadRunArtifact(runDir);
    return {
      reportStatus: loaded.status.report,
      completeness: loaded.artifact?.report.equityAnalysisCompleteness,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function strictReport(completeness: unknown): ResearchReport {
  return {
    runId: "strict-run",
    jobType: "equity",
    assetClass: "equity",
    symbol: "TEST",
    generatedAt: "2026-07-04T00:00:00.000Z",
    summary: "Equity research artifact.",
    keyFindings: [],
    bullCase: [],
    bearCase: [],
    risks: [],
    catalysts: [],
    scenarios: [],
    evidenceQuality: "medium",
    dataGaps: [],
    predictions: [],
    sources: [
      {
        id: "source-1",
        title: "Public filing",
        fetchedAt: "2026-07-04T00:00:00.000Z",
        kind: "extended-evidence",
        assetClass: "equity",
        symbol: "TEST",
      },
    ],
    equityAnalysisCompleteness: completeness as EquityAnalysisCompleteness,
    notFinancialAdvice: true,
  };
}

function validationError(completeness: unknown): string {
  try {
    validateResearchReport(strictReport(completeness));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected completeness validation to fail");
}

describe("provider dimension contracts", () => {
  test("omits absent or malformed optional completeness without failing the historical report", async () => {
    const valid = completenessContract();
    const malformed = [
      { name: "wrong version", value: { ...valid, version: 2 } },
      {
        name: "missing dimension",
        value: {
          ...valid,
          dimensions: {
            primaryFinancials: valid.dimensions.primaryFinancials,
            valuation: valid.dimensions.valuation,
            expectations: valid.dimensions.expectations,
            capitalOwnership: valid.dimensions.capitalOwnership,
          },
        },
      },
      {
        name: "invalid status",
        value: {
          ...valid,
          dimensions: {
            ...valid.dimensions,
            valuation: { ...valid.dimensions.valuation, status: "future-status" },
          },
        },
      },
      {
        name: "invalid reason-code array",
        value: {
          ...valid,
          dimensions: {
            ...valid.dimensions,
            valuation: { ...valid.dimensions.valuation, reasonCodes: [42] },
          },
        },
      },
      {
        name: "invalid source-id array",
        value: {
          ...valid,
          dimensions: {
            ...valid.dimensions,
            valuation: { ...valid.dimensions.valuation, sourceIds: "source-1" },
          },
        },
      },
      { name: "primary/core mismatch", value: { ...valid, financialCoreStatus: "partial" } },
    ];

    const absent = await loadHistoricalCompleteness();
    const readable = await loadHistoricalCompleteness(valid);
    expect(absent).toEqual({ reportStatus: "ok", completeness: undefined });
    expect(readable).toEqual({ reportStatus: "ok", completeness: valid });
    for (const { name, value } of malformed) {
      const loaded = await loadHistoricalCompleteness(value);
      expect(loaded.reportStatus, name).toBe("ok");
      expect(loaded.completeness, name).toBeUndefined();
    }
  });

  test("keeps structurally valid historical completeness readable without newer strict invariants", async () => {
    const valid = completenessContract();
    const historical: EquityAnalysisCompleteness = {
      ...valid,
      coverageLevel: "comprehensive",
      asOf: "not-an-ISO-timestamp",
      dimensions: {
        ...valid.dimensions,
        operatingKpis: {
          status: "not-assessed",
          reasonCodes: [],
          asOf: "historical-date",
          sourceIds: [],
        },
      },
    };

    const loaded = await loadHistoricalCompleteness(historical);

    expect(loaded.reportStatus).toBe("ok");
    expect(loaded.completeness).toEqual(historical);
  });

  test("preserves exact strict completeness validation errors", () => {
    const cases: readonly {
      readonly name: string;
      readonly value: unknown;
      readonly error: string;
    }[] = [
      {
        name: "contract timestamp",
        value: { ...completenessContract(), asOf: "2026-07-04" },
        error: "Equity analysis completeness requires version 1 and an ISO asOf timestamp",
      },
      {
        name: "dimension timestamp",
        value: {
          ...completenessContract(),
          dimensions: {
            ...completenessContract().dimensions,
            valuation: { ...completenessContract().dimensions.valuation, asOf: "2026-07-04" },
          },
        },
        error: "Equity analysis completeness valuation asOf must be an ISO timestamp",
      },
      {
        name: "primary status",
        value: {
          ...completenessContract(),
          dimensions: {
            ...completenessContract().dimensions,
            primaryFinancials: {
              ...completenessContract().dimensions.primaryFinancials,
              status: "not-assessed",
            },
          },
        },
        error: "Primary financial completeness status is invalid",
      },
      {
        name: "primary/core mismatch",
        value: { ...completenessContract(), financialCoreStatus: "partial" },
        error: "Financial core status must equal the primaryFinancials status",
      },
      {
        name: "blank reason code",
        value: {
          ...completenessContract(),
          dimensions: {
            ...completenessContract().dimensions,
            valuation: { ...completenessContract().dimensions.valuation, reasonCodes: ["  "] },
          },
        },
        error: "Equity analysis completeness valuation reason codes must be non-empty",
      },
      {
        name: "not applicable without cited evidence",
        value: {
          ...completenessContract(),
          dimensions: {
            ...completenessContract().dimensions,
            operatingKpis: {
              ...completenessContract().dimensions.operatingKpis,
              status: "not-applicable",
              reasonCodes: ["issuer-has-no-material-operating-kpis"],
            },
          },
        },
        error:
          "Equity analysis completeness operatingKpis not-applicable status requires affirmative evidence",
      },
      {
        name: "not applicable with credential reason",
        value: {
          ...completenessContract(),
          dimensions: {
            ...completenessContract().dimensions,
            operatingKpis: {
              ...completenessContract().dimensions.operatingKpis,
              status: "not-applicable",
              reasonCodes: ["provider-entitlement-blocked"],
              sourceIds: ["source-1"],
            },
          },
        },
        error:
          "Equity analysis completeness operatingKpis not-applicable status requires affirmative evidence",
      },
      {
        name: "not assessed without reason",
        value: {
          ...completenessContract(),
          dimensions: {
            ...completenessContract().dimensions,
            expectations: {
              ...completenessContract().dimensions.expectations,
              status: "not-assessed",
            },
          },
        },
        error:
          "Equity analysis completeness expectations not-assessed status requires a reason code",
      },
      {
        name: "coverage mismatch",
        value: { ...completenessContract(), coverageLevel: "limited" },
        error: "Equity analysis completeness coverageLevel conflicts with dimension statuses",
      },
    ];

    for (const item of cases) {
      expect(validationError(item.value), item.name).toBe(item.error);
    }
  });

  test("resolves every completeness dimension citation in all replay goldens", async () => {
    const goldens = await loadGoldenReports();

    for (const { fixture, report } of goldens) {
      const knownSourceIds = new Set(report.sources.map((source) => source.id));
      for (const dimension of completenessDimensions(report.equityAnalysisCompleteness)) {
        for (const sourceId of dimension.sourceIds) {
          expect(knownSourceIds.has(sourceId), `${fixture}: unresolved ${sourceId}`).toBeTrue();
        }
      }
    }
  });

  test("projects all replay goldens into citation-safe explicit equity snapshots", async () => {
    const goldens = await loadGoldenReports();

    for (const golden of goldens) {
      const detail = goldenRunDetail(golden);
      const evidenceBundle = artifact<DeepEquityEvidenceBundleV1>(
        golden.normalized["evidence-bundle.json"],
      );
      const sidecarValuationComps = artifact<ValuationCompsArtifact>(
        golden.normalized["valuation-comps.json"],
      );
      const bundleBacked = golden.normalized["evidence-bundle.json"] !== undefined;
      const hasValuationComps =
        sidecarValuationComps !== undefined || evidenceBundle?.derived.valuationComps !== undefined;
      expect(detail.marketSnapshots, `${golden.fixture}: market snapshots missing`).toBeDefined();
      // This guards the detail input only; availableFiles still gates off the rendered Console surface.
      expect(
        detail.verifiedMarketSnapshot,
        `${golden.fixture}: verified market snapshot missing`,
      ).toBeDefined();
      expect(detail.financialLenses, `${golden.fixture}: financial lenses missing`).toBeDefined();
      expect(
        detail.fundamentalHistory,
        `${golden.fixture}: fundamental history missing`,
      ).toBeDefined();
      expect(
        detail.valuationWorkbench,
        `${golden.fixture}: valuation workbench missing`,
      ).toBeDefined();
      // The equity-aapl-brief fixture ships no comps artifact in any form.
      expect(
        bundleBacked,
        `${golden.fixture}: bundle-backed and genuinely-present comps sets differ`,
      ).toBe(hasValuationComps);
      if (bundleBacked) {
        expect(detail.valuationComps, `${golden.fixture}: valuation comps missing`).toBeDefined();
        expect(
          detail.peerImpliedRange,
          `${golden.fixture}: peer implied range missing`,
        ).toBeDefined();
      }
      const snapshot = equitySnapshotView(detail);
      const knownSourceIds = new Set(golden.report.sources.map((source) => source.id));
      expect(snapshot, `${golden.fixture}: snapshot missing`).toBeDefined();

      for (const sourceId of snapshotCitationIds(snapshot)) {
        expect(
          knownSourceIds.has(sourceId),
          `${golden.fixture}: unresolved ${sourceId}`,
        ).toBeTrue();
      }
      for (const card of snapshotCards(snapshot)) {
        expect((card.label as string).trim(), `${golden.fixture}: blank card label`).not.toBe("");
        expect(["available", "partial", "unavailable"]).toContain(card.state as string);
        if (card.state === "unavailable" && "value" in card) {
          expect(card.value, `${golden.fixture}: unavailable card used a value`).toBeUndefined();
        }
      }
      for (const scalar of snapshotScalars(snapshot)) {
        if (typeof scalar === "number") {
          expect(
            Number.isFinite(scalar),
            `${golden.fixture}: non-finite snapshot number`,
          ).toBeTrue();
        } else {
          expect(scalar.trim(), `${golden.fixture}: blank snapshot string`).not.toBe("");
          expect(scalar, `${golden.fixture}: leaked undefined`).not.toContain("undefined");
          expect(scalar, `${golden.fixture}: leaked NaN`).not.toContain("NaN");
          expect(violatesResearchOnly(scalar), `${golden.fixture}: ${scalar}`).toBeNull();
        }
      }

      for (const metric of snapshot?.keyDatedMetrics.metrics ?? []) {
        if (metric.state === "unavailable") {
          expect(
            metric.value,
            `${golden.fixture}: missing metric rendered as zero`,
          ).toBeUndefined();
          expect(metric.dateBasis).toBeUndefined();
        }
      }
      for (const chart of snapshot?.miniCharts.charts ?? []) {
        if (chart.state === "unavailable") {
          expect(chart.value, `${golden.fixture}: missing chart rendered as zero`).toBeUndefined();
          expect(chart.geometry).toBeUndefined();
        }
      }
    }
  });

  test("renders completeness and coverage states for every replay golden", async () => {
    const goldens = await loadGoldenReports();

    for (const golden of goldens) {
      const completeness = golden.report.equityAnalysisCompleteness;
      const text = renderedText(await renderRunWorkspaceComponent(goldenRunDetail(golden)));

      expect(text, `${golden.fixture}: financial core`).toContain(
        `financial core · ${completeness.financialCoreStatus}`,
      );
      expect(text, `${golden.fixture}: coverage`).toContain(
        `coverage · ${completeness.coverageLevel}`,
      );
      expect(text, `${golden.fixture}: as-of`).toContain(`as of ${completeness.asOf}`);
      for (const [index, dimension] of completenessDimensions(completeness).entries()) {
        const label = COMPLETENESS_DIMENSION_DISPLAY_LABELS[index] ?? "missing dimension label";
        expect(text, `${golden.fixture}: dimension status`).toContain(
          `${label} ${dimension.status.replaceAll("-", " ")}`,
        );
        for (const reasonCode of dimension.reasonCodes) {
          expect(text, `${golden.fixture}: ${reasonCode}`).toContain(
            completenessReasonCodeLabel(reasonCode),
          );
        }
      }
    }
  }, 30_000);

  test("normalizes provider access degradation without changing the financial core", async () => {
    const goldens = await loadGoldenReports();
    const observedProviderReasons = new Set<string>();

    for (const { fixture, report } of goldens) {
      const completeness = report.equityAnalysisCompleteness;
      expect(
        completeness.dimensions.primaryFinancials.status,
        `${fixture}: financial core must follow primary financials`,
      ).toBe(completeness.financialCoreStatus);
      for (const dimension of completenessDimensions(completeness)) {
        for (const reasonCode of dimension.reasonCodes) {
          if (!/provider-(?:credential-missing|entitlement-blocked)$/u.test(reasonCode)) {
            continue;
          }
          observedProviderReasons.add(reasonCode);
          expect(
            PROVIDER_DEGRADATION_REASON_CODES.has(reasonCode),
            `${fixture}: undocumented provider degradation ${reasonCode}`,
          ).toBeTrue();
          const providerOnly = dimension.reasonCodes.every((code) =>
            PROVIDER_DEGRADATION_REASON_CODES.has(code),
          );
          const expectedStatus =
            reasonCode.startsWith("expectations-") && providerOnly ? "not-assessed" : "partial";
          expect(dimension.status, `${fixture}: ${reasonCode} status`).toBe(expectedStatus);
          expect(dimension.status, `${fixture}: ${reasonCode} cannot be not-applicable`).not.toBe(
            "not-applicable",
          );
        }
      }
    }

    expect([...observedProviderReasons].toSorted()).toEqual(
      [...PROVIDER_DEGRADATION_REASON_CODES].toSorted(),
    );
  });

  test("keeps legacy report artifacts readable without provider-dimension fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "market-bot-provider-contract-"));
    const runDir = join(root, "legacy-run");
    const legacyReport = {
      runId: "legacy-run",
      jobType: "equity",
      assetClass: "equity",
      symbol: "AAPL",
      generatedAt: "2025-01-02T00:00:00.000Z",
      summary: "Historical equity research artifact.",
      keyFindings: [],
      bullCase: [],
      bearCase: [],
      risks: [],
      catalysts: [],
      scenarios: [],
      confidence: "medium",
      dataGaps: [],
      predictions: [],
      sources: [],
      notFinancialAdvice: true,
    };
    const detail: RunDetail = {
      summary: {
        runId: "legacy-run",
        generatedAt: legacyReport.generatedAt,
        jobType: legacyReport.jobType,
        assetClass: legacyReport.assetClass,
        symbol: legacyReport.symbol,
        confidence: legacyReport.confidence,
        findingCount: 0,
        predictionCount: 0,
        sourceCount: 0,
        dataGapCount: 0,
        hasScore: false,
        availableFiles: [],
      },
      report: legacyReport,
    };

    try {
      await mkdir(runDir, { recursive: true });
      await writeFile(
        join(runDir, "report.json"),
        `${JSON.stringify(legacyReport, null, 2)}\n`,
        "utf8",
      );

      const snapshot = equitySnapshotView(detail);
      const loaded = await loadRunArtifact(runDir);

      expect(snapshot).toBeDefined();
      expect(snapshot?.pricePerformance.state).toBe("unavailable");
      expect(snapshot?.miniCharts.charts).toHaveLength(4);
      expect(snapshotCitationIds(snapshot)).toEqual([]);
      expect(loaded.status.report).toBe("ok");
      expect(loaded.artifact?.report.equityAnalysisCompleteness).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("labels every golden reason code and retains deterministic fallbacks", async () => {
    const goldens = await loadGoldenReports();
    const reasonCodes = new Set(
      goldens.flatMap(({ report }) =>
        completenessDimensions(report.equityAnalysisCompleteness).flatMap(
          (dimension) => dimension.reasonCodes,
        ),
      ),
    );

    expect([...reasonCodes].filter((reasonCode) => !hasConfiguredReasonLabel(reasonCode))).toEqual(
      [],
    );
    expect(completenessReasonCodeLabel("operating-kpi-unverified:nbis-gpu-capacity")).toBe(
      "Operating KPI is unverified: nbis gpu capacity",
    );
    expect(completenessReasonCodeLabel("future-evidence-gap")).toBe("future evidence gap");
    expect(completenessReasonCodeLabel("future-provider-state:detail-key")).toBe(
      "future provider state: detail key",
    );
    expect(
      Object.values(COMPLETENESS_REASON_CODE_LABELS).filter((label) => violatesResearchOnly(label)),
    ).toEqual([]);
  });
});
