import type { SourceGap } from "../../domain/sources";
import { isInstrumentCommand } from "../../cli/args";
import { sourceGap, sourceGapStatusCode } from "../../domain/source-gaps";
import { isFetchJsonResult, latestRawSnapshotFetchedAt, type CollectContext } from "../types";
import { isUsListing } from "../instrument-capability";
import { collectedItem, evidenceSource, type ProviderResult } from "./common";
import { parseNearEarningsEvent, type EarningsEvent } from "./earnings-setup";
import { daysFrom, encodeQuery, readArray } from "./utils";

const CALENDAR_WINDOW_DAYS = 90;

const EVENT_ROUTE_NAMES: Readonly<Record<string, string>> = {
  "finnhub-events-1": "earnings calendar",
  "finnhub-events-2": "dividend",
  "finnhub-events-3": "split",
};

interface FinnhubEventRouteResult {
  readonly adapter: string;
  readonly payload: unknown;
}

function isForbiddenGap(gap: SourceGap): boolean {
  return sourceGapStatusCode(gap.message) === "403";
}

function normalizeEventGap(gap: SourceGap): SourceGap {
  if (!isForbiddenGap(gap)) {
    return gap;
  }

  return sourceGap({
    source: gap.source,
    message: `Finnhub ${EVENT_ROUTE_NAMES[gap.source] ?? "event"} endpoint is unavailable for the configured token (status 403)`,
    provider: "finnhub",
    capability: "extended-evidence",
    cause: "unsupported-coverage",
    evidenceQualityImpact: "extended-evidence-cap",
  });
}

function eventRecordCount(payload: unknown): number {
  return Array.isArray(payload) ? payload.length : readArray(payload, "earningsCalendar").length;
}

function eventSummaryPart(result: FinnhubEventRouteResult): string | undefined {
  const count = eventRecordCount(result.payload);
  if (count === 0) {
    return;
  }
  const routeName = EVENT_ROUTE_NAMES[result.adapter] ?? "event";
  return `${String(count)} ${routeName} ${count === 1 ? "record" : "records"}`;
}

function joinSummaryParts(parts: readonly string[]): string {
  if (parts.length === 1) {
    return parts[0] as string;
  }
  if (parts.length === 2) {
    return `${parts[0] as string} and ${parts[1] as string}`;
  }
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1) as string}`;
}

function nextEarningsSentence(event: EarningsEvent): string {
  const estimates = [
    ...(event.epsEstimate !== undefined ? [`EPS ${String(event.epsEstimate)}`] : []),
    ...(event.revenueEstimate !== undefined ? [`revenue ${String(event.revenueEstimate)}`] : []),
  ];
  return ` Next earnings date ${event.date} (provider-estimated, not confirmed by the issuer; timing ${event.timing})${estimates.length > 0 ? `; provider consensus estimates: ${estimates.join(", ")}` : ""}.`;
}

function nextEarningsMetrics(event: EarningsEvent): Record<string, number | string> {
  return {
    nextEarningsDate: event.date,
    nextEarningsTiming: event.timing,
    ...(event.epsEstimate !== undefined ? { epsEstimate: event.epsEstimate } : {}),
    ...(event.revenueEstimate !== undefined ? { revenueEstimate: event.revenueEstimate } : {}),
  };
}

function summarizeFinnhubEvents(
  results: readonly FinnhubEventRouteResult[],
  next: EarningsEvent | undefined,
): string | undefined {
  const parts = results
    .map((result) => eventSummaryPart(result))
    .filter((part): part is string => part !== undefined);
  return parts.length > 0
    ? `Finnhub returned ${joinSummaryParts(parts)}.${next === undefined ? "" : nextEarningsSentence(next)}`
    : undefined;
}

export async function collectFinnhubEvents(ctx: CollectContext): Promise<ProviderResult> {
  const { command, fetchedAt } = ctx;
  if (!isInstrumentCommand(command)) {
    return { rawSnapshots: [], items: [], gaps: [] };
  }
  if (!isUsListing(command.symbol, ctx.instrumentIdentity)) {
    return {
      rawSnapshots: [],
      items: [],
      gaps: [
        sourceGap({
          source: "finnhub-events",
          message: `Finnhub event endpoints do not support ${command.symbol} (non-US listing)`,
          provider: "finnhub",
          capability: "extended-evidence",
          cause: "unsupported-coverage",
          evidenceQualityImpact: "extended-evidence-cap",
        }),
      ],
    };
  }
  if (ctx.finnhubApiToken === undefined) {
    return {
      rawSnapshots: [],
      items: [],
      gaps: [
        sourceGap({
          source: "finnhub-events",
          message: "MARKET_BOT_FINNHUB_API_TOKEN is not set",
          provider: "finnhub",
          capability: "extended-evidence",
          cause: "missing-credential",
          evidenceQualityImpact: "extended-evidence-cap",
        }),
      ],
    };
  }
  const from = daysFrom(fetchedAt, -CALENDAR_WINDOW_DAYS);
  const to = daysFrom(fetchedAt, CALENDAR_WINDOW_DAYS);
  const urls = [
    `https://finnhub.io/api/v1/calendar/earnings?${encodeQuery({ symbol: command.symbol, from, to, token: ctx.finnhubApiToken })}`,
    `https://finnhub.io/api/v1/stock/dividend?${encodeQuery({ symbol: command.symbol, from, to, token: ctx.finnhubApiToken })}`,
    `https://finnhub.io/api/v1/stock/split?${encodeQuery({ symbol: command.symbol, from, to, token: ctx.finnhubApiToken })}`,
  ];
  const results = await Promise.all(
    urls.map((url, index) =>
      ctx.request.json({
        url,
        adapter: `finnhub-events-${String(index + 1)}`,
      }),
    ),
  );
  const fetched = results.filter((result) => isFetchJsonResult(result));
  const gaps = results
    .filter((value): value is SourceGap => !isFetchJsonResult(value))
    .map((gap) => normalizeEventGap(gap));
  const sourceId = `extended-finnhub-events-${command.symbol.toLowerCase()}`;
  const calendar = fetched.find((result) => result.rawSnapshot.adapter === "finnhub-events-1");
  const next =
    calendar === undefined
      ? undefined
      : parseNearEarningsEvent(
          calendar.payload,
          command.symbol,
          calendar.rawSnapshot.fetchedAt,
          sourceId,
          CALENDAR_WINDOW_DAYS,
        );
  const summary = summarizeFinnhubEvents(
    fetched.map((result) => ({
      adapter: result.rawSnapshot.adapter,
      payload: result.payload,
    })),
    next,
  );
  const items =
    summary === undefined
      ? []
      : [
          collectedItem(
            "equity-events",
            `${command.symbol} equity events`,
            summary,
            evidenceSource(
              sourceId,
              `${command.symbol} equity events`,
              "finnhub",
              command,
              latestRawSnapshotFetchedAt(
                fetched.map((result) => result.rawSnapshot),
                fetchedAt,
              ),
            ),
            next === undefined ? undefined : nextEarningsMetrics(next),
          ),
        ];
  return { rawSnapshots: fetched.map((result) => result.rawSnapshot), items, gaps };
}
