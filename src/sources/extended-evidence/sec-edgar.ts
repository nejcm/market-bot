import type { InstrumentIdentity, Source, SourceGap } from "../../domain/types";
import { isInstrumentCommand } from "../../cli/args";
import { DAY_MS, SEC_FRESHNESS_DAYS } from "../../config/shared";
import { sourceGap } from "../../domain/source-gaps";
import { isRecord, readNumber, readString } from "../../guards";
import { isFetchJsonResult, type CollectContext, type RawSourceSnapshot } from "../types";
import { isUsListing } from "../instrument-capability";
import { evidenceSource, type CollectedItem, type ProviderResult } from "./common";
import { readArray } from "./utils";

type SecForm = "10-K" | "10-Q";

export interface SecFactValue {
  readonly val: number;
  readonly form: SecForm;
  readonly fp?: string;
  readonly fy?: number;
  readonly filed?: string;
  readonly start?: string;
  readonly end?: string;
}

const DAYS_PER_MONTH = 30.4368;

export interface SecMetricDefinition {
  readonly key: string;
  readonly label: string;
  readonly concepts: readonly string[];
  readonly unitKeys: readonly string[];
  // Optional metrics are emitted when present but their absence is not a data
  // Gap (e.g. dividendsPaid is absent for non-dividend-paying issuers). Required
  // Metrics add to missingFacts/missingDeltas and cap evidence quality when absent.
  readonly optional?: boolean;
}

interface SecMetricSelection {
  readonly latest: SecFactValue;
  readonly prior?: SecFactValue;
}

export interface SecFundamentalsSummary {
  readonly summary: string;
  readonly metrics: Record<string, number | string>;
  readonly revenuePeriodEnd?: string;
  readonly gaps: readonly SourceGap[];
}

export interface SecSicClassification {
  readonly sic: string;
  readonly sicDescription?: string;
}

export interface SecCompanyFactsResult {
  readonly symbol: string;
  readonly cik?: string;
  readonly identity?: InstrumentIdentity;
  readonly sourceId?: string;
  readonly sourceUrl?: string;
  readonly fetchedAt?: string;
  readonly factsPayload?: unknown;
  readonly metrics?: Record<string, number | string>;
  readonly summary?: string;
  readonly revenuePeriodEnd?: string;
  readonly sicClassification?: SecSicClassification;
  readonly filingsSummary?: string;
  readonly submissionsUrl?: string;
  readonly submissionsPayload?: unknown;
  readonly submissionsSourceId?: string;
  readonly submissionsFetchedAt?: string;
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly gaps: readonly SourceGap[];
}

export const SEC_METRIC_DEFINITIONS: readonly SecMetricDefinition[] = [
  {
    key: "revenue",
    label: "revenue",
    concepts: [
      "Revenues",
      "SalesRevenueNet",
      "RevenueFromContractWithCustomerExcludingAssessedTax",
      "RevenueFromContractWithCustomerIncludingAssessedTax",
    ],
    unitKeys: ["USD"],
  },
  {
    key: "grossProfit",
    label: "gross profit",
    concepts: ["GrossProfit"],
    unitKeys: ["USD"],
  },
  {
    key: "operatingIncome",
    label: "operating income",
    concepts: ["OperatingIncomeLoss"],
    unitKeys: ["USD"],
  },
  {
    key: "netIncome",
    label: "net income attributable to parent",
    concepts: ["NetIncomeLoss"],
    unitKeys: ["USD"],
  },
  {
    key: "consolidatedNetIncome",
    label: "net income consolidated including NCI",
    concepts: ["ProfitLoss"],
    unitKeys: ["USD"],
    optional: true,
  },
  {
    key: "dilutedEps",
    label: "diluted EPS",
    concepts: ["EarningsPerShareDiluted"],
    unitKeys: ["USD/shares"],
  },
  {
    key: "cash",
    label: "cash",
    concepts: [
      "CashAndCashEquivalentsAtCarryingValue",
      "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
    ],
    unitKeys: ["USD"],
  },
  {
    key: "operatingCashFlow",
    label: "operating cash flow",
    concepts: ["NetCashProvidedByUsedInOperatingActivities"],
    unitKeys: ["USD"],
  },
  {
    key: "capex",
    label: "capex",
    concepts: ["PaymentsToAcquirePropertyPlantAndEquipment"],
    unitKeys: ["USD"],
  },
  {
    key: "dilutedShares",
    label: "diluted shares",
    concepts: ["WeightedAverageNumberOfDilutedSharesOutstanding"],
    unitKeys: ["shares"],
  },
  {
    key: "currentAssets",
    label: "current assets",
    concepts: ["AssetsCurrent"],
    unitKeys: ["USD"],
  },
  {
    key: "currentLiabilities",
    label: "current liabilities",
    concepts: ["LiabilitiesCurrent"],
    unitKeys: ["USD"],
  },
  {
    key: "stockholdersEquity",
    label: "stockholders' equity",
    concepts: [
      "StockholdersEquity",
      "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
    ],
    unitKeys: ["USD"],
    optional: true,
  },
  {
    key: "assets",
    label: "total assets",
    concepts: ["Assets"],
    unitKeys: ["USD"],
    optional: true,
  },
  {
    key: "dividendsPaid",
    label: "dividends paid",
    // PaymentsForDividends is the cash-flow-statement outflow (negative in XBRL);
    // DividendsPaid is an alternative some issuers use. The lens handles sign via abs().
    concepts: ["PaymentsForDividends", "DividendsPaid"],
    unitKeys: ["USD"],
    optional: true,
  },
  {
    key: "shareRepurchases",
    label: "share repurchases",
    concepts: [
      "PaymentsForRepurchaseOfCommonStock",
      "PaymentsForRepurchaseOfEquity",
      "PaymentsForRepurchaseOfCommonStockAndPreferredStock",
    ],
    unitKeys: ["USD"],
    optional: true,
  },
];

const DEBT_METRIC: SecMetricDefinition = {
  key: "debt",
  label: "debt",
  concepts: ["LongTermDebt"],
  unitKeys: ["USD"],
};

const DEBT_COMPONENTS: readonly SecMetricDefinition[] = [
  {
    key: "currentDebt",
    label: "current debt",
    concepts: ["LongTermDebtCurrent", "ShortTermBorrowings", "ShortTermDebt"],
    unitKeys: ["USD"],
  },
  {
    key: "noncurrentDebt",
    label: "noncurrent debt",
    concepts: ["LongTermDebtNoncurrent"],
    unitKeys: ["USD"],
  },
];

const FLOW_METRIC_KEYS = new Set([
  "revenue",
  "grossProfit",
  "operatingIncome",
  "netIncome",
  "consolidatedNetIncome",
  "dilutedEps",
  "operatingCashFlow",
  "capex",
  "dilutedShares",
  "dividendsPaid",
  "shareRepurchases",
]);

export function secRequestInit(userAgent: string | undefined): RequestInit | undefined {
  return userAgent === undefined
    ? undefined
    : { headers: { accept: "application/json", "user-agent": userAgent } };
}

export function findSecTicker(
  payload: unknown,
  symbol: string,
): { cik: string; ticker: string; name?: string } | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const normalizedSymbol = symbol.toUpperCase();
  const entries = Object.values(payload).filter((value) => isRecord(value));
  const match = entries.find(
    (entry) => readString(entry, "ticker")?.toUpperCase() === normalizedSymbol,
  );
  if (match === undefined) {
    return undefined;
  }
  const ticker = readString(match, "ticker")?.trim().toUpperCase();
  const cikNumber = readNumber(match, "cik_str");
  if (ticker === undefined || cikNumber === undefined) {
    return undefined;
  }
  const name = readString(match, "title");
  return {
    cik: String(cikNumber).padStart(10, "0"),
    ticker,
    ...(name !== undefined ? { name } : {}),
  };
}

function summarizeSecFilings(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.filings) || !isRecord(payload.filings.recent)) {
    return undefined;
  }
  const forms = Array.isArray(payload.filings.recent.form) ? payload.filings.recent.form : [];
  const dates = Array.isArray(payload.filings.recent.filingDate)
    ? payload.filings.recent.filingDate
    : [];
  const filings = forms
    .map((form, index) =>
      typeof form === "string" && typeof dates[index] === "string" ? `${form} ${dates[index]}` : "",
    )
    .filter(
      (value) => value.startsWith("10-K ") || value.startsWith("10-Q ") || value.startsWith("8-K "),
    );
  return filings.length > 0 ? `Recent SEC filings: ${filings.slice(0, 5).join(", ")}.` : undefined;
}

// SIC arrives as a string in current SEC submissions payloads, but tolerate a
// Numeric encoding; provenance is always the submissions endpoint itself.
export function extractSecSic(payload: unknown): SecSicClassification | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const sicText = readString(payload, "sic")?.trim();
  const sicNumber = readNumber(payload, "sic");
  const sic = sicText !== undefined && sicText !== "" ? sicText : sicNumber?.toString();
  if (sic === undefined || !/^\d{3,4}$/u.test(sic)) {
    return undefined;
  }
  const sicDescription = readString(payload, "sicDescription")?.trim();
  return {
    sic: sic.padStart(4, "0"),
    ...(sicDescription !== undefined && sicDescription !== "" ? { sicDescription } : {}),
  };
}

function readFiscalYear(value: Record<string, unknown>): number | undefined {
  const year = readNumber(value, "fy");
  if (year !== undefined) {
    return year;
  }
  const text = readString(value, "fy");
  if (text === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function readSecFactValue(value: unknown): SecFactValue | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const val = readNumber(value, "val");
  const form = readString(value, "form");
  if (val === undefined || (form !== "10-Q" && form !== "10-K")) {
    return undefined;
  }
  const fp = readString(value, "fp");
  const fy = readFiscalYear(value);
  const filed = readString(value, "filed");
  const start = readString(value, "start");
  const end = readString(value, "end");
  return {
    val,
    form,
    ...(fp !== undefined ? { fp } : {}),
    ...(fy !== undefined ? { fy } : {}),
    ...(filed !== undefined ? { filed } : {}),
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined ? { end } : {}),
  };
}

// Reporting period length in months for a duration (flow) fact, rounded to the
// Nearest whole month: ~3 for a single quarter, ~12 for a full fiscal year.
// Undefined when the fact lacks a start/end span (e.g. balance-sheet instants).
export function periodMonths(fact: SecFactValue): number | undefined {
  if (fact.start === undefined || fact.end === undefined) {
    return undefined;
  }
  const startMs = Date.parse(fact.start);
  const endMs = Date.parse(fact.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return undefined;
  }
  const months = Math.round((endMs - startMs) / 86_400_000 / DAYS_PER_MONTH);
  return months > 0 ? months : undefined;
}

export function isFactObservableAsOf(fact: SecFactValue, analysisAsOf?: string): boolean {
  if (analysisAsOf === undefined) {
    return true;
  }
  const cutoff = analysisAsOf.slice(0, 10);
  return (
    (fact.end === undefined || fact.end <= cutoff) &&
    (fact.filed === undefined || fact.filed <= cutoff)
  );
}

// Returns true when the revenue period end is older than SEC_FRESHNESS_DAYS.
// The gap does not suppress the metric, so downstream consumers can still use it.
function isStalePeriodEnd(periodEnd: string, analysisAsOf: string): boolean {
  const periodMs = Date.parse(periodEnd);
  const cutoffMs = Date.parse(analysisAsOf);
  if (!Number.isFinite(periodMs) || !Number.isFinite(cutoffMs)) {
    return false;
  }
  return cutoffMs - periodMs > SEC_FRESHNESS_DAYS * DAY_MS;
}

function compareFactRecency(a: SecFactValue, b: SecFactValue): number {
  const periodEnd = (b.end ?? "").localeCompare(a.end ?? "");
  if (periodEnd !== 0) {
    return periodEnd;
  }
  const periodStart = (a.start ?? "").localeCompare(b.start ?? "");
  if (periodStart !== 0) {
    return periodStart;
  }
  return (b.filed ?? "").localeCompare(a.filed ?? "");
}

function latestFact(values: readonly SecFactValue[]): SecFactValue | undefined {
  return values.toSorted(compareFactRecency)[0];
}

function factValuesForConcept(
  gaap: Record<string, unknown>,
  concept: string,
  unitKeys: readonly string[],
): readonly SecFactValue[] {
  const fact = isRecord(gaap[concept]) ? gaap[concept] : undefined;
  const units = fact !== undefined && isRecord(fact.units) ? fact.units : undefined;
  if (units === undefined) {
    return [];
  }
  return unitKeys.flatMap((unitKey) =>
    readArray(units, unitKey).flatMap((value) => {
      const factValue = readSecFactValue(value);
      return factValue === undefined ? [] : [factValue];
    }),
  );
}

function factValuesForMetric(
  gaap: Record<string, unknown>,
  metric: SecMetricDefinition,
): readonly SecFactValue[] {
  for (const concept of metric.concepts) {
    const values = factValuesForConcept(gaap, concept, metric.unitKeys);
    if (values.length > 0) {
      return values;
    }
  }
  return [];
}

function isComparablePrior(latest: SecFactValue, candidate: SecFactValue): boolean {
  if (latest.fy === undefined || candidate.fy !== latest.fy - 1 || candidate.form !== latest.form) {
    return false;
  }
  return latest.form === "10-Q" ? candidate.fp === latest.fp : true;
}

function comparablePrior(
  latest: SecFactValue,
  values: readonly SecFactValue[],
): SecFactValue | undefined {
  return latestFact(values.filter((value) => isComparablePrior(latest, value)));
}

function selectMetric(
  gaap: Record<string, unknown>,
  metric: SecMetricDefinition,
  analysisAsOf?: string,
  flowPeriod?: SecFactValue,
): SecMetricSelection | undefined {
  const selections: SecMetricSelection[] = [];
  for (const concept of metric.concepts) {
    const observableValues = factValuesForConcept(gaap, concept, metric.unitKeys).filter((value) =>
      isFactObservableAsOf(value, analysisAsOf),
    );
    const values =
      flowPeriod === undefined
        ? observableValues
        : observableValues.filter(
            (value) => isCurrentFlowFact(flowPeriod, value) || isComparablePrior(flowPeriod, value),
          );
    const latest = latestFact(
      flowPeriod === undefined
        ? values
        : values.filter((value) => isCurrentFlowFact(flowPeriod, value)),
    );
    if (latest === undefined) {
      continue;
    }
    const prior = comparablePrior(latest, values);
    selections.push({ latest, ...(prior !== undefined ? { prior } : {}) });
  }
  return selections.toSorted((a, b) => {
    const recency = compareFactRecency(a.latest, b.latest);
    if (recency !== 0) {
      return recency;
    }
    return Number(b.prior !== undefined) - Number(a.prior !== undefined);
  })[0];
}

function sameFiscalPeriod(a: SecFactValue, b: SecFactValue): boolean {
  return a.form === b.form && a.fy === b.fy && (a.form === "10-K" || a.fp === b.fp);
}

function isCurrentFlowFact(anchor: SecFactValue, candidate: SecFactValue): boolean {
  return (
    sameFiscalPeriod(anchor, candidate) &&
    candidate.end === anchor.end &&
    (anchor.start === undefined || candidate.start === anchor.start)
  );
}

function sumMatchingFacts(
  period: SecFactValue,
  componentValues: readonly (readonly SecFactValue[])[],
): SecFactValue | undefined {
  const matches = componentValues
    .map((values) =>
      latestFact(
        values.filter((value) => sameFiscalPeriod(period, value) && value.end === period.end),
      ),
    )
    .filter((value): value is SecFactValue => value !== undefined);
  if (matches.length === 0) {
    return undefined;
  }
  return {
    ...period,
    val: matches.reduce((sum, value) => sum + value.val, 0),
  };
}

function selectDebtMetric(
  gaap: Record<string, unknown>,
  analysisAsOf?: string,
): SecMetricSelection | undefined {
  const direct = selectMetric(gaap, DEBT_METRIC, analysisAsOf);
  const componentValues = DEBT_COMPONENTS.map((metric) =>
    factValuesForMetric(gaap, metric).filter((value) => isFactObservableAsOf(value, analysisAsOf)),
  );
  const latest = latestFact(componentValues.flat());
  const summedLatest = latest === undefined ? undefined : sumMatchingFacts(latest, componentValues);
  const priorPeriod =
    latest === undefined ? undefined : comparablePrior(latest, componentValues.flat());
  const prior =
    priorPeriod === undefined ? undefined : sumMatchingFacts(priorPeriod, componentValues);
  const components =
    summedLatest === undefined
      ? undefined
      : { latest: summedLatest, ...(prior !== undefined ? { prior } : {}) };
  if (direct === undefined || components === undefined) {
    return direct ?? components;
  }
  return compareFactRecency(direct.latest, components.latest) < 0 ? direct : components;
}

function deltaPercent(latest: number, prior: number): number | undefined {
  return prior === 0 ? undefined : ((latest - prior) / Math.abs(prior)) * 100;
}

function formatMetric(
  label: string,
  latest: number,
  prior: number | undefined,
  delta: number | undefined,
): string {
  if (delta === undefined) {
    return `${label} ${String(latest)}`;
  }
  if (prior !== undefined && latest < 0 && prior < 0) {
    const direction = latest < prior ? "widened" : "narrowed";
    return `${label} ${String(latest)} (loss ${direction} ${Math.abs(delta).toFixed(1)}% YoY)`;
  }
  return `${label} ${String(latest)} (${delta.toFixed(1)}% YoY)`;
}

export function summarizeSecFundamentals(
  payload: unknown,
  analysisAsOf?: string,
): SecFundamentalsSummary | undefined {
  if (!isRecord(payload) || !isRecord(payload.facts) || !isRecord(payload.facts["us-gaap"])) {
    return undefined;
  }
  const gaap = payload.facts["us-gaap"];
  const metrics: Record<string, number | string> = {};
  const missingFacts: string[] = [];
  const missingDeltas: string[] = [];
  const summaryParts: string[] = [];

  const [revenueDefinition] = SEC_METRIC_DEFINITIONS;
  const revenueSelection =
    revenueDefinition === undefined
      ? undefined
      : selectMetric(gaap, revenueDefinition, analysisAsOf);
  const flowPeriod = revenueSelection?.latest;
  const metricSelections = [
    ...SEC_METRIC_DEFINITIONS.map((definition) => ({
      definition,
      selection:
        definition.key === "revenue"
          ? revenueSelection
          : selectMetric(
              gaap,
              definition,
              analysisAsOf,
              FLOW_METRIC_KEYS.has(definition.key) ? flowPeriod : undefined,
            ),
    })),
    { definition: DEBT_METRIC, selection: selectDebtMetric(gaap, analysisAsOf) },
  ];

  for (const { definition, selection } of metricSelections) {
    if (selection === undefined) {
      if (!definition.optional) {
        missingFacts.push(definition.key);
      }
      continue;
    }
    const { latest, prior } = selection;
    metrics[definition.key] = latest.val;
    if (latest.end !== undefined) {
      metrics[`${definition.key}PeriodEnd`] = latest.end;
    }
    // Expose each flow fact's own reporting-period length so downstream ratios
    // (ROE/ROA/PCF) annualize by the metric's own period, not revenue's. Instant
    // Facts (no start/end span) yield undefined and emit no key. Revenue keeps its
    // Dedicated revenuePeriodEnd sidecar for the valuation module.
    const months = periodMonths(latest);
    if (months !== undefined) {
      metrics[`${definition.key}PeriodMonths`] = months;
    }
    if (definition.key === "revenue" && latest.end !== undefined) {
      metrics.revenuePeriodEnd = latest.end;
    }
    const delta = prior === undefined ? undefined : deltaPercent(latest.val, prior.val);
    if (prior === undefined) {
      if (!definition.optional) {
        missingDeltas.push(definition.key);
      }
    } else {
      metrics[`${definition.key}Prior`] = prior.val;
      if (delta !== undefined) {
        metrics[`${definition.key}DeltaPercent`] = delta;
      }
    }
    if (definition.key !== "consolidatedNetIncome" || metrics.netIncome !== latest.val) {
      summaryParts.push(formatMetric(definition.label, latest.val, prior?.val, delta));
    }
  }

  if (summaryParts.length === 0) {
    return undefined;
  }

  const staleRevenueGap =
    typeof metrics.revenuePeriodEnd === "string" &&
    analysisAsOf !== undefined &&
    isStalePeriodEnd(metrics.revenuePeriodEnd, analysisAsOf)
      ? [
          sourceGap({
            source: "sec-edgar",
            message: `Stale SEC revenue period: period end ${metrics.revenuePeriodEnd} exceeds ${SEC_FRESHNESS_DAYS} days`,
            provider: "sec-edgar",
            capability: "extended-evidence",
            cause: "provider-data-missing",
            evidenceQualityImpact: "extended-evidence-cap",
          }),
        ]
      : [];

  const gaps: SourceGap[] = [
    ...(missingFacts.length > 0
      ? [
          sourceGap({
            source: "sec-edgar",
            message: `Missing SEC company facts: ${missingFacts.join(", ")}`,
            provider: "sec-edgar",
            capability: "extended-evidence",
            cause: "provider-data-missing",
            evidenceQualityImpact: "extended-evidence-cap",
          }),
        ]
      : []),
    ...(missingDeltas.length > 0
      ? [
          sourceGap({
            source: "sec-edgar",
            message: `Missing comparable SEC company facts for YoY deltas: ${missingDeltas.join(
              ", ",
            )}`,
            provider: "sec-edgar",
            capability: "extended-evidence",
            cause: "provider-data-missing",
            evidenceQualityImpact: "extended-evidence-cap",
          }),
        ]
      : []),
    ...staleRevenueGap,
  ];

  return {
    summary: `SEC Fundamental Evidence: ${summaryParts.join(", ")}.`,
    metrics,
    ...(typeof metrics.revenuePeriodEnd === "string"
      ? { revenuePeriodEnd: metrics.revenuePeriodEnd }
      : {}),
    gaps,
  };
}

export async function fetchSecCompanyFactsForSymbol(
  ctx: CollectContext,
  symbol: string,
): Promise<SecCompanyFactsResult> {
  const secInit = secRequestInit(ctx.secUserAgent);
  const tickersUrl = "https://www.sec.gov/files/company_tickers.json";
  const tickers = await ctx.request.json({
    url: tickersUrl,
    adapter: "sec-tickers",
    init: secInit,
  });
  if (!isFetchJsonResult(tickers)) {
    return { symbol: symbol.toUpperCase(), rawSnapshots: [], gaps: [tickers] };
  }
  const match = findSecTicker(tickers.payload, symbol);
  if (match === undefined) {
    return {
      symbol: symbol.toUpperCase(),
      rawSnapshots: [tickers.rawSnapshot],
      gaps: [
        sourceGap({
          source: "sec-edgar",
          message: `No SEC CIK match for ${symbol}`,
          provider: "sec-edgar",
          capability: "extended-evidence",
          cause: "unsupported-coverage",
          evidenceQualityImpact: "extended-evidence-cap",
        }),
      ],
    };
  }

  const factsUrl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${match.cik}.json`;
  const identity: InstrumentIdentity = {
    ...(match.name !== undefined ? { displayName: match.name } : {}),
    providerIds: [{ provider: "sec-edgar", idKind: "cik", value: match.cik }],
    aliases: [{ provider: "sec-edgar", idKind: "ticker", value: match.ticker }],
  };
  const facts = await ctx.request.json({
    url: factsUrl,
    adapter: "sec-companyfacts",
    init: secInit,
  });
  const submissionsUrl = `https://data.sec.gov/submissions/CIK${match.cik}.json`;
  const submissions = await ctx.request.json({
    url: submissionsUrl,
    adapter: "sec-submissions",
    init: secInit,
  });
  const sicClassification = isFetchJsonResult(submissions)
    ? extractSecSic(submissions.payload)
    : undefined;
  const filingsSummary = isFetchJsonResult(submissions)
    ? summarizeSecFilings(submissions.payload)
    : undefined;
  const submissionsFields = {
    submissionsUrl,
    ...(sicClassification !== undefined ? { sicClassification } : {}),
    ...(filingsSummary !== undefined ? { filingsSummary } : {}),
    ...(isFetchJsonResult(submissions)
      ? {
          submissionsPayload: submissions.payload,
          submissionsSourceId: `extended-sec-edgar-${symbol.toLowerCase()}-filings`,
          submissionsFetchedAt: submissions.rawSnapshot.fetchedAt,
        }
      : {}),
  };
  const submissionsGaps = isFetchJsonResult(submissions) ? [] : [submissions];

  const rawSnapshots = [
    tickers.rawSnapshot,
    ...(isFetchJsonResult(facts) ? [facts.rawSnapshot] : []),
    ...(isFetchJsonResult(submissions) ? [submissions.rawSnapshot] : []),
  ];
  if (!isFetchJsonResult(facts)) {
    return {
      symbol: match.ticker,
      cik: match.cik,
      identity,
      sourceUrl: factsUrl,
      ...submissionsFields,
      rawSnapshots,
      gaps: [facts, ...submissionsGaps],
    };
  }

  const fundamentals = summarizeSecFundamentals(facts.payload, ctx.fetchedAt);
  const emptyFactsGap =
    fundamentals === undefined
      ? [
          sourceGap({
            source: "sec-edgar",
            message: `No SEC company facts found for ${symbol}`,
            provider: "sec-edgar",
            capability: "extended-evidence",
            cause: "provider-data-missing",
            evidenceQualityImpact: "extended-evidence-cap",
          }),
        ]
      : [];

  return {
    symbol: match.ticker,
    cik: match.cik,
    identity,
    sourceId: `extended-sec-edgar-${symbol.toLowerCase()}-fundamentals`,
    sourceUrl: factsUrl,
    fetchedAt: facts.rawSnapshot.fetchedAt,
    factsPayload: facts.payload,
    ...(fundamentals !== undefined
      ? {
          metrics: fundamentals.metrics,
          summary: fundamentals.summary,
          ...(fundamentals.revenuePeriodEnd !== undefined
            ? { revenuePeriodEnd: fundamentals.revenuePeriodEnd }
            : {}),
        }
      : {}),
    ...submissionsFields,
    rawSnapshots,
    gaps: [...(fundamentals?.gaps ?? []), ...emptyFactsGap, ...submissionsGaps],
  };
}

export async function collectSec(ctx: CollectContext): Promise<ProviderResult> {
  const { command } = ctx;
  if (!isInstrumentCommand(command)) {
    return { rawSnapshots: [], items: [], gaps: [] };
  }
  // Attribute target SEC gaps (e.g. "Missing SEC company facts", "Stale SEC
  // Revenue period", non-US unsupported coverage) to the target symbol so they
  // Never collide with a peer's like-messaged gap under a null symbol during
  // Dedupe/consolidation. Every gap on these paths is owned by the target, so
  // Overwrite unconditionally — a stale or upstream-supplied symbol must not
  // Survive re-attribution. Applied on every return path in collectSec.
  const tagTargetGaps = (gaps: readonly SourceGap[]): readonly SourceGap[] =>
    gaps.map((gap) => ({ ...gap, symbol: command.symbol.toUpperCase() }));

  if (!isUsListing(command.symbol, ctx.instrumentIdentity)) {
    return {
      rawSnapshots: [],
      items: [],
      gaps: tagTargetGaps([
        sourceGap({
          source: "sec-edgar",
          message: `SEC EDGAR does not support ${command.symbol} (non-US listing)`,
          provider: "sec-edgar",
          capability: "extended-evidence",
          cause: "unsupported-coverage",
          evidenceQualityImpact: "extended-evidence-cap",
        }),
      ]),
    };
  }

  const factsResult = await fetchSecCompanyFactsForSymbol(ctx, command.symbol);
  const gaps = tagTargetGaps(factsResult.gaps);
  if (factsResult.cik === undefined || factsResult.identity === undefined) {
    return { rawSnapshots: factsResult.rawSnapshots, items: [], gaps };
  }

  const { rawSnapshots, filingsSummary } = factsResult;
  const items: CollectedItem[] = [];

  // The submissions endpoint supplies the SIC classification as well as the
  // Filings summary, so its source must be attached whenever either datum is
  // Used — a company with no recent filings still needs SIC provenance.
  const filingsSource =
    (filingsSummary !== undefined || factsResult.sicClassification !== undefined) &&
    factsResult.submissionsSourceId !== undefined &&
    factsResult.submissionsFetchedAt !== undefined
      ? evidenceSource(
          factsResult.submissionsSourceId,
          `${command.symbol} SEC filings`,
          "sec-edgar",
          command,
          factsResult.submissionsFetchedAt,
          factsResult.submissionsUrl,
          factsResult.identity,
        )
      : undefined;

  const fundamentalsSource =
    factsResult.sourceId !== undefined &&
    factsResult.summary !== undefined &&
    factsResult.fetchedAt !== undefined
      ? evidenceSource(
          factsResult.sourceId,
          `${command.symbol} SEC fundamentals`,
          "sec-edgar",
          command,
          factsResult.fetchedAt,
          factsResult.sourceUrl,
          factsResult.identity,
        )
      : undefined;
  const sources = [filingsSource, fundamentalsSource].filter(
    (source): source is Source => source !== undefined,
  );
  const summaries = [filingsSummary, factsResult.summary].filter(
    (summary): summary is string => summary !== undefined,
  );
  if (sources.length > 0 && summaries.length > 0) {
    const primarySource = fundamentalsSource ?? filingsSource;
    if (primarySource !== undefined) {
      const metrics =
        factsResult.metrics !== undefined
          ? {
              ...factsResult.metrics,
              ...(factsResult.sicClassification !== undefined
                ? {
                    sic: factsResult.sicClassification.sic,
                    ...(factsResult.sicClassification.sicDescription !== undefined
                      ? { sicDescription: factsResult.sicClassification.sicDescription }
                      : {}),
                  }
                : {}),
            }
          : undefined;
      items.push({
        source: primarySource,
        sources,
        item: {
          category: "sec-edgar",
          title: `${command.symbol} SEC Fundamental Evidence`,
          summary: summaries.join(" "),
          sourceIds: sources.map((source) => source.id),
          observedAt: primarySource.fetchedAt,
          ...(metrics !== undefined ? { metrics } : {}),
          identity: factsResult.identity,
        },
      });
    }
  }

  return {
    rawSnapshots,
    items,
    gaps,
  };
}
