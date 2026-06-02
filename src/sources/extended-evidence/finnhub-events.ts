import type { SourceGap } from "../../domain/types";
import { sourceGap, sourceGapStatusCode } from "../../domain/source-gaps";
import { isFetchJsonResult, latestRawSnapshotFetchedAt, type CollectContext } from "../types";
import { collectedItem, evidenceSource, type ProviderResult } from "./common";
import { daysFrom, encodeQuery, readArray } from "./utils";

const EVENT_ROUTE_NAMES: Readonly<Record<string, string>> = {
  "finnhub-events-1": "earnings calendar",
  "finnhub-events-2": "dividend",
  "finnhub-events-3": "split",
};

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

function summarizeFinnhubEvents(payloads: readonly unknown[]): string | undefined {
  const counts = payloads.map((payload) =>
    Array.isArray(payload) ? payload.length : readArray(payload, "earningsCalendar").length,
  );
  const total = counts.reduce((sum, count) => sum + count, 0);
  return total > 0
    ? `Finnhub returned ${String(total)} recent or upcoming earnings, dividend, and split records.`
    : undefined;
}

export async function collectFinnhubEvents(ctx: CollectContext): Promise<ProviderResult> {
  const { command, fetchedAt } = ctx;
  if (command.jobType !== "ticker") {
    return { rawSnapshots: [], items: [], gaps: [] };
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
  const from = daysFrom(fetchedAt, -90);
  const to = daysFrom(fetchedAt, 90);
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
  const summary = summarizeFinnhubEvents(fetched.map((result) => result.payload));
  const items =
    summary === undefined
      ? []
      : [
          collectedItem(
            "equity-events",
            `${command.symbol} equity events`,
            summary,
            evidenceSource(
              `extended-finnhub-events-${command.symbol.toLowerCase()}`,
              `${command.symbol} equity events`,
              "finnhub",
              command,
              latestRawSnapshotFetchedAt(
                fetched.map((result) => result.rawSnapshot),
                fetchedAt,
              ),
            ),
          ),
        ];
  return { rawSnapshots: fetched.map((result) => result.rawSnapshot), items, gaps };
}
