import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseObservableExpression } from "../../../src/forecast/observable";
import { isRecord } from "../../../src/guards";
import type { ModelRequest } from "../../../src/model/types";
import { assertSafeReportLanguage, validateResearchReport } from "../../../src/report/schema";
import type { FixtureMeta, RunFixtureResult } from ".";

export function assertInvariants(result: RunFixtureResult, meta: FixtureMeta): void {
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
  ]);
  for (const input of manifest.inputs) {
    const body = await readFile(join(root, "unsupported-inputs", input.file));
    expect(body.byteLength).toBe(input.bytes);
    expect(createHash("sha256").update(body).digest("hex")).toBe(input.sha256);
    expect(["unsupported", "discovery", "phase-3-candidate"]).toContain(input.structuredSupport);
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
