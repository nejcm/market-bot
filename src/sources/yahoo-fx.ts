import { DAY_MS } from "../config/shared";
import type { SourceGap } from "../domain/types";
import { sourceGap } from "../domain/source-gaps";
import type { FetchLike } from "./types";
import { fetchYahooCloseWindow, type YahooCloseWindowResult } from "./yahoo";

// Ponytail: seven days covers normal FX market closures; widen if observed gaps exceed it.
const FX_LOOKBACK_CALENDAR_DAYS = 7;
const CURRENCY_CODE = /^[A-Z]{3}$/u;

export interface YahooFxClose {
  readonly baseCurrency: string;
  readonly quoteCurrency: string;
  readonly pair: string;
  readonly date: string;
  /** Quote-currency units per one base-currency unit; multiply a base amount by this rate. */
  readonly quoteCurrencyPerBaseCurrency: number;
  readonly sourceId: string;
}

export interface YahooFxCloseResult {
  readonly closesByRequestedDate: Readonly<Record<string, YahooFxClose>>;
  readonly sourceGaps: readonly SourceGap[];
}

function parseDate(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return undefined;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
    ? date
    : undefined;
}

function unavailableFxClose(
  message: string,
  cause: NonNullable<SourceGap["cause"]>,
  source = "market-yahoo-fx",
): SourceGap {
  return sourceGap({
    source,
    message,
    provider: "yahoo",
    capability: "market-data",
    cause,
    evidenceQualityImpact: "no-cap",
  });
}

function fxAbsenceSummary(fetched: YahooCloseWindowResult): string {
  if (fetched.ok) {
    return "Yahoo FX close unavailable";
  }
  return fetched.cause === "fetch-failed"
    ? "Yahoo FX close fetch failed"
    : "Yahoo FX close response malformed";
}

export async function fetchYahooFxClosesOnOrBefore(
  baseCurrency: string,
  quoteCurrency: string,
  onOrBeforeDates: readonly string[],
  fetchImpl: FetchLike = fetch,
): Promise<YahooFxCloseResult> {
  const requests = [...new Set(onOrBeforeDates)].map((requestedDate) => ({
    requestedDate,
    date: parseDate(requestedDate),
  }));
  if (requests.length === 0) {
    return { closesByRequestedDate: {}, sourceGaps: [] };
  }
  if (!CURRENCY_CODE.test(baseCurrency) || !CURRENCY_CODE.test(quoteCurrency)) {
    return {
      closesByRequestedDate: {},
      sourceGaps: [
        unavailableFxClose(
          `Yahoo FX pair requires uppercase three-letter currencies, got ${baseCurrency}/${quoteCurrency}`,
          "validation-failed",
        ),
      ],
    };
  }
  const validRequests = requests.flatMap(({ requestedDate, date }) =>
    date === undefined ? [] : [{ requestedDate, date }],
  );
  const validationGaps = requests.flatMap(({ requestedDate, date }) =>
    date === undefined
      ? [
          unavailableFxClose(
            `Yahoo FX close requires a YYYY-MM-DD date, got ${requestedDate}`,
            "validation-failed",
          ),
        ]
      : [],
  );
  if (validRequests.length === 0) {
    return { closesByRequestedDate: {}, sourceGaps: validationGaps };
  }

  const pair = `${baseCurrency}${quoteCurrency}=X`;
  const sourceId = `market-yahoo-fx-${baseCurrency.toLowerCase()}${quoteCurrency.toLowerCase()}`;
  const times = validRequests.map(({ date }) => date.getTime());
  const from = new Date(Math.min(...times) - FX_LOOKBACK_CALENDAR_DAYS * DAY_MS);
  const to = new Date(Math.max(...times));
  // NOTE — ponytail: One uncached fetch serves a whole table. Retry and backoff are present via
  // The direct Yahoo resilience helper, but collector-level circuit-breaking and rate limiting are
  // Not: this path never goes through the collector request seam that provides them. Routing it
  // Through that seam, plus a close cache, is the upgrade — do it once many foreign-issuer runs
  // Are in flight, or Yahoo rate-limits this pair.
  const fetched = await fetchYahooCloseWindow(pair, from, to, fetchImpl);
  const observations = (fetched.ok ? fetched.observations : [])
    .filter((observation) => Number.isFinite(observation.value) && observation.value > 0)
    .toSorted((left, right) => left.date.localeCompare(right.date));
  const resolutions = validRequests.map(({ requestedDate }) => ({
    requestedDate,
    close: observations.findLast((observation) => observation.date <= requestedDate),
  }));
  const closesByRequestedDate = Object.fromEntries(
    resolutions.flatMap(({ requestedDate, close }) =>
      close === undefined
        ? []
        : [
            [
              requestedDate,
              {
                baseCurrency,
                quoteCurrency,
                pair,
                date: close.date,
                quoteCurrencyPerBaseCurrency: close.value,
                sourceId,
              },
            ] as const,
          ],
    ),
  );
  const missingGaps = resolutions.flatMap(({ requestedDate, close }) =>
    close === undefined
      ? [
          unavailableFxClose(
            `${fxAbsenceSummary(fetched)} for ${pair} on or before ${requestedDate}`,
            fetched.ok ? "provider-data-missing" : fetched.cause,
            sourceId,
          ),
        ]
      : [],
  );

  return {
    closesByRequestedDate,
    sourceGaps: [...validationGaps, ...missingGaps],
  };
}
