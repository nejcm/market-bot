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
  ResearchReport,
} from "../src/domain/types";
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
}

interface GoldenReport {
  readonly fixture: string;
  readonly report: ResearchReport & {
    readonly equityAnalysisCompleteness: EquityAnalysisCompleteness;
  };
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
      };
    }),
  );
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
