import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  COMPLETENESS_REASON_CODE_LABELS,
  buildRunWorkspaceView,
  completenessReasonCodeLabel,
} from "../app/client/run-workspace-view";
import type { RunDetail } from "../app/types";
import type {
  EquityAnalysisCompleteness,
  EquityAnalysisCompletenessDimension,
  MarketSnapshot,
  ResearchReport,
  VerifiedMarketSnapshot,
} from "../src/domain/types";
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
] as const;

const PROVIDER_DEGRADATION_REASON_CODES: ReadonlySet<string> = new Set([
  "expectations-provider-credential-missing",
  "expectations-provider-entitlement-blocked",
  "ownership-provider-credential-missing",
  "ownership-provider-entitlement-blocked",
]);

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

function goldenRunDetail(golden: GoldenReport): RunDetail {
  const { report, normalized } = golden;
  const marketSnapshots = artifact<readonly MarketSnapshot[]>(normalized["market-snapshots.json"]);
  const verifiedMarketSnapshot = artifact<VerifiedMarketSnapshot>(
    normalized["verified-market-snapshot.json"],
  );
  const financialLenses = artifact<FinancialLensArtifact>(normalized["financial-lenses.json"]);
  const fundamentalHistory = artifact<FundamentalHistoryArtifact>(
    normalized["fundamental-history.json"],
  );
  const valuationComps = artifact<ValuationCompsArtifact>(normalized["valuation-comps.json"]);
  const valuationWorkbench = artifact<ValuationWorkbenchArtifact>(
    normalized["valuation-workbench.json"],
  );
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
    ...(peerImpliedRange === undefined
      ? {}
      : { peerImpliedRange: peerImpliedRange as PeerImpliedRange }),
    ...(valuationWorkbench === undefined ? {} : { valuationWorkbench }),
  };
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

describe("provider dimension contracts", () => {
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
      const snapshot = buildRunWorkspaceView(goldenRunDetail(golden)).equitySnapshot;
      const knownSourceIds = new Set(golden.report.sources.map((source) => source.id));
      expect(snapshot, `${golden.fixture}: snapshot missing`).toBeDefined();
      expect(snapshot?.sectionOrder).toEqual([
        "pricePerformance",
        "analysisCompleteness",
        "peerReferenceRange",
        "keyDatedMetrics",
        "miniCharts",
        "financialLensDrivers",
      ]);

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

  test("keeps completeness and coverage states descriptive in snapshots", async () => {
    const goldens = await loadGoldenReports();
    const financialCoreStates = new Set<string>();
    const coverageStates = new Set<string>();
    const dimensionStates = new Set<string>();

    for (const golden of goldens) {
      const completeness = buildRunWorkspaceView(goldenRunDetail(golden)).equitySnapshot
        ?.analysisCompleteness;
      if (completeness?.financialCoreStatus !== undefined) {
        financialCoreStates.add(completeness.financialCoreStatus);
      }
      if (completeness?.coverageLevel !== undefined) {
        coverageStates.add(completeness.coverageLevel);
      }
      for (const dimension of completeness?.dimensions ?? []) {
        dimensionStates.add(dimension.status);
        expect(dimension.label.trim()).not.toBe("");
        expect(dimension.reasons.every((reason) => reason.trim() !== "")).toBeTrue();
      }
    }

    expect(
      [...financialCoreStates].every((state) => ["blocked", "partial", "complete"].includes(state)),
    ).toBeTrue();
    expect(
      [...coverageStates].every((state) =>
        ["limited", "substantial", "comprehensive"].includes(state),
      ),
    ).toBeTrue();
    expect(
      [...dimensionStates].every((state) =>
        ["blocked", "partial", "complete", "not-applicable"].includes(state),
      ),
    ).toBeTrue();
  });

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
          expect(dimension.status, `${fixture}: ${reasonCode} must remain partial`).toBe("partial");
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

      const workspace = buildRunWorkspaceView(detail);
      const loaded = await loadRunArtifact(runDir);

      expect(workspace.equityCompleteness).toBeUndefined();
      expect(workspace.equitySnapshot).toBeDefined();
      expect(workspace.equitySnapshot?.pricePerformance.state).toBe("unavailable");
      expect(workspace.equitySnapshot?.analysisCompleteness.state).toBe("unavailable");
      expect(workspace.equitySnapshot?.miniCharts.charts).toHaveLength(4);
      expect(snapshotCitationIds(workspace.equitySnapshot)).toEqual([]);
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
