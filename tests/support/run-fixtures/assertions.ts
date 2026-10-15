import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveMarketSnapshotPriceAsOf } from "../../../src/domain/market-data";
import { readEarningsForecastTelemetry } from "../../../src/forecast/earnings-eligibility";
import { parseObservableExpression } from "../../../src/forecast/observable";
import { isRecord } from "../../../src/guards";
import type { ResearchReport } from "../../../src/domain/report";
import type { ModelRequest } from "../../../src/model/types";
import { projectEquityReader } from "../../../src/report/equity-reader";
import { assertSafeReportLanguage, validateResearchReport } from "../../../src/report/schema";
import { hasNoPriceHistory } from "../../../src/report/valuation-workbench-markdown";
import { RUN_ARTIFACT_FILES } from "../../../src/run-artifact-layout";
import { loadRunArtifact } from "../../../src/run-artifacts";
import { depositoryIssuerSic } from "../../../src/sources/extended-evidence/industry-classification";
import type { MetricSectionsExtra } from "../../../src/report/report-extras-contract";
import type { FinancialStatementSeriesKey } from "../../../src/sources/extended-evidence/financial-statements-contract";
import { financialStatementSeriesByKey } from "../../../src/sources/extended-evidence/financial-statement-selection";
import type { MetricInput } from "../../../src/sources/extended-evidence/metric-engine";
import type { FixtureMeta, RunFixtureResult } from ".";
import { assertFinancialRunInvariants } from "./financial-invariants";

function asWritten(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

// Equity-aapl-brief's cassette carries controlled model gaps: the anchored options restatement
// Must disappear; every genuine gap (issuer/company estimates, peers, methodology, transcript) survives.
export function assertProviderGapRestatementsDropped(result: RunFixtureResult): void {
  const gaps = result.report.dataGaps;
  expect(gaps).not.toContain("Options IV evidence is unavailable.");
  expect(gaps).toContain("Issuer EPS estimates are not supplied.");
  expect(gaps).toContain("Company earnings per share estimates are not provided.");
  expect(gaps).toContain("Usable peers are unavailable.");
  expect(gaps).toContain("Peer comparisons are unavailable.");
  expect(gaps).toContain("Estimated dividends are not supplied.");
  expect(gaps).toContain("Consensus dividends are not available.");
  expect(gaps).toContain("Analyst estimate ranges are not supplied.");
  expect(gaps).toContain("Estimate ranges are not available.");
  expect(gaps).toContain("The methodology behind analyst estimates is missing.");
  expect(gaps).toContain(
    "Analyst estimates are not supplied, but the methodology behind the forward P/E is unspecified.",
  );
  expect(gaps).toContain("Issuer transcript unavailable.");
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
  assertMetricSectionInvariants(result, report);
  assertBusinessFrameworkMetricInvariants(result, report);
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

const DAY_MS = 86_400_000;
const RELATIVE_TOLERANCE = 1e-9;

function days(start: string, end: string): number {
  return (Date.parse(end) - Date.parse(start)) / DAY_MS;
}

function expectClose(actual: unknown, expected: number, label: string): void {
  expect(typeof actual, label).toBe("number");
  expect(Math.abs((actual as number) - expected), label).toBeLessThanOrEqual(
    RELATIVE_TOLERANCE * Math.max(1, Math.abs(expected)),
  );
}

interface ResolvedInput {
  readonly value: number | string;
  readonly periodStart?: string;
  readonly periodEnd?: string;
  readonly periodKey?: string;
  readonly periodType?: string;
  readonly currency?: string;
}

type MetricInvariantRun = Pick<
  RunFixtureResult,
  "collectedSources" | "markdown" | "deepEquityEvidenceBundle"
>;

function isAnnualSpan(
  resolved: Pick<ResolvedInput, "periodStart" | "periodEnd"> | undefined,
): boolean {
  const span = days(resolved?.periodStart ?? "", resolved?.periodEnd ?? "");
  return span >= 350 && span <= 380;
}

// Looks the input up in its own artifact; the input's lineage must equal what the artifact holds.
function resolveInput(
  run: MetricInvariantRun,
  input: MetricInput,
  label: string,
  annualFlowsOnly = true,
): ResolvedInput | undefined {
  const {
    financialStatements,
    capitalOwnership,
    marketSnapshots,
    resolvedInstrumentIdentity,
    extendedEvidence,
  } = run.collectedSources;
  let resolved: ResolvedInput | undefined;
  if (input.artifact === "statements") {
    const series =
      financialStatements === undefined
        ? undefined
        : financialStatementSeriesByKey(
            financialStatements,
            input.series as FinancialStatementSeriesKey,
          );
    const fact = [...(series?.annual ?? []), ...(series?.interim ?? [])].find(
      (candidate) =>
        candidate.periodKey === input.periodKey && candidate.periodType === input.periodType,
    );
    resolved = fact && {
      value: fact.value,
      ...(fact.periodStart !== undefined ? { periodStart: fact.periodStart } : {}),
      periodEnd: fact.periodEnd,
      periodKey: fact.periodKey,
      periodType: fact.periodType,
      ...(fact.currency !== null ? { currency: fact.currency } : {}),
    };
    if (fact?.periodStart !== undefined) {
      if (annualFlowsOnly) {
        expect(fact.periodType, `${label} flow input is annual`).toBe("annual");
      }
      if (fact.periodType === "annual") {
        expect(isAnnualSpan(resolved), `${label} spans 350-380 days`).toBe(true);
      }
    }
  } else if (input.artifact === "evidence") {
    const item = extendedEvidence?.items.find(({ category }) => category === input.category);
    const value = item?.metrics?.[input.key ?? ""];
    resolved = value === undefined ? undefined : { value };
    expect(input.sourceIds, `${label} cites its evidence item`).toEqual(item?.sourceIds ?? []);
  } else if (input.artifact === "capitalOwnership") {
    const fact = capitalOwnership?.stockBasedCompensation.find(
      (candidate) =>
        candidate.periodStart === input.periodStart && candidate.periodEnd === input.periodEnd,
    );
    resolved = fact && {
      value: fact.value,
      ...(fact.periodStart !== undefined ? { periodStart: fact.periodStart } : {}),
      periodEnd: fact.periodEnd,
      periodType: "annual",
      currency: fact.unit,
    };
    expect(isAnnualSpan(resolved), `${label} spans 350-380 days`).toBe(true);
  } else {
    const snapshot = marketSnapshots.find((candidate) => candidate.sourceId === input.sourceIds[0]);
    const currency = resolvedInstrumentIdentity?.quoteCurrency ?? snapshot?.identity?.quoteCurrency;
    resolved =
      snapshot?.marketCap !== undefined
        ? {
            value: snapshot.marketCap,
            periodEnd: resolveMarketSnapshotPriceAsOf(snapshot).instant,
            ...(currency !== undefined ? { currency } : {}),
          }
        : undefined;
  }
  expect(resolved, `${label} resolves in ${input.artifact}`).toBeDefined();
  const lineage: Partial<ResolvedInput> = {
    value: input.value,
    ...(["periodStart", "periodEnd", "periodKey", "periodType", "currency"] as const).reduce(
      (fields, key) => (input[key] === undefined ? fields : { ...fields, [key]: input[key] }),
      {},
    ),
  };
  expect(lineage, `${label} lineage matches its artifact`).toEqual(
    resolved as Partial<ResolvedInput>,
  );
  return resolved;
}

export function assertMetricSectionInvariants(
  run: MetricInvariantRun,
  report: ResearchReport,
): void {
  const sections = report.extras?.metricSections as MetricSectionsExtra | undefined;
  const statements = run.collectedSources.financialStatements;
  const capitalReturn = sections?.find(({ id }) => id === "capital-return");
  expect(capitalReturn !== undefined, "statements imply a Capital Return Metric Section").toBe(
    statements !== undefined,
  );
  expect(run.markdown.includes("### Capital Return\n")).toBe(capitalReturn !== undefined);
  const bundle = run.deepEquityEvidenceBundle;
  if (bundle !== undefined) {
    expect(asWritten(bundle.derived.metricSections)).toEqual(asWritten(sections));
  }
  if (capitalReturn === undefined || statements === undefined) {
    return;
  }
  const unresolved = capitalReturn.metrics.filter(({ status }) => status !== "value");
  expect(
    report.dataGaps.some((gap) => gap.startsWith("capital-return: ")),
    "an unresolved Capital Return metric must surface its section gap",
  ).toBe(unresolved.length > 0);
  if (unresolved.some(({ status }) => status === "missing")) {
    expect(
      run.collectedSources.sourceGaps.find(({ source }) => source === "capital-return")?.triage,
    ).toBe("material");
  }
  const reportSourceIds = new Set(report.sources.map(({ id }) => id));
  const splitPeriodEnds = (series: string) =>
    statements.omissionNotes
      .filter((note) => note.code === "earlier-share-basis" && note.seriesKey === series)
      .map((note) => note.periodKey?.split("|").at(-1) ?? "");
  for (const metric of capitalReturn.metrics) {
    const label = `capital-return.${metric.id}`;
    for (const sourceId of metric.sourceIds) {
      expect(reportSourceIds.has(sourceId), `${label} cites ${sourceId}`).toBe(true);
    }
    const resolved = metric.inputs.map((input) =>
      resolveInput(run, input, `${label} ${input.label}`),
    );
    if (metric.status !== "value") {
      continue;
    }
    expect(
      (typeof metric.value === "number" && Number.isFinite(metric.value)) ||
        (typeof metric.value === "string" && metric.value !== ""),
      `${label} carries a finite number or non-empty text`,
    ).toBe(true);
    expect(metric.sourceIds.length, `${label} cites a source`).toBeGreaterThan(0);
    expect(metric.periodEnd, `${label} carries its FY end`).toBeDefined();
    const resolvedOf = (series: string): ResolvedInput | undefined =>
      resolved[metric.inputs.findIndex((input) => input.series === series)];
    const valueOf = (series: string): number => Number(resolvedOf(series)?.value ?? Number.NaN);
    const statementFacts = resolved.filter(
      (_fact, index) => metric.inputs[index]?.artifact === "statements",
    );
    const joined = (): void => {
      expect(
        new Set(statementFacts.map((fact) => `${fact?.periodKey}/${fact?.periodType}`)).size,
        `${label} joins one period`,
      ).toBe(1);
    };
    const marketCap = valueOf("marketCap");
    const dividends = Math.abs(valueOf("dividendsPaid"));
    const repurchases = Math.abs(valueOf("shareRepurchases"));
    const freeCashFlow = valueOf("operatingCashFlow") - Math.abs(valueOf("capitalExpenditure"));
    const endpoint = /^(shareCountChange|dpsCagr)(\d)y$/u.exec(metric.id);
    const endpointYears = endpoint?.[2] ?? (metric.id === "shareCountTrend" ? "3" : undefined);
    if (endpointYears !== undefined) {
      const [earlier, later] = statementFacts;
      const endpointSeries = endpoint?.[1] === "dpsCagr" ? "dividendsPerShare" : "dilutedShares";
      expect(metric.inputs.map(({ series }) => series)).toEqual([endpointSeries, endpointSeries]);
      const earlierEnd = earlier?.periodEnd ?? "";
      const laterEnd = later?.periodEnd ?? "";
      expect(
        Math.abs(days(earlierEnd, laterEnd) - Number(endpointYears) * 365),
        `${label} endpoints are ${endpointYears}y apart`,
      ).toBeLessThanOrEqual(15);
      expect(metric.periodEnd, `${label} ends at its later endpoint`).toBe(laterEnd);
      expect(
        splitPeriodEnds(endpointSeries).filter((end) => end >= earlierEnd && end <= laterEnd),
        `${label} window has no earlier share basis`,
      ).toEqual([]);
      const ratio = Number(later?.value ?? Number.NaN) / Number(earlier?.value ?? Number.NaN);
      if (endpointSeries === "dividendsPerShare") {
        expectClose(metric.value, ratio ** (1 / Number(endpointYears)) - 1, label);
      } else if (metric.id !== "shareCountTrend") {
        expectClose(metric.value, ratio - 1, label);
      }
    } else if (statementFacts.length > 0) {
      expect(metric.periodEnd, `${label} ends at its anchor FY`).toBe(statementFacts[0]?.periodEnd);
    }
    switch (metric.id) {
      case "fcfPayoutRatio": {
        joined();
        expectClose(metric.value, dividends / freeCashFlow, label);
        break;
      }
      case "totalPayoutToFcf": {
        joined();
        expectClose(metric.value, (dividends + repurchases) / freeCashFlow, label);
        break;
      }
      case "buybackYield": {
        expectClose(metric.value, repurchases / marketCap, label);
        break;
      }
      case "dividendYieldFiled": {
        expectClose(metric.value, dividends / marketCap, label);
        break;
      }
      case "shareholderYield": {
        joined();
        expectClose(metric.value, (dividends + repurchases) / marketCap, label);
        break;
      }
      case "dpsLatestFy": {
        expectClose(metric.value, valueOf("dividendsPerShare"), label);
        break;
      }
      case "earliestDividendFyInHistory": {
        const [earliest] = (
          financialStatementSeriesByKey(statements, "dividendsPerShare")?.annual ?? []
        )
          .filter((fact) => fact.value > 0 && isAnnualSpan(fact))
          .toSorted((left, right) => left.periodEnd.localeCompare(right.periodEnd));
        expect(metric.value, `${label} names the earliest positive FY`).toBe(
          `FY${String(earliest?.fiscalYear)}`,
        );
        expect(metric.periodEnd, `${label} ends at that FY`).toBe(earliest?.periodEnd);
        break;
      }
      default:
    }
    const quote = resolvedOf("marketCap");
    if (quote !== undefined) {
      expect(quote.currency, `${label} quote currency matches reporting`).toBe(
        statementFacts[0]?.currency,
      );
    }
  }
}

const FRAMEWORK_RATIOS: Readonly<Record<string, readonly [string, string]>> = {
  grossMargin: ["grossProfit", "revenue"],
  operatingMargin: ["operatingIncome", "revenue"],
};

export function assertBusinessFrameworkMetricInvariants(
  run: MetricInvariantRun,
  report: ResearchReport,
): void {
  const framework = run.collectedSources.businessFramework;
  if (framework === undefined) {
    return;
  }
  const sections = (report.extras?.metricSections as MetricSectionsExtra | undefined) ?? [];
  const reportSourceIds = new Set(report.sources.map(({ id }) => id));
  for (const frameworkSection of framework.sections) {
    for (const id of frameworkSection.metricSectionIds) {
      const section = sections.find((candidate) => candidate.id === id);
      expect(section, `${frameworkSection.name} references Metric Section ${id}`).toBeDefined();
      expect(run.markdown.includes(`### ${section?.title ?? id}\n`)).toBe(true);
      const unresolved = section?.metrics.filter(({ status }) => status !== "value") ?? [];
      expect(
        report.dataGaps.some((gap) => gap.startsWith(`${id}: `)),
        `${id} surfaces its section gap iff a metric is unresolved`,
      ).toBe(unresolved.length > 0);
      for (const metric of section?.metrics ?? []) {
        const label = `${id}.${metric.id}`;
        for (const sourceId of metric.sourceIds) {
          expect(reportSourceIds.has(sourceId), `${label} cites ${sourceId}`).toBe(true);
        }
        const resolved = metric.inputs.map((input) =>
          resolveInput(run, input, `${label} ${input.label}`, false),
        );
        if (metric.status !== "value" || typeof metric.value !== "number") {
          continue;
        }
        const [first, second] = resolved.map((input) => Number(input?.value));
        const ratio = FRAMEWORK_RATIOS[metric.id];
        // SEC-summary pass-through (no statements): inputs name evidence keys and YoY is filed.
        const passThrough = metric.inputs.every(({ artifact }) => artifact === "evidence");
        if (ratio !== undefined) {
          expect(metric.inputs.map(({ series, key }) => (passThrough ? key : series))).toEqual<
            readonly (string | undefined)[]
          >(ratio);
          if (!passThrough) {
            expect(resolved[0]?.periodKey, `${label} joins one period`).toBe(
              resolved[1]?.periodKey,
            );
          }
          expectClose(metric.value, (first ?? Number.NaN) / (second ?? Number.NaN), label);
        } else if (metric.id.endsWith("DeltaPercent") && !passThrough) {
          const prior = first ?? Number.NaN;
          expectClose(
            metric.value,
            (((second ?? Number.NaN) - prior) / Math.abs(prior)) * 100,
            label,
          );
        } else if (metric.id !== "phase") {
          expectClose(metric.value, first ?? Number.NaN, label);
        }
        if (metric.inputs[0]?.artifact === "statements") {
          expect(metric.periodEnd, `${label} ends at its anchor`).toBe(
            resolved.at(-1)?.periodEnd ?? resolved[0]?.periodEnd,
          );
        }
      }
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
  const valuationMetrics =
    bundle?.derived.metricSections?.find(({ id }) => id === "business-framework-valuation")
      ?.metrics ?? [];
  expect(
    valuationMetrics.some(({ status }) => status === "value"),
    "Valuation framework must carry non-EV metrics",
  ).toBe(true);
  expect(
    valuationMetrics.find((metric) => metric.id === "evToAnnualizedRevenue")?.status,
    "Valuation framework EV/revenue must be not-applicable",
  ).toBe("not-applicable");

  const capitalReturn = bundle?.derived.metricSections?.find(({ id }) => id === "capital-return");
  for (const id of ["fcfPayoutRatio", "totalPayoutToFcf"]) {
    expect(
      capitalReturn?.metrics.find((metric) => metric.id === id)?.status,
      `depository ${id} must be not-applicable`,
    ).toBe("not-applicable");
  }

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

  const pricedObservations = observations.filter((observation) => !hasNoPriceHistory(observation));
  const rows = result.markdown
    .split("\n")
    .filter((line) => line.startsWith("ANNUAL | ") || line.startsWith("TTM | "));
  expect(rows.length, "workbench table must render priced rows").toBe(pricedObservations.length);
  const unpricedPeriods = observations.length - pricedObservations.length;
  if (unpricedPeriods > 0) {
    expect(result.markdown).toContain(
      `${String(unpricedPeriods)} period${unpricedPeriods === 1 ? "" : "s"} without price history:`,
    );
  }
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

export function assertMarketRegimeRendered(result: RunFixtureResult): void {
  const regime = result.report.extras?.marketRegime;
  expect(regime, "fixture must carry a market regime").toBeDefined();
  if (!isRecord(regime)) {
    return;
  }
  expect(result.markdown, "market regime heading").toContain("## Market Regime");
  const sourcesIndex = result.markdown.indexOf("### Sources");
  expect(sourcesIndex, "Sources heading").toBeGreaterThanOrEqual(0);
  const sourcesSection = result.markdown.slice(sourcesIndex);
  const sourceIds = Array.isArray(regime.sourceIds)
    ? regime.sourceIds.filter((sourceId): sourceId is string => typeof sourceId === "string")
    : [];
  expect(sourceIds.length, "market regime must cite sources").toBeGreaterThan(0);
  for (const sourceId of sourceIds) {
    if (result.report.sources.some((source) => source.id === sourceId)) {
      expect(sourcesSection, `market regime source ${sourceId} in Sources`).toContain(
        `- [${sourceId}]`,
      );
    }
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
  expect(readEarningsForecastTelemetry(result.report)?.grammarEligible).toBe(true);
  const confirmationSourceId =
    result.collectedSources.earningsSetup?.event.dateConfirmation?.sourceId;
  expect(confirmationSourceId, "fixture must carry a date-confirmation source").toBeDefined();
  expect(result.collectedSources.earningsSetup?.event.confirmedBy).toMatchObject({
    sourceId: confirmationSourceId,
    sourceType: result.collectedSources.earningsSetup?.event.dateConfirmation?.sourceType,
  });
  expect(result.collectedSources.earningsSetup?.event.dateConflict).toBeUndefined();
  const consensus =
    projectEquityReader({ report: result.report }).defaultView.earningsConsensus ?? [];
  for (const kind of ["eps-consensus", "revenue-consensus"] as const) {
    const item = consensus.find((candidate) => candidate.kind === kind);
    expect(item, `${kind} must render`).toBeDefined();
    expect(
      item?.sourceIds ?? [],
      `${kind} must exclude the date-confirmation source`,
    ).not.toContain(confirmationSourceId);
  }
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
  expect(result.collectedSources.earningsSetup?.event.confirmedBy).toBeUndefined();
  expect(result.collectedSources.earningsSetup?.event.dateConflict).toBeUndefined();
  expect(result.collectedSources.analystExpectations).toBeUndefined();
  expect(result.collectedSources.analystExpectationsSignal?.status).toBe("forbidden");
  expect(result.collectedSources.institutionalOwnership).toBeUndefined();
  expect(result.collectedSources.institutionalOwnershipSignal?.status).toBe("forbidden");
}
