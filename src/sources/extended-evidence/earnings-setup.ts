import type { SourceGap } from "../../domain/types";
import { sourceGap } from "../../domain/source-gaps";
import { isRecord, readNumber, readString } from "../guards";
import { tradierRequestInit } from "../tradier";
import { isFetchJsonResult, type CollectContext } from "../types";
import { encodeQuery, readArray } from "./utils";

// ---------------------------------------------------------------------------
// Finnhub earnings-calendar event parsing
// ---------------------------------------------------------------------------

export type EarningsEventTiming = "bmo" | "amc" | "unknown";

export interface EarningsEvent {
  readonly symbol: string;
  readonly date: string;
  readonly timing: EarningsEventTiming;
  readonly epsEstimate?: number;
  readonly revenueEstimate?: number;
  readonly sourceIds: readonly string[];
  readonly fetchedAt: string;
}

const NEAR_EVENT_WINDOW_DAYS = 30;

function parseFinnhubTiming(hour: unknown): EarningsEventTiming {
  if (hour === "bmo") {
    return "bmo";
  }
  if (hour === "amc") {
    return "amc";
  }
  return "unknown";
}

function isDateString(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value);
}

function calendarDaysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

export function parseNearEarningsEvent(
  earningsPayload: unknown,
  symbol: string,
  fetchedAt: string,
  sourceId: string,
): EarningsEvent | undefined {
  const records = readArray(earningsPayload, "earningsCalendar");
  const today = fetchedAt.slice(0, 10);

  let nearest: EarningsEvent | undefined = undefined;
  let nearestDays = NEAR_EVENT_WINDOW_DAYS + 1;

  for (const record of records) {
    if (!isRecord(record)) {
      continue;
    }
    const recordSymbol = readString(record, "symbol");
    if (recordSymbol !== symbol) {
      continue;
    }
    const date = readString(record, "date");
    if (!isDateString(date)) {
      continue;
    }
    const daysUntil = calendarDaysBetween(today, date);
    if (daysUntil < 0 || daysUntil > NEAR_EVENT_WINDOW_DAYS) {
      continue;
    }
    if (daysUntil < nearestDays) {
      nearestDays = daysUntil;
      const epsEstimate = readNumber(record, "epsEstimate");
      const revenueEstimate = readNumber(record, "revenueEstimate");
      nearest = {
        symbol,
        date,
        timing: parseFinnhubTiming(record.hour),
        ...(epsEstimate !== undefined ? { epsEstimate } : {}),
        ...(revenueEstimate !== undefined ? { revenueEstimate } : {}),
        sourceIds: [sourceId],
        fetchedAt,
      };
    }
  }

  return nearest;
}

// ---------------------------------------------------------------------------
// ATM straddle implied move from Tradier
// ---------------------------------------------------------------------------

export interface ImpliedMove {
  readonly expiration: string;
  readonly strike: number;
  readonly spot: number;
  readonly straddleMidpoint: number;
  readonly impliedMovePct: number;
  readonly sourceIds: readonly string[];
  readonly observedAt: string;
}

interface OptionQuote {
  readonly strike: number;
  readonly optionType: "call" | "put";
  readonly bid: number;
  readonly ask: number;
}

function parseOptionQuotes(payload: unknown): readonly OptionQuote[] {
  const options =
    isRecord(payload) && isRecord(payload.options) ? readArray(payload.options, "option") : [];

  return options.flatMap((option) => {
    if (!isRecord(option)) {
      return [];
    }
    const strike = readNumber(option, "strike");
    const bid = readNumber(option, "bid");
    const ask = readNumber(option, "ask");
    const optionType = readString(option, "option_type");
    if (
      strike === undefined ||
      bid === undefined ||
      ask === undefined ||
      (optionType !== "call" && optionType !== "put")
    ) {
      return [];
    }
    return [{ strike, optionType, bid, ask }];
  });
}

function selectNearestExpiration(
  expirations: readonly string[],
  eventDate: string,
  maxDaysAfter: number,
): string | undefined {
  const target = new Date(`${eventDate}T00:00:00Z`);
  const maxDate = new Date(target.getTime() + maxDaysAfter * 86_400_000);

  return expirations.find((exp) => {
    const expDate = new Date(`${exp}T00:00:00Z`);
    return expDate >= target && expDate <= maxDate;
  });
}

function readTradierExpirations(payload: unknown): readonly string[] {
  const expirations = isRecord(payload) ? payload.expirations : undefined;
  return readArray(expirations, "date")
    .filter((date): date is string => typeof date === "string")
    .toSorted();
}

const MAX_EXPIRATION_DAYS_AFTER_EVENT = 7;

export async function computeImpliedMove(
  ctx: CollectContext,
  event: EarningsEvent,
  spot: number,
): Promise<{ readonly impliedMove?: ImpliedMove; readonly gaps: readonly SourceGap[] }> {
  if (ctx.tradierApiToken === undefined) {
    return {
      gaps: [
        sourceGap({
          source: "earnings-setup-implied-move",
          message: "MARKET_BOT_TRADIER_API_TOKEN is not set; implied move unavailable",
          provider: "tradier",
          capability: "extended-evidence",
          cause: "missing-credential",
          evidenceQualityImpact: "extended-evidence-cap",
        }),
      ],
    };
  }

  const init = tradierRequestInit(ctx.tradierApiToken);
  const expirationsUrl = `https://api.tradier.com/v1/markets/options/expirations?${encodeQuery({
    symbol: event.symbol,
    includeAllRoots: "true",
  })}`;
  const expirationsResult = await ctx.request.json({
    url: expirationsUrl,
    adapter: "tradier-earnings-expirations",
    init,
  });
  if (!isFetchJsonResult(expirationsResult)) {
    return { gaps: [expirationsResult] };
  }

  const expirations = readTradierExpirations(expirationsResult.payload);
  const expiration = selectNearestExpiration(
    expirations,
    event.date,
    MAX_EXPIRATION_DAYS_AFTER_EVENT,
  );
  if (expiration === undefined) {
    return {
      gaps: [
        sourceGap({
          source: "earnings-setup-implied-move",
          message: `No Tradier expiration found within ${String(MAX_EXPIRATION_DAYS_AFTER_EVENT)} days after earnings event ${event.date}`,
          provider: "tradier",
          capability: "extended-evidence",
          cause: "provider-data-missing",
          evidenceQualityImpact: "extended-evidence-cap",
        }),
      ],
    };
  }

  const chainUrl = `https://api.tradier.com/v1/markets/options/chains?${encodeQuery({
    symbol: event.symbol,
    expiration,
    greeks: "true",
  })}`;
  const chainResult = await ctx.request.json({
    url: chainUrl,
    adapter: "tradier-earnings-chain",
    init,
  });
  if (!isFetchJsonResult(chainResult)) {
    return { gaps: [chainResult] };
  }

  const quotes = parseOptionQuotes(chainResult.payload);
  if (quotes.length === 0) {
    return {
      gaps: [
        sourceGap({
          source: "earnings-setup-implied-move",
          message: "No valid option quotes in Tradier chain for implied move computation",
          provider: "tradier",
          capability: "extended-evidence",
          cause: "provider-data-missing",
          evidenceQualityImpact: "extended-evidence-cap",
        }),
      ],
    };
  }

  // Find the ATM strike (nearest to spot).
  const strikes = [...new Set(quotes.map((q) => q.strike))].toSorted((a, b) => a - b);
  const atmStrike = strikes.reduce((best, strike) =>
    Math.abs(strike - spot) < Math.abs(best - spot) ? strike : best,
  );

  const atmCall = quotes.find((q) => q.strike === atmStrike && q.optionType === "call");
  const atmPut = quotes.find((q) => q.strike === atmStrike && q.optionType === "put");
  if (atmCall === undefined || atmPut === undefined) {
    return {
      gaps: [
        sourceGap({
          source: "earnings-setup-implied-move",
          message: `Missing ATM call/put pair at strike ${String(atmStrike)} for implied move`,
          provider: "tradier",
          capability: "extended-evidence",
          cause: "provider-data-missing",
          evidenceQualityImpact: "extended-evidence-cap",
        }),
      ],
    };
  }

  const callMid = (atmCall.bid + atmCall.ask) / 2;
  const putMid = (atmPut.bid + atmPut.ask) / 2;
  const straddleMidpoint = callMid + putMid;

  if (spot === 0) {
    return {
      gaps: [
        sourceGap({
          source: "earnings-setup-implied-move",
          message: "Spot price is zero; cannot compute implied move percentage",
          provider: "tradier",
          capability: "extended-evidence",
          cause: "validation-failed",
          evidenceQualityImpact: "extended-evidence-cap",
        }),
      ],
    };
  }

  const impliedMovePct = straddleMidpoint / spot;
  const sourceId = `extended-tradier-earnings-implied-move-${event.symbol.toLowerCase()}`;

  return {
    impliedMove: {
      expiration,
      strike: atmStrike,
      spot,
      straddleMidpoint,
      impliedMovePct,
      sourceIds: [sourceId],
      observedAt: chainResult.rawSnapshot.fetchedAt,
    },
    gaps: [],
  };
}
