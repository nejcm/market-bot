import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readEarningsForecastTelemetry } from "../../../src/forecast/earnings-eligibility";
import { parseObservableExpression } from "../../../src/forecast/observable";
import { isRecord } from "../../../src/guards";
import type { ResearchReport } from "../../../src/domain/report";
import type { ModelRequest } from "../../../src/model/types";
import { assertSafeReportLanguage, validateResearchReport } from "../../../src/report/schema";
import { RUN_ARTIFACT_FILES } from "../../../src/run-artifact-layout";
import { loadRunArtifact } from "../../../src/run-artifacts";
import { depositoryIssuerSic } from "../../../src/sources/extended-evidence/industry-classification";
import type { FixtureMeta, RunFixtureResult } from ".";
import { assertFinancialRunInvariants } from "./financial-invariants";

function asWritten(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

export async function assertInvariants(result: RunFixtureResult, meta: FixtureMeta): Promise<void> {
  const { runDir } = result.artifacts;
  expect(await Bun.file(join(runDir, RUN_ARTIFACT_FILES.failure)).exists()).toBe(false);
  const loaded = await loadRunArtifact(runDir);
  expect(loaded.status.report).toBe("ok");
  // The reader rejects a bundle whose source ids do not resolve against the report.
  expect(loaded.status.evidenceBundle).toBe(meta.argv.includes("--deep") ? "ok" : undefined);
  const persisted = async (file: string): Promise<unknown> =>
    JSON.parse(await readFile(join(runDir, file), "utf8")) as unknown;
  const persistedReport = await persisted(RUN_ARTIFACT_FILES.report);
  expect(persistedReport).toEqual(asWritten(result.report));
  expect(await readFile(join(runDir, RUN_ARTIFACT_FILES.reportMarkdown), "utf8")).toBe(
    result.markdown,
  );
  expect(await persisted(RUN_ARTIFACT_FILES.analytics)).toEqual(asWritten(result.analytics));
  expect(await persisted(RUN_ARTIFACT_FILES.outcomes)).toEqual(asWritten(result.outcomes));
  if (result.deepEquityEvidenceBundle !== undefined) {
    expect(await persisted(RUN_ARTIFACT_FILES.evidenceBundle)).toEqual(
      asWritten(result.deepEquityEvidenceBundle),
    );
  }
  const report = validateResearchReport(persistedReport as ResearchReport);
  assertSafeReportLanguage(report);
  expect(report.reportIntegrity, "integrity audit pruned report content").toBe("high");
  for (const prediction of report.predictions) {
    expect(() => parseObservableExpression(prediction.measurableAs)).not.toThrow();
  }
  const { targetCount } = result.analytics.predictions;
  expect(report.predictionShortfall).toEqual(
    report.predictions.length < targetCount
      ? {
          emittedCount: report.predictions.length,
          targetCount,
          missingCount: targetCount - report.predictions.length,
        }
      : undefined,
  );
  expect(result.markdown.match(/Research-only note/gu)?.length).toBe(1);
  // Two cassettes still return model spotlights; only market-update runs carry them (ADR 0003).
  expect(report.extras?.spotlights).toBeUndefined();
  expect(result.markdown).not.toContain("## Market Spotlights");
  expect(result.sourcePlan).toBeDefined();
  expect(result.evidenceLanes.summary.plannedLaneCount).toBeGreaterThan(0);
  expect(result.analytics.sourcePlan?.plannedLaneCount).toBeGreaterThan(0);
  expect(result.stageOutputs.every((output) => (output.durationMs ?? 0) > 0)).toBe(true);
  expect(result.trace.stageRecords?.every((record) => (record.durationMs ?? 0) > 0)).toBe(true);
  expect(result.analytics.runShape.stages.every((stage) => (stage.durationMs ?? 0) > 0)).toBe(true);
  if (meta.argv.includes("--deep")) {
    expect(result.stageOutputs.map((output) => output.stage)).toEqual(
      expect.arrayContaining(["instrument-evidence-analysis", "market-behavior-analysis"]),
    );
    if ((meta.challengerModels ?? []).length > 0) {
      expect(result.trace.forecastDisagreement?.challengerModelCount).toBe(
        meta.challengerModels?.length,
      );
    }
  }
  await assertFinancialRunInvariants(result, meta);
}

export function factTaxonomies(result: RunFixtureResult): readonly string[] {
  const snapshot = result.collectedSources.rawSnapshots.find(
    (candidate) => candidate.adapter === "sec-companyfacts",
  );
  if (!isRecord(snapshot?.payload) || !isRecord(snapshot.payload.facts)) {
    return [];
  }
  return Object.keys(snapshot.payload.facts);
}

export function factForms(result: RunFixtureResult): ReadonlySet<string> {
  const snapshot = result.collectedSources.rawSnapshots.find(
    (candidate) => candidate.adapter === "sec-companyfacts",
  );
  const forms = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item));
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    if (typeof value.form === "string") {
      forms.add(value.form);
    }
    Object.values(value).forEach((item) => visit(item));
  };
  visit(snapshot?.payload);
  return forms;
}

interface UnsupportedInputManifest {
  readonly inputs: readonly {
    readonly file: string;
    readonly form: string;
    readonly role: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly structuredSupport: string;
  }[];
}

export async function assertNbisUnsupportedInputs(): Promise<void> {
  const root = join(import.meta.dir, "../../fixtures/runs/equity-nbis-deep");
  const manifest = JSON.parse(
    await readFile(join(root, "unsupported-inputs.json"), "utf8"),
  ) as UnsupportedInputManifest;
  expect(manifest.inputs.map((input) => [input.form, input.role])).toEqual([
    ["20-F", "annual-filing"],
    ["6-K", "filing-index"],
    ["6-K", "interim-filing"],
    ["6-K", "interim-exhibit"],
    ["6-K", "interim-exhibit"],
    ["6-K", "current-report"],
    ["6-K", "current-report"],
  ]);
  for (const input of manifest.inputs) {
    const body = await readFile(join(root, "unsupported-inputs", input.file));
    expect(body.byteLength).toBe(input.bytes);
    expect(createHash("sha256").update(body).digest("hex")).toBe(input.sha256);
    expect(["unsupported", "discovery", "phase-3-candidate"]).toContain(input.structuredSupport);
  }
}

// A depository issuer must not produce a numeric enterprise value anywhere in the run. Check every
// Producer separately because valuation evidence, lenses, the framework, workbench, reverse DCF,
// Peer comparison, and rendering can regress independently.
const EV_REVENUE_COLUMN = 6;
const NUMERIC_CELL = /\d/u;

export function assertDepositoryEnterpriseValueAbsent(result: RunFixtureResult): void {
  const sic = depositoryIssuerSic(result.report.extendedEvidence);
  expect(sic, "fixture issuer must classify as a depository institution").toMatch(/^60\d{2}$/u);

  const bundle = result.deepEquityEvidenceBundle;
  const evidenceItems = bundle?.evidence.extendedEvidence?.items ?? [];
  const evidenceGaps = bundle?.evidence.extendedEvidence?.gaps ?? [];
  expect(
    evidenceItems.length,
    "depository fixture must carry extended-evidence items",
  ).toBeGreaterThan(0);
  expect(
    evidenceGaps.length,
    "depository fixture must carry explicit evidence gaps",
  ).toBeGreaterThan(0);
  expect(
    evidenceItems.find((item) => item.category === "valuation") ??
      evidenceGaps.find((gap) => gap.source === "valuation"),
    "valuation producer must emit evidence or an explicit gap",
  ).toBeDefined();
  expect(
    evidenceGaps.find((gap) => gap.source === "valuation"),
    "recorded valuation gap must preserve its missing-debt cause",
  ).toMatchObject({
    source: "valuation",
    cause: "provider-data-missing",
    message: expect.stringContaining("missing debt"),
  });
  expect(
    evidenceItems.find(
      (item) =>
        item.metrics?.enterpriseValue !== undefined ||
        item.metrics?.evToAnnualizedRevenue !== undefined,
    ),
    "extended evidence must omit enterprise-value metrics",
  ).toBeUndefined();

  const lenses = bundle?.derived.financialLenses?.lenses ?? [];
  expect(lenses.length, "depository fixture must carry financial lenses").toBeGreaterThan(0);
  const valueLens = lenses.find((lens) => lens.name === "Value");
  expect(valueLens, "depository fixture must carry the Value lens").toBeDefined();
  expect(valueLens?.metrics.length, "Value lens must carry non-EV metrics").toBeGreaterThan(0);
  expect(
    valueLens?.metrics.find(
      (metric) => metric.key === "enterpriseValue" || metric.key === "evToAnnualizedRevenue",
    ),
    "Value lens must omit enterprise-value metrics",
  ).toBeUndefined();

  const frameworkSections = bundle?.derived.businessFramework?.sections ?? [];
  expect(
    frameworkSections.length,
    "depository fixture must carry framework sections",
  ).toBeGreaterThan(0);
  const valuationSection = frameworkSections.find((section) => section.name === "Valuation");
  expect(valuationSection, "depository fixture must carry the Valuation framework").toBeDefined();
  expect(
    valuationSection?.metrics.length,
    "Valuation framework must carry non-EV metrics",
  ).toBeGreaterThan(0);
  expect(
    valuationSection?.metrics.find((metric) => metric.key === "evToAnnualizedRevenue"),
    "Valuation framework must omit EV/revenue",
  ).toBeUndefined();

  const workbench = bundle?.derived.valuationWorkbench;
  expect(workbench, "depository fixture must carry a valuation workbench").toBeDefined();
  expect(workbench?.peerComparison, "depository peer comparison must be suppressed").toMatchObject({
    status: "suppressed",
    reason: "enterprise-value-not-applicable",
  });
  expect(bundle?.derived.reverseDcf, "depository reverse DCF must be suppressed").toMatchObject({
    status: "suppressed",
    reason: "enterprise-value-not-applicable",
  });

  const observations = workbench?.historicalMultiples.observations ?? [];
  expect(
    observations.length,
    "depository fixture must carry workbench observations",
  ).toBeGreaterThan(0);
  for (const observation of observations) {
    expect(
      observation.metrics.enterpriseValueToRevenue,
      `${observation.basis} ${observation.periodEnd} EV/revenue`,
    ).toMatchObject({ status: "not-applicable", display: "not applicable" });
  }

  const rows = result.markdown
    .split("\n")
    .filter((line) => line.startsWith("ANNUAL | ") || line.startsWith("TTM | "));
  expect(rows.length, "workbench table must render rows").toBeGreaterThan(0);
  expect(rows.length, "workbench table must render rows").toBe(observations.length);
  for (const row of rows) {
    const cell = row.split(" | ")[EV_REVENUE_COLUMN];
    expect(cell, row).toBe(
      "not applicable (deposit-funded issuer; enterprise value is not defined)",
    );
    expect(NUMERIC_CELL.test(cell ?? ""), row).toBe(false);
  }
}

// BNS is the only recorded CAD-reporting, USD-quoted run; its real converted magnitudes are pinned as
// An independent oracle (ADR 0007), loose enough for re-recording, tight enough to catch an inverted rate.
const CONVERTED_ROW = /converted at USD\/CAD /gu;
const PINNED_CONVERSIONS = [
  { periodEnd: "2025-10-31", rate: 1.4, close: 70.55, pe: 98.77, ps: 123_264_963_232 },
  { periodEnd: "2026-01-31", rate: 1.3694, close: 75.38, pe: 103.22, ps: 138_816_182_634 },
] as const;
const RATE_TOLERANCE = 0.05;
const CLOSE_TOLERANCE = 2;
const MARKET_CAP_TOLERANCE = 5e9;

function expectNear(
  actual: number | undefined,
  expected: number,
  tolerance: number,
  label: string,
): void {
  expect(actual, `${label} must be a recorded number`).toBeNumber();
  expect(
    Math.abs((actual ?? Number.NaN) - expected),
    `${label} must be within ${tolerance} of ${expected}, got ${actual}`,
  ).toBeLessThanOrEqual(tolerance);
}

export function assertCurrencyConvertedValuation(result: RunFixtureResult): void {
  const workbench = result.deepEquityEvidenceBundle?.derived.valuationWorkbench;
  expect(workbench?.reportingCurrency, "fixture issuer must report in CAD").toBe("CAD");
  expect(workbench?.quoteCurrency, "fixture issuer must quote in USD").toBe("USD");

  const observations = workbench?.historicalMultiples.observations ?? [];
  expect(observations.length, "fixture must carry workbench observations").toBeGreaterThan(0);
  const converted = observations.flatMap((observation) =>
    observation.fxConversion === undefined
      ? []
      : [{ observation, fx: observation.fxConversion, price: observation.price }],
  );
  expect(
    converted.length,
    "fixture must carry currency-converted workbench observations",
  ).toBeGreaterThan(0);

  for (const { observation, fx, price } of converted) {
    const label = `${observation.basis} ${observation.periodEnd}`;
    expect(price, `${label} converted observation must carry a quoted close`).not.toBeNull();
    expect(price?.currency, `${label} close must be quoted in USD`).toBe("USD");
    expect(fx.pair, `${label} FX pair`).toBe("USDCAD=X");
    expect(fx.sourceId, `${label} FX source`).toBe("market-yahoo-fx-usdcad");
    expect(
      result.report.sources.some((source) => source.id === fx.sourceId),
      `${label} FX source must be cited in the report`,
    ).toBe(true);
    expect(
      fx.rateDate.localeCompare(price?.sessionDate ?? ""),
      `${label} FX rate date`,
    ).toBeLessThanOrEqual(0);
    expect(Number.isFinite(fx.rate) && fx.rate > 0, `${label} FX rate must be usable`).toBe(true);
    expect(fx.rate, `${label} FX rate must actually move the close`).not.toBe(1);

    // The exact converted numerators: close × rate for P/E, and that again × diluted shares for
    // P/S. An unconverted close would suppress both, and a wrong rate would miss both numbers.
    const convertedClose = (price?.close ?? 0) * fx.rate;
    const dilutedShares = observation.inputs.dilutedShares?.value;
    expect(dilutedShares, `${label} diluted shares`).toBeGreaterThan(0);
    expect(observation.metrics.priceToEarnings, `${label} P/E`).toMatchObject({
      status: "populated",
      numerator: convertedClose,
    });
    expect(observation.metrics.priceToSales, `${label} P/S`).toMatchObject({
      status: "populated",
      numerator: convertedClose * (dilutedShares ?? 0),
    });
  }

  const fy2024 = observations.find(
    (observation) => observation.basis === "annual" && observation.periodEnd === "2024-10-31",
  );
  expect(fy2024?.publicAt, "FY2024 dates to its first filing").toBe("2024-12-03");
  expect(fy2024?.metrics.priceToEarnings).toMatchObject({
    status: "suppressed",
    reason: "price-history-unavailable",
  });

  // The synthetic USDCAD cassette entry has no closes before 2025-11-25.
  expect(result.report.dataGaps).toContain(
    "market-yahoo-fx-usdcad: Yahoo FX close unavailable for USDCAD=X on or before 2025-08-26",
  );

  for (const pinned of PINNED_CONVERSIONS) {
    const match = converted.find(({ observation }) => observation.periodEnd === pinned.periodEnd);
    expect(match, `pinned ${pinned.periodEnd} must be a converted observation`).toBeDefined();
    const priceToEarnings = match?.observation.metrics.priceToEarnings;
    const priceToSales = match?.observation.metrics.priceToSales;
    expectNear(match?.fx.rate, pinned.rate, RATE_TOLERANCE, `pinned ${pinned.periodEnd} USD/CAD`);
    expectNear(
      match?.price?.close,
      pinned.close,
      CLOSE_TOLERANCE,
      `pinned ${pinned.periodEnd} quoted close`,
    );
    expectNear(
      priceToEarnings?.status === "populated" ? priceToEarnings.numerator : undefined,
      pinned.pe,
      CLOSE_TOLERANCE,
      `pinned ${pinned.periodEnd} converted close`,
    );
    expectNear(
      priceToSales?.status === "populated" ? priceToSales.numerator : undefined,
      pinned.ps,
      MARKET_CAP_TOLERANCE,
      `pinned ${pinned.periodEnd} converted market cap`,
    );
  }

  expect(
    result.markdown.match(CONVERTED_ROW)?.length,
    "every converted observation must render its rate",
  ).toBe(converted.length);
  expect(result.markdown, "workbench header must name both currencies").toContain(
    "Reporting currency: CAD. Quote currency: USD.",
  );
}

export function assertComprehensiveAnalysisPath(
  result: RunFixtureResult,
  modelRequests: readonly ModelRequest[],
): void {
  const finalSynthesisPrompt = modelRequests
    .find((request) => request.model === "fixture-synthesis")
    ?.messages.findLast((message) => message.role === "user")?.content;
  expect(finalSynthesisPrompt).toContain("earnings-direction");
  expect(finalSynthesisPrompt).toContain("earningsReturn(SUBJECT, YYYY-MM-DD, +N) > 0");

  expect(result.collectedSources.earningsSetup).toMatchObject({
    event: { symbol: "AAPL", eventDateStatus: "issuer-confirmed" },
  });
  expect(readEarningsForecastTelemetry(result.report)?.grammarEligible).toBe(true);
  expect(result.collectedSources.analystExpectations).toMatchObject({
    version: 1,
    symbol: "AAPL",
  });
  expect(result.collectedSources.analystExpectationsSignal?.status).toBe("available");
  expect(result.collectedSources.institutionalOwnership).toMatchObject({
    version: 1,
    symbol: "AAPL",
  });
  expect(result.collectedSources.institutionalOwnershipSignal?.status).toBe("available");

  for (const sourceId of [
    ...(result.report.equityAnalysisCompleteness?.dimensions.expectations.sourceIds ?? []),
    ...(result.collectedSources.analystExpectationsSignal?.sourceIds ?? []),
    ...(result.collectedSources.analystExpectations?.externalContext?.sourceIds ?? []),
    ...(result.collectedSources.institutionalOwnershipSignal?.sourceIds ?? []),
  ]) {
    expect(result.report.sources.some((source) => source.id === sourceId)).toBe(true);
  }
}

export function assertEstimatedEarningsSuppressionPath(
  result: RunFixtureResult,
  modelRequests: readonly ModelRequest[],
  modelOutputs: readonly string[],
): void {
  const finalSynthesisPrompt = modelRequests
    .find((request) => request.model === "fixture-synthesis")
    ?.messages.findLast((message) => message.role === "user")?.content;
  expect(finalSynthesisPrompt).toContain(
    "Do not emit earnings-direction, earnings-move, or earningsReturn grammar",
  );
  expect(finalSynthesisPrompt).not.toContain(
    "earnings-direction or earnings-move (event-anchored)",
  );
  expect(finalSynthesisPrompt).not.toContain("kind earnings-direction with measurableAs");
  expect(finalSynthesisPrompt).not.toContain("kind earnings-move with measurableAs");
  expect(finalSynthesisPrompt).toContain('"kind": "direction|relative|iv|range|conditional"');
  expect(
    modelOutputs.some(
      (output) =>
        output.includes('"kind":"earnings-direction"') && output.includes('"kind":"earnings-move"'),
    ),
  ).toBe(true);

  expect(result.collectedSources.earningsSetup).toMatchObject({
    event: { symbol: "AAPL", eventDateStatus: "provider-estimated" },
  });
  expect(result.collectedSources.analystExpectations).toBeUndefined();
  expect(result.collectedSources.analystExpectationsSignal?.status).toBe("forbidden");
  expect(result.collectedSources.institutionalOwnership).toBeUndefined();
  expect(result.collectedSources.institutionalOwnershipSignal?.status).toBe("forbidden");
}
