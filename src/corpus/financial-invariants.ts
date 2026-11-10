import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtendedEvidenceItem } from "../domain/evidence";
import type { EquityAnalysisCompletenessDimension } from "../domain/report";
import {
  hasSubstantiveResultsContent,
  normalizeFilingText,
} from "../sources/evidence-request-tools";
import { EQUITY_FRESHNESS_GAP_REASON_CODES } from "../sources/extended-evidence/equity-analysis-completeness";
import { filingDocuments } from "../sources/extended-evidence/sec-archive";
import {
  EQUITY_ANALYSIS_COMPLETENESS_DIMENSION_KEYS,
  resolveCoverageLevel,
} from "../domain/equity-analysis-completeness";
import { readGapTriage } from "../report/gap-triage";
import type { FinancialLensArtifact } from "../sources/extended-evidence/financial-lens";
import type {
  FinancialStatementFact,
  FinancialStatementSeriesKey,
  FinancialStatementsArtifact,
} from "../sources/extended-evidence/financial-statements-contract";
import {
  financialStatementFacts,
  financialStatementFactsAreCompatible,
  financialStatementPeriodMonths,
  financialStatementSeriesByKey,
  latestFinancialStatementFact,
} from "../sources/extended-evidence/financial-statement-selection";
import {
  MIN_CAGR_ANNUAL_POINTS,
  type FundamentalHistoryArtifact,
  type FundamentalHistorySeries,
} from "../sources/extended-evidence/fundamental-history";
import {
  conceptScope,
  isContinuingScope,
} from "../sources/extended-evidence/financial-statement-definitions";
import {
  MAX_BALANCE_SHEET_PERIOD_DIVERGENCE_DAYS,
  MIXED_PERIOD_METRIC,
} from "../sources/extended-evidence/valuation-comps";
import { yearsBetween } from "./fiscal-years";
import { isDeepFixture, type FixtureMeta, type RunFixtureResult } from "../replay/fixture-run";
import { invariant, assertFinancialStatementInvariants } from "./financial-statement-invariants";

const DAY_MS = 86_400_000;
const PER_SHARE_CURRENCY = /^([A-Z]{3})\/shares$/u;
const ISO_CURRENCY = /^[A-Z]{3}$/u;

const FINANCIAL_LENS_INPUTS: Readonly<Record<string, readonly FinancialStatementSeriesKey[]>> = {
  grossMargin: ["grossProfit", "revenue"],
  operatingMargin: ["operatingIncome", "revenue"],
  netMargin: ["netIncome", "revenue"],
  consolidatedNetIncome: ["netIncome", "consolidatedNetIncome"],
  freeCashFlowProxy: ["operatingCashFlow", "capitalExpenditure"],
  roe: ["netIncome", "stockholdersEquity"],
  roa: ["netIncome", "totalAssets"],
  payoutRatio: ["dividendsPaid", "netIncome"],
  revenueDeltaPercent: ["revenue"],
  grossProfitDeltaPercent: ["grossProfit"],
  operatingIncomeDeltaPercent: ["operatingIncome"],
  netIncomeDeltaPercent: ["netIncome"],
  dilutedEpsDeltaPercent: ["dilutedEps"],
  continuingIncomeDeltaPercent: ["continuingIncome"],
  continuingDilutedEpsDeltaPercent: ["continuingDilutedEps"],
  operatingCashFlowDeltaPercent: ["operatingCashFlow"],
  capexDeltaPercent: ["capitalExpenditure"],
  annualizedRevenue: ["revenue"],
  evToAnnualizedRevenue: ["revenue"],
  marketCapToAnnualizedRevenue: ["revenue"],
  valuationSupportability: ["revenue"],
  valuationCaveat: ["revenue"],
  pcfRatio: ["operatingCashFlow"],
};

// TTM is derived (FY + YTD - prior YTD), so no filed fact spans its 12 months; it anchors on a revenue fact's end.
const TTM_LENS_METRICS = new Set([
  "annualizedRevenue",
  "evToAnnualizedRevenue",
  "marketCapToAnnualizedRevenue",
]);

const FLOW_OVER_INSTANT_INPUTS: Readonly<
  Record<string, readonly [FinancialStatementSeriesKey, FinancialStatementSeriesKey]>
> = {
  roe: ["netIncome", "stockholdersEquity"],
  roa: ["netIncome", "totalAssets"],
};

function assertSummarySpan(
  series: FundamentalHistorySeries,
  summary: { readonly years: number; readonly periodStart: string; readonly periodEnd: string },
  kind: "cagr" | "marginChange",
): void {
  const first = series.annual.find((point) => point.periodEnd === summary.periodStart);
  const last = series.annual.find((point) => point.periodEnd === summary.periodEnd);
  invariant(
    first !== undefined && last !== undefined,
    "B9",
    `${series.key} ${kind} endpoints missing`,
  );
  invariant(
    Math.abs(summary.years - yearsBetween(first.periodEnd, last.periodEnd)) < 1e-12,
    "B9",
    `${series.key} ${kind} years disagree with its annual-point span`,
  );
}

export function assertFundamentalHistoryInvariants(
  history: FundamentalHistoryArtifact,
  requireRevenueDepth: boolean,
): void {
  for (const series of Object.values(history.series)) {
    if (series.cagr !== undefined) {
      assertSummarySpan(series, series.cagr, "cagr");
    }
    if (series.marginChange !== undefined) {
      assertSummarySpan(series, series.marginChange, "marginChange");
      const first = series.annual.at(0);
      const last = series.annual.at(-1);
      invariant(
        first !== undefined &&
          last !== undefined &&
          series.marginChange.periodStart === first.periodEnd &&
          series.marginChange.periodEnd === last.periodEnd,
        "B9",
        `${series.key} marginChange does not summarize the emitted annual array`,
      );
      invariant(
        Math.sign(series.marginChange.percentagePoints) === Math.sign(last.value - first.value),
        "B9",
        `${series.key} marginChange sign disagrees with its annual endpoints`,
      );
    }
  }
  if (requireRevenueDepth) {
    // This is the production CAGR viability floor; A1/B9 guard cap loss and summarized span.
    invariant(
      history.series.revenue.annual.length >= MIN_CAGR_ANNUAL_POINTS,
      "B10",
      `SEC-backed deep fixture retained fewer than ${String(MIN_CAGR_ANNUAL_POINTS)} annual revenue periods`,
    );
  }
}

function statementInputFact(
  artifact: FinancialStatementsArtifact,
  key: FinancialStatementSeriesKey,
  periodEnd: string,
  periodMonths: number,
  allowNearbyInstant: boolean,
): FinancialStatementFact | undefined {
  const series = financialStatementSeriesByKey(artifact, key);
  if (series === undefined) {
    return;
  }
  const facts = financialStatementFacts(series);
  const exactDuration = facts.filter(
    (fact) => fact.periodEnd === periodEnd && financialStatementPeriodMonths(fact) === periodMonths,
  );
  if (exactDuration.length > 0) {
    return latestFinancialStatementFact(exactDuration);
  }
  if (!allowNearbyInstant) {
    return;
  }
  return facts
    .filter(
      (fact) =>
        fact.periodStart === undefined &&
        Math.abs(Date.parse(fact.periodEnd) - Date.parse(periodEnd)) / DAY_MS <=
          MAX_BALANCE_SHEET_PERIOD_DIVERGENCE_DAYS,
    )
    .toSorted(
      (left, right) =>
        Math.abs(Date.parse(left.periodEnd) - Date.parse(periodEnd)) -
        Math.abs(Date.parse(right.periodEnd) - Date.parse(periodEnd)),
    )[0];
}

function cashConversionIncomeKey(
  artifact: FinancialStatementsArtifact,
): FinancialStatementSeriesKey {
  const ocf = latestFinancialStatementFact(
    financialStatementFacts(artifact.statements.cashFlowStatement.operatingCashFlow),
  );
  return isContinuingScope(conceptScope(ocf?.concept)) ? "continuingIncome" : "netIncome";
}

export function assertFinancialLensPeriodHygiene(
  artifact: FinancialStatementsArtifact,
  lenses: FinancialLensArtifact,
): void {
  for (const metric of lenses.lenses.flatMap((lens) => lens.metrics)) {
    if (metric.periodEnd !== undefined && TTM_LENS_METRICS.has(metric.key)) {
      const revenue = financialStatementSeriesByKey(artifact, "revenue");
      invariant(
        metric.periodMonths === 12 &&
          revenue !== undefined &&
          financialStatementFacts(revenue).some((fact) => fact.periodEnd === metric.periodEnd),
        "B8",
        `${metric.key} is not a 12-month span ending at a filed revenue period`,
      );
      continue;
    }
    if (metric.periodEnd === undefined || metric.periodMonths === undefined) {
      continue;
    }
    if (metric.value === MIXED_PERIOD_METRIC) {
      continue;
    }
    const inputKeys =
      metric.key === "cashConversion"
        ? (["operatingCashFlow", cashConversionIncomeKey(artifact)] as const)
        : FINANCIAL_LENS_INPUTS[metric.key];
    invariant(inputKeys !== undefined, "B8", `${metric.key} has no statement-input contract`);
    const flowOverInstant = FLOW_OVER_INSTANT_INPUTS[metric.key];
    const facts = inputKeys.map((key) =>
      statementInputFact(
        artifact,
        key,
        metric.periodEnd!,
        metric.periodMonths!,
        flowOverInstant?.[1] === key,
      ),
    );
    invariant(
      facts.every((fact) => fact !== undefined),
      "B8",
      `${metric.key} has no compatible facts for ${metric.periodEnd}`,
    );
    const compatibleFacts = facts as readonly FinancialStatementFact[];
    invariant(
      financialStatementFactsAreCompatible(compatibleFacts),
      "B8",
      `${metric.key} mixes statement currencies or units`,
    );
    if (flowOverInstant !== undefined) {
      const [flow, instant] = compatibleFacts;
      invariant(
        flow !== undefined &&
          instant !== undefined &&
          Math.abs(Date.parse(flow.periodEnd) - Date.parse(instant.periodEnd)) / DAY_MS <=
            MAX_BALANCE_SHEET_PERIOD_DIVERGENCE_DAYS,
        "B8",
        `${metric.key} flow and balance-sheet periods diverge by more than 92 days`,
      );
    }
  }
}

export function assertSourceIdClosure(
  value: unknown,
  knownSourceIds: ReadonlySet<string>,
  root = "artifact",
): void {
  const visit = (candidate: unknown, path: string): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(item, `${path}[${String(index)}]`));
      return;
    }
    if (candidate === null || typeof candidate !== "object") {
      return;
    }
    for (const [key, item] of Object.entries(candidate)) {
      const itemPath = `${path}.${key}`;
      // Prior runs' citations resolve against their own runs, as the bundle reader allows.
      if (key === "historicalContext") {
        continue;
      }
      if (key === "sourceIds") {
        invariant(Array.isArray(item), "C12", `${itemPath} is not an array`);
        for (const sourceId of item) {
          invariant(
            typeof sourceId === "string" && knownSourceIds.has(sourceId),
            "C12",
            `${itemPath} cites unknown source ID ${String(sourceId)}`,
          );
        }
      } else {
        visit(item, itemPath);
      }
    }
  };
  visit(value, root);
}

function assertGapTriage(result: RunFixtureResult): void {
  const appendixIndex = result.markdown.indexOf("\n## Appendix\n");
  const reader = (
    appendixIndex === -1 ? result.markdown : result.markdown.slice(0, appendixIndex)
  ).replaceAll("\\", "");
  /*
   * Mirror what the renderer actually does (markdown-primitives.renderGap): read the structured
   * triage first and fall back to the text heuristic. Re-deriving from text alone made this a
   * parallel classifier that disagreed with the report whenever a collector declared a triage.
   */
  for (const gap of result.report.dataGaps) {
    const inReader = reader.includes(gap);
    if (
      readGapTriage(gap, result.collectedSources.sourceGaps, result.report.symbol) === "material"
    ) {
      invariant(inReader, "C13", `material gap missing from reader block: ${gap}`);
    } else {
      invariant(!inReader, "C13", `diagnostic gap leaked into reader block: ${gap}`);
    }
  }
}

function assertCompleteness(result: RunFixtureResult, knownSourceIds: ReadonlySet<string>): void {
  const completeness = result.report.equityAnalysisCompleteness;
  if (completeness === undefined) {
    return;
  }
  for (const key of EQUITY_ANALYSIS_COMPLETENESS_DIMENSION_KEYS) {
    for (const sourceId of completeness.dimensions[key].sourceIds) {
      invariant(
        knownSourceIds.has(sourceId),
        "C14",
        `${key} completeness cites unknown source ID ${sourceId}`,
      );
    }
  }
  const derivationDimensions: readonly EquityAnalysisCompletenessDimension[] = [
    completeness.dimensions.valuation,
    completeness.dimensions.expectations,
    completeness.dimensions.capitalOwnership,
    completeness.dimensions.operatingKpis,
  ];
  invariant(
    resolveCoverageLevel(derivationDimensions, completeness.financialCoreStatus) ===
      completeness.coverageLevel,
    "C14",
    "coverageLevel disagrees with its completeness dimensions",
  );
}

const EARNINGS_RELEASE_ITEM_CODE = "2.02";
const QUARTER_FILING_LAG_DAYS = 60;
const HALF_YEAR_FILING_LAG_DAYS = 120;

function extendedEvidenceItems(result: RunFixtureResult): readonly ExtendedEvidenceItem[] {
  return result.collectedSources.extendedEvidence?.items ?? [];
}

const EARNINGS_RELEASE_DOCUMENTS = new Set(["exhibit", "primary", "none"]);
const EARNINGS_RELEASE_EXHIBITS = new Set(["substantive", "not-substantive", "unresolved"]);

function retainedExhibitUrls(
  result: RunFixtureResult,
  accessionNumber: string,
  url: string,
  primaryDocument: string,
): ReadonlySet<string> {
  const baseUrl = url.slice(0, url.lastIndexOf("/"));
  return new Set(
    result.collectedSources.rawSnapshots.flatMap((snapshot) =>
      snapshot.adapter === "sec-filing-index" &&
      typeof snapshot.payload === "string" &&
      // Raw snapshots keep no request URL; the index page title is the filing's own identity.
      snapshot.payload.match(/<title>EDGAR Filing Documents for ([\d-]+)<\/title>/u)?.[1] ===
        accessionNumber
        ? filingDocuments(snapshot.payload, baseUrl, primaryDocument, true).map(
            (document) => document.url,
          )
        : [],
    ),
  );
}

// An Item 2.02 current report must reach the model as results, not as a cover sheet pointing at an
// Exhibit. Exhibit-resolution provenance is validated on every matched item — including the
// Metadata-only fallbacks, which retain no text — while the content checks apply to the items whose
// Source actually carries a snippet.
export function assertEarningsReleaseEvidence(result: RunFixtureResult): void {
  const sources = new Map(result.report.sources.map((source) => [source.id, source]));
  let matched = 0;
  let checked = 0;
  for (const item of extendedEvidenceItems(result)) {
    const items = item.metrics?.items;
    if (
      item.category !== "sec-edgar" ||
      typeof items !== "string" ||
      !items.split(",").includes(EARNINGS_RELEASE_ITEM_CODE)
    ) {
      continue;
    }
    matched += 1;
    const accession = String(item.metrics?.accessionNumber ?? "").replaceAll("-", "");
    const primaryDocument = String(item.metrics?.primaryDocument ?? "");
    // Both documents can pass the substantive predicate — a cover sheet carrying headline figures
    // While the detail lives in the exhibit — so text and URL alone cannot separate a legitimate
    // Cover preference from a resolution regression. The persisted provenance can.
    const { earningsReleaseDocument, earningsReleaseExhibit } = item.metrics ?? {};
    invariant(
      EARNINGS_RELEASE_DOCUMENTS.has(String(earningsReleaseDocument)) &&
        EARNINGS_RELEASE_EXHIBITS.has(String(earningsReleaseExhibit)),
      "C15",
      `Item 2.02 evidence ${item.title} carries no exhibit-resolution provenance`,
    );
    invariant(
      earningsReleaseExhibit !== "substantive" || earningsReleaseDocument !== "primary",
      "C15",
      `Item 2.02 evidence ${item.title} resolved a substantive EX-99 exhibit but shipped the primary document`,
    );
    for (const sourceId of item.sourceIds) {
      const source = sources.get(sourceId);
      if (source?.snippet === undefined) {
        continue;
      }
      checked += 1;
      invariant(
        earningsReleaseDocument !== "none",
        "C15",
        `Item 2.02 evidence ${sourceId} carries filing text but claims no document was retained`,
      );
      invariant(
        hasSubstantiveResultsContent(normalizeFilingText(source.snippet)),
        "C15",
        `Item 2.02 evidence ${sourceId} reports no results content`,
      );
      const url = source.url ?? "";
      const cited = url.split("/").at(-1) ?? "";
      invariant(
        accession !== "" && url.includes(`/${accession}/`),
        "C15",
        `Item 2.02 evidence ${sourceId} cites a document outside its own filing`,
      );
      invariant(
        cited === primaryDocument || earningsReleaseDocument === "exhibit",
        "C15",
        `Item 2.02 evidence ${sourceId} cites ${cited}, neither the primary document nor a resolved exhibit`,
      );
      invariant(
        earningsReleaseDocument !== "exhibit" || cited !== primaryDocument,
        "C15",
        `Item 2.02 evidence ${sourceId} claims exhibit provenance but cites the primary document`,
      );
      invariant(
        earningsReleaseDocument !== "exhibit" ||
          retainedExhibitUrls(
            result,
            String(item.metrics?.accessionNumber),
            url,
            primaryDocument,
          ).has(url),
        "C15",
        `Item 2.02 evidence ${sourceId} cites ${cited}, which its retained filing index does not list as EX-99`,
      );
    }
  }
  invariant(
    matched === 0 || checked > 0,
    "C15",
    "an Item 2.02 filing was selected but no evidence source carried its text",
  );
}

// Completeness gaps carry their reason code as a deterministic message prefix (SourceGap has no
// `code` field), must stay inside the freshness allowlist, and must never cap Evidence Quality.
function assertCompletenessGaps(result: RunFixtureResult): void {
  const reasonCodes = new Set(
    Object.values(result.report.equityAnalysisCompleteness?.dimensions ?? {}).flatMap(
      (dimension: EquityAnalysisCompletenessDimension) => dimension.reasonCodes,
    ),
  );
  for (const gap of result.collectedSources.sourceGaps) {
    if (gap.source !== "equity-analysis-completeness") {
      continue;
    }
    const code = gap.message.slice(0, gap.message.indexOf(":"));
    invariant(
      EQUITY_FRESHNESS_GAP_REASON_CODES.includes(code),
      "C15",
      `completeness gap is not attributable to an allowlisted reason code: ${gap.message}`,
    );
    invariant(
      reasonCodes.has(code),
      "C15",
      `completeness gap ${code} disagrees with the reported completeness dimensions`,
    );
    invariant(
      gap.evidenceQualityImpact === "no-cap",
      "C15",
      `completeness gap ${code} caps evidence quality as ${String(gap.evidenceQualityImpact)}`,
    );
  }
}

function addMonthsUtc(value: string, months: number): string {
  const date = new Date(Date.parse(value));
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const targetLastDay = new Date(Date.UTC(year, month + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month + months, day === lastDay ? targetLastDay : day))
    .toISOString()
    .slice(0, 10);
}

// Independent re-derivation of "the newest interim period whose filing deadline has passed".
function rederiveLatestDuePeriodEnd(
  cadence: string,
  annualEnd: string,
  asOf: string,
): string | undefined {
  const schedule = {
    quarterly: { months: 3, lagDays: QUARTER_FILING_LAG_DAYS },
    semiannual: { months: 6, lagDays: HALF_YEAR_FILING_LAG_DAYS },
  }[cadence];
  if (schedule === undefined) {
    return undefined;
  }
  const { months, lagDays } = schedule;
  let periodEnd = addMonthsUtc(annualEnd, months);
  let latest: string | undefined = undefined;
  while (
    new Date(Date.parse(periodEnd) + lagDays * DAY_MS).toISOString().slice(0, 10) <=
    asOf.slice(0, 10)
  ) {
    latest = periodEnd;
    periodEnd = addMonthsUtc(periodEnd, months);
  }
  return latest;
}

// The always-on freshness context must be present whenever a statement artifact is, and each date
// It publishes must survive an independent re-derivation from the statements themselves.
function assertReportingFreshness(
  result: RunFixtureResult,
  artifact: FinancialStatementsArtifact,
): void {
  const lensItem = extendedEvidenceItems(result).find((item) => item.category === "financial-lens");
  invariant(
    lensItem !== undefined,
    "C16",
    "a statement artifact exists but no financial-lens evidence item carries its freshness context",
  );
  const metrics = lensItem.metrics ?? {};
  const { revenue } = artifact.statements.incomeStatement;
  const expectedReported = latestFinancialStatementFact(
    financialStatementFacts(revenue),
  )?.periodEnd;
  // Freshness is published only for an artifact that reports at least one primary-revenue period.
  const expectedCadence = expectedReported === undefined ? undefined : artifact.interimCadence;
  invariant(
    metrics.interimCadence === expectedCadence,
    "C16",
    `financial-lens interimCadence is ${String(metrics.interimCadence)}, expected ${String(expectedCadence)}`,
  );
  invariant(
    metrics.latestReportedPeriodEnd === expectedReported,
    "C16",
    `latestReportedPeriodEnd is ${String(metrics.latestReportedPeriodEnd)}, expected ${String(expectedReported)}`,
  );
  const currentAnnual = latestFinancialStatementFact(
    revenue.annual.filter((fact) => {
      const months = financialStatementPeriodMonths(fact);
      return months !== undefined && months >= 10 && months <= 14;
    }),
  );
  const expectedDue =
    currentAnnual === undefined || expectedReported === undefined
      ? undefined
      : rederiveLatestDuePeriodEnd(
          artifact.interimCadence,
          currentAnnual.periodEnd,
          artifact.analysisAsOf,
        );
  invariant(
    metrics.expectedDuePeriodEnd === expectedDue,
    "C16",
    `expectedDuePeriodEnd is ${String(metrics.expectedDuePeriodEnd)}, expected ${String(expectedDue)}`,
  );
}

function assertNumericAndCurrencyHygiene(value: unknown, root: string): void {
  const visit = (candidate: unknown, path: string, key?: string): void => {
    if (typeof candidate === "number") {
      invariant(Number.isFinite(candidate), "D15", `${path} is not finite`);
      return;
    }
    if (key === "currency" && candidate !== null) {
      invariant(typeof candidate === "string", "D15", `${path} is not a currency string`);
      const perShare = PER_SHARE_CURRENCY.exec(candidate);
      invariant(
        ISO_CURRENCY.test(perShare?.[1] ?? candidate),
        "D15",
        `${path} is not a three-letter ISO currency code`,
      );
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(item, `${path}[${String(index)}]`));
      return;
    }
    if (candidate === null || typeof candidate !== "object") {
      return;
    }
    for (const [childKey, item] of Object.entries(candidate)) {
      visit(item, `${path}.${childKey}`, childKey);
    }
  };
  visit(value, root);
}

async function normalizedArtifacts(runDir: string): Promise<Readonly<Record<string, unknown>>> {
  const normalizedDir = join(runDir, "normalized");
  const normalizedFiles = await readdir(normalizedDir);
  const files = normalizedFiles.filter((file) => file.endsWith(".json"));
  const entries = await Promise.all(
    files.map(async (file) => [
      file,
      JSON.parse(await readFile(join(normalizedDir, file), "utf8")),
    ]),
  );
  return Object.fromEntries(entries);
}

export async function assertFinancialRunInvariants(
  result: RunFixtureResult,
  meta: FixtureMeta,
): Promise<void> {
  const statements = result.deepEquityEvidenceBundle?.derived.financialStatements;
  const history = result.deepEquityEvidenceBundle?.derived.fundamentalHistory;
  const lenses = result.deepEquityEvidenceBundle?.derived.financialLenses;
  if (statements !== undefined) {
    assertFinancialStatementInvariants(statements);
  }
  if (history !== undefined) {
    assertFundamentalHistoryInvariants(history, statements !== undefined && isDeepFixture(meta));
  }
  if (statements !== undefined && lenses !== undefined) {
    assertFinancialLensPeriodHygiene(statements, lenses);
  }

  assertGapTriage(result);
  assertEarningsReleaseEvidence(result);
  assertCompletenessGaps(result);
  if (result.collectedSources.financialStatements !== undefined) {
    assertReportingFreshness(result, result.collectedSources.financialStatements);
  }
  const knownSourceIds = new Set(result.report.sources.map((source) => source.id));
  assertCompleteness(result, knownSourceIds);
  const normalized = await normalizedArtifacts(result.artifacts.runDir);
  if (result.deepEquityEvidenceBundle !== undefined) {
    assertSourceIdClosure(result.deepEquityEvidenceBundle, knownSourceIds, "evidence-bundle");
  }
  for (const [file, artifact] of Object.entries(normalized)) {
    if (file !== "historical-context.json") {
      assertSourceIdClosure(artifact, knownSourceIds, `normalized/${file}`);
    }
  }
  assertNumericAndCurrencyHygiene(result.report, "report");
  assertNumericAndCurrencyHygiene(result.analytics, "analytics");
  assertNumericAndCurrencyHygiene(normalized, "normalized");
}
