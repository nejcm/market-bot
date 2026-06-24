import type { InstrumentIdentity, Source, SourceGap } from "../../domain/types";
import { isInstrumentCommand } from "../../cli/args";
import { sourceGap } from "../../domain/source-gaps";
import { isRecord, readNumber, readString } from "../guards";
import { isFetchJsonResult, type CollectContext, type RawSourceSnapshot } from "../types";
import { isUsListing } from "../instrument-capability";
import { evidenceSource, type CollectedItem, type ProviderResult } from "./common";
import { readArray } from "./utils";

type SecForm = "10-K" | "10-Q";

interface SecFactValue {
  readonly val: number;
  readonly form: SecForm;
  readonly fp?: string;
  readonly fy?: number;
  readonly filed?: string;
  readonly start?: string;
  readonly end?: string;
}

const DAYS_PER_MONTH = 30.4368;

interface SecMetricDefinition {
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

export interface SecCompanyFactsResult {
  readonly symbol: string;
  readonly cik?: string;
  readonly identity?: InstrumentIdentity;
  readonly sourceId?: string;
  readonly sourceUrl?: string;
  readonly fetchedAt?: string;
  readonly metrics?: Record<string, number | string>;
  readonly summary?: string;
  readonly revenuePeriodEnd?: string;
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly gaps: readonly SourceGap[];
}

const SEC_METRIC_DEFINITIONS: readonly SecMetricDefinition[] = [
  {
    key: "revenue",
    label: "revenue",
    concepts: [
      "Revenues",
      "SalesRevenueNet",
      "RevenueFromContractWithCustomerExcludingAssessedTax",
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
    label: "net income",
    concepts: ["NetIncomeLoss"],
    unitKeys: ["USD"],
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

function readSecFactValue(value: unknown): SecFactValue | undefined {
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
function periodMonths(fact: SecFactValue): number | undefined {
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

function compareFacts(a: SecFactValue, b: SecFactValue): number {
  const filed = (a.filed ?? "").localeCompare(b.filed ?? "");
  return filed !== 0 ? filed : (a.end ?? "").localeCompare(b.end ?? "");
}

function latestFact(values: readonly SecFactValue[]): SecFactValue | undefined {
  return values.toSorted((a, b) => compareFacts(b, a))[0];
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
): SecMetricSelection | undefined {
  let fallback: SecMetricSelection | undefined = undefined;
  for (const concept of metric.concepts) {
    const values = factValuesForConcept(gaap, concept, metric.unitKeys);
    const latest = latestFact(values);
    if (latest === undefined) {
      continue;
    }
    const prior = comparablePrior(latest, values);
    const selection = { latest, ...(prior !== undefined ? { prior } : {}) };
    if (prior !== undefined) {
      return selection;
    }
    fallback ??= selection;
  }
  return fallback;
}

function sameFiscalPeriod(a: SecFactValue, b: SecFactValue): boolean {
  return a.form === b.form && a.fy === b.fy && (a.form === "10-K" || a.fp === b.fp);
}

function sumMatchingFacts(
  period: SecFactValue,
  componentValues: readonly (readonly SecFactValue[])[],
): SecFactValue | undefined {
  const matches = componentValues
    .map((values) => latestFact(values.filter((value) => sameFiscalPeriod(period, value))))
    .filter((value): value is SecFactValue => value !== undefined);
  if (matches.length === 0) {
    return undefined;
  }
  return {
    ...period,
    val: matches.reduce((sum, value) => sum + value.val, 0),
  };
}

function selectDebtMetric(gaap: Record<string, unknown>): SecMetricSelection | undefined {
  const direct = selectMetric(gaap, DEBT_METRIC);
  if (direct !== undefined) {
    return direct;
  }
  const componentValues = DEBT_COMPONENTS.map((metric) => factValuesForMetric(gaap, metric));
  const latest = latestFact(componentValues.flat());
  if (latest === undefined) {
    return undefined;
  }
  const summedLatest = sumMatchingFacts(latest, componentValues);
  if (summedLatest === undefined) {
    return undefined;
  }
  const priorPeriod = comparablePrior(latest, componentValues.flat());
  const prior =
    priorPeriod === undefined ? undefined : sumMatchingFacts(priorPeriod, componentValues);
  return { latest: summedLatest, ...(prior !== undefined ? { prior } : {}) };
}

function deltaPercent(latest: number, prior: number): number | undefined {
  return prior === 0 ? undefined : ((latest - prior) / Math.abs(prior)) * 100;
}

function formatMetric(label: string, latest: number, delta: number | undefined): string {
  return delta === undefined
    ? `${label} ${String(latest)}`
    : `${label} ${String(latest)} (${delta.toFixed(1)}% YoY)`;
}

export function summarizeSecFundamentals(payload: unknown): SecFundamentalsSummary | undefined {
  if (!isRecord(payload) || !isRecord(payload.facts) || !isRecord(payload.facts["us-gaap"])) {
    return undefined;
  }
  const gaap = payload.facts["us-gaap"];
  const metrics: Record<string, number | string> = {};
  const missingFacts: string[] = [];
  const missingDeltas: string[] = [];
  const summaryParts: string[] = [];

  const metricSelections = [
    ...SEC_METRIC_DEFINITIONS.map((definition) => ({
      definition,
      selection: selectMetric(gaap, definition),
    })),
    { definition: DEBT_METRIC, selection: selectDebtMetric(gaap) },
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
    summaryParts.push(formatMetric(definition.label, latest.val, delta));
  }

  if (summaryParts.length === 0) {
    return undefined;
  }

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

  const rawSnapshots = [
    tickers.rawSnapshot,
    ...(isFetchJsonResult(facts) ? [facts.rawSnapshot] : []),
  ];
  if (!isFetchJsonResult(facts)) {
    return {
      symbol: match.ticker,
      cik: match.cik,
      identity,
      sourceUrl: factsUrl,
      rawSnapshots,
      gaps: [facts],
    };
  }

  const fundamentals = summarizeSecFundamentals(facts.payload);
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
    ...(fundamentals !== undefined
      ? {
          metrics: fundamentals.metrics,
          summary: fundamentals.summary,
          ...(fundamentals.revenuePeriodEnd !== undefined
            ? { revenuePeriodEnd: fundamentals.revenuePeriodEnd }
            : {}),
        }
      : {}),
    rawSnapshots,
    gaps: [...(fundamentals?.gaps ?? []), ...emptyFactsGap],
  };
}

export async function collectSec(ctx: CollectContext): Promise<ProviderResult> {
  const { command } = ctx;
  if (!isInstrumentCommand(command)) {
    return { rawSnapshots: [], items: [], gaps: [] };
  }
  if (!isUsListing(command.symbol, ctx.instrumentIdentity)) {
    return {
      rawSnapshots: [],
      items: [],
      gaps: [
        sourceGap({
          source: "sec-edgar",
          message: `SEC EDGAR does not support ${command.symbol} (non-US listing)`,
          provider: "sec-edgar",
          capability: "extended-evidence",
          cause: "unsupported-coverage",
          evidenceQualityImpact: "extended-evidence-cap",
        }),
      ],
    };
  }

  const factsResult = await fetchSecCompanyFactsForSymbol(ctx, command.symbol);
  if (factsResult.cik === undefined || factsResult.identity === undefined) {
    return { rawSnapshots: factsResult.rawSnapshots, items: [], gaps: factsResult.gaps };
  }

  const secInit = secRequestInit(ctx.secUserAgent);
  const submissionsUrl = `https://data.sec.gov/submissions/CIK${factsResult.cik}.json`;
  const submissions = await ctx.request.json({
    url: submissionsUrl,
    adapter: "sec-submissions",
    init: secInit,
  });
  const rawSnapshots = [
    ...factsResult.rawSnapshots,
    ...(isFetchJsonResult(submissions) ? [submissions.rawSnapshot] : []),
  ];
  const fetchGaps = isFetchJsonResult(submissions) ? [] : [submissions];
  const items: CollectedItem[] = [];

  const filingsSummary = isFetchJsonResult(submissions)
    ? summarizeSecFilings(submissions.payload)
    : undefined;
  const filingsSource =
    isFetchJsonResult(submissions) && filingsSummary !== undefined
      ? evidenceSource(
          `extended-sec-edgar-${command.symbol.toLowerCase()}-filings`,
          `${command.symbol} SEC filings`,
          "sec-edgar",
          command,
          submissions.rawSnapshot.fetchedAt,
          submissionsUrl,
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
      items.push({
        source: primarySource,
        sources,
        item: {
          category: "sec-edgar",
          title: `${command.symbol} SEC Fundamental Evidence`,
          summary: summaries.join(" "),
          sourceIds: sources.map((source) => source.id),
          observedAt: primarySource.fetchedAt,
          ...(factsResult.metrics !== undefined ? { metrics: factsResult.metrics } : {}),
          identity: factsResult.identity,
        },
      });
    }
  }

  return {
    rawSnapshots,
    items,
    gaps: [...fetchGaps, ...factsResult.gaps],
  };
}
