import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseObservableExpression } from "../../../src/forecast/observable";
import { isRecord } from "../../../src/guards";
import type { ModelRequest } from "../../../src/model/types";
import { assertSafeReportLanguage, validateResearchReport } from "../../../src/report/schema";
import { depositoryIssuerSic } from "../../../src/sources/extended-evidence/industry-classification";
import type { FixtureMeta, RunFixtureResult } from ".";
import { assertFinancialRunInvariants } from "./financial-invariants";

export async function assertInvariants(result: RunFixtureResult, meta: FixtureMeta): Promise<void> {
  const report = validateResearchReport(result.report);
  assertSafeReportLanguage(report);
  for (const prediction of report.predictions) {
    expect(() => parseObservableExpression(prediction.measurableAs)).not.toThrow();
  }
  expect(result.markdown.match(/Research-only note/gu)?.length).toBe(1);
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
  expect(finalSynthesisPrompt).toContain('"kind": "direction|relative|iv|range|macro|conditional"');
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
