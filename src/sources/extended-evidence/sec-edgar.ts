import type { InstrumentIdentity, Source, SourceGap } from "../../domain/types";
import { sourceGap } from "../../domain/source-gaps";
import { isRecord, readNumber, readString } from "../guards";
import { isFetchJsonResult, type CollectContext } from "../types";
import { evidenceSource, type CollectedItem, type ProviderResult } from "./common";
import { readArray } from "./utils";

type SecForm = "10-K" | "10-Q";

interface SecFactValue {
  readonly val: number;
  readonly form: SecForm;
  readonly fp?: string;
  readonly fy?: number;
  readonly filed?: string;
  readonly end?: string;
}

interface SecMetricDefinition {
  readonly key: string;
  readonly label: string;
  readonly concepts: readonly string[];
  readonly unitKeys: readonly string[];
}

interface SecMetricSelection {
  readonly latest: SecFactValue;
  readonly prior?: SecFactValue;
}

interface SecFundamentalsSummary {
  readonly summary: string;
  readonly metrics: Record<string, number>;
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
  const end = readString(value, "end");
  return {
    val,
    form,
    ...(fp !== undefined ? { fp } : {}),
    ...(fy !== undefined ? { fy } : {}),
    ...(filed !== undefined ? { filed } : {}),
    ...(end !== undefined ? { end } : {}),
  };
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
  const metrics: Record<string, number> = {};
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
      missingFacts.push(definition.key);
      continue;
    }
    const { latest, prior } = selection;
    metrics[definition.key] = latest.val;
    const delta = prior === undefined ? undefined : deltaPercent(latest.val, prior.val);
    if (prior === undefined) {
      missingDeltas.push(definition.key);
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
    gaps,
  };
}

export async function collectSec(ctx: CollectContext): Promise<ProviderResult> {
  const { command } = ctx;
  if (command.jobType !== "ticker") {
    return { rawSnapshots: [], items: [], gaps: [] };
  }

  const secInit = secRequestInit(ctx.secUserAgent);
  const tickersUrl = "https://www.sec.gov/files/company_tickers.json";
  const tickers = await ctx.request.json({
    url: tickersUrl,
    adapter: "sec-tickers",
    init: secInit,
  });
  if (!isFetchJsonResult(tickers)) {
    return { rawSnapshots: [], items: [], gaps: [tickers] };
  }
  const match = findSecTicker(tickers.payload, command.symbol);
  if (match === undefined) {
    return {
      rawSnapshots: [tickers.rawSnapshot],
      items: [],
      gaps: [
        sourceGap({
          source: "sec-edgar",
          message: `No SEC CIK match for ${command.symbol}`,
          provider: "sec-edgar",
          capability: "extended-evidence",
          cause: "unsupported-coverage",
          evidenceQualityImpact: "extended-evidence-cap",
        }),
      ],
    };
  }

  const submissionsUrl = `https://data.sec.gov/submissions/CIK${match.cik}.json`;
  const factsUrl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${match.cik}.json`;
  const identity: InstrumentIdentity = {
    ...(match.name !== undefined ? { displayName: match.name } : {}),
    providerIds: [{ provider: "sec-edgar", idKind: "cik", value: match.cik }],
    aliases: [{ provider: "sec-edgar", idKind: "ticker", value: match.ticker }],
  };
  const [submissions, facts] = await Promise.all([
    ctx.request.json({
      url: submissionsUrl,
      adapter: "sec-submissions",
      init: secInit,
    }),
    ctx.request.json({
      url: factsUrl,
      adapter: "sec-companyfacts",
      init: secInit,
    }),
  ]);

  const rawSnapshots = [
    tickers.rawSnapshot,
    ...(isFetchJsonResult(submissions) ? [submissions.rawSnapshot] : []),
    ...(isFetchJsonResult(facts) ? [facts.rawSnapshot] : []),
  ];
  const fetchGaps = [submissions, facts].filter(
    (value): value is SourceGap => !isFetchJsonResult(value),
  );
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
          identity,
        )
      : undefined;

  const fundamentals = isFetchJsonResult(facts)
    ? summarizeSecFundamentals(facts.payload)
    : undefined;
  const fundamentalsSource =
    isFetchJsonResult(facts) && fundamentals !== undefined
      ? evidenceSource(
          `extended-sec-edgar-${command.symbol.toLowerCase()}-fundamentals`,
          `${command.symbol} SEC fundamentals`,
          "sec-edgar",
          command,
          facts.rawSnapshot.fetchedAt,
          factsUrl,
          identity,
        )
      : undefined;
  const sources = [filingsSource, fundamentalsSource].filter(
    (source): source is Source => source !== undefined,
  );
  const summaries = [filingsSummary, fundamentals?.summary].filter(
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
          ...(fundamentals !== undefined ? { metrics: fundamentals.metrics } : {}),
          identity,
        },
      });
    }
  }

  const emptyFactsGap =
    isFetchJsonResult(facts) && fundamentals === undefined
      ? [
          sourceGap({
            source: "sec-edgar",
            message: `No SEC company facts found for ${command.symbol}`,
            provider: "sec-edgar",
            capability: "extended-evidence",
            cause: "provider-data-missing",
            evidenceQualityImpact: "extended-evidence-cap",
          }),
        ]
      : [];

  return {
    rawSnapshots,
    items,
    gaps: [...fetchGaps, ...(fundamentals?.gaps ?? []), ...emptyFactsGap],
  };
}
