import type { InstrumentCommand } from "../cli/args";
import { DAY_MS } from "../config/shared";
import type { ExtendedEvidenceItem, Source, SourceGap } from "../domain/types";
import { sourceGap } from "../domain/source-gaps";
import { isRecord, readNumber } from "../guards";
import { isUsListing } from "./instrument-capability";
import {
  parseNearEarningsEvent,
  type EarningsEvent,
  type ImpliedMove,
} from "./extended-evidence/earnings-setup";
import { collectedItem, evidenceSource, type ProviderResult } from "./extended-evidence/common";
import { daysFrom, encodeQuery, readArray } from "./extended-evidence/utils";
import { selectTradierExpiration, summarizeTradierIv, tradierRequestInit } from "./tradier";
import {
  isFetchJsonResult,
  latestRawSnapshotFetchedAt,
  type CollectContext,
  type FetchJsonResult,
  type RawSourceSnapshot,
} from "./types";
import type { EvidenceRequestToolOutput } from "./evidence-request-tools";

const TRADIER_TARGET_DTES = [7, 30, 60, 90] as const;
const MAX_EXPIRATION_DAYS_AFTER_EVENT = 7;

export interface TradierChainPacket {
  readonly expiration: string;
  readonly result: FetchJsonResult | SourceGap;
}

export interface TradierPacket {
  readonly symbol: string;
  readonly status: "available" | "failed" | "unconfigured" | "unsupported";
  readonly expirations?: FetchJsonResult;
  readonly chains: readonly TradierChainPacket[];
  readonly eventExpiration?: string;
  readonly thirtyDayExpiration?: string;
  readonly termExpirations: readonly {
    readonly targetDte: number;
    readonly expiration: string;
    readonly dte: number;
  }[];
  readonly providerResult: ProviderResult;
  readonly termStructure: EvidenceRequestToolOutput;
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly gaps: readonly SourceGap[];
}

const EMPTY_TOOL_OUTPUT: EvidenceRequestToolOutput = {
  rawSnapshots: [],
  sources: [],
  items: [],
  gaps: [],
};

export async function collectTradierPacket(
  ctx: CollectContext,
  command: InstrumentCommand,
  event?: EarningsEvent,
  includeTermStructure = false,
): Promise<TradierPacket> {
  const unavailable = tradierUnavailableGap(ctx, command);
  if (unavailable !== undefined) {
    return emptyPacket(
      command.symbol,
      unavailable.cause === "unsupported-coverage" ? "unsupported" : "unconfigured",
      unavailable,
    );
  }
  const init = tradierRequestInit(ctx.tradierApiToken as string);
  const expirationsUrl = `https://api.tradier.com/v1/markets/options/expirations?${encodeQuery({
    symbol: command.symbol,
    includeAllRoots: "true",
  })}`;
  const expirations = await ctx.request.json({
    url: expirationsUrl,
    adapter: "tradier-expirations",
    init,
  });
  if (!isFetchJsonResult(expirations)) {
    return {
      ...emptyPacket(command.symbol, "failed", expirations),
      gaps: [expirations],
    };
  }

  const expirationDates = readTradierExpirations(expirations.payload);
  const thirtyDayExpiration = selectTradierExpiration(
    expirations.payload,
    daysFrom(expirations.rawSnapshot.fetchedAt, 30),
  );
  const termExpirations = includeTermStructure
    ? nearestExpirationBuckets(expirationDates, expirations.rawSnapshot.fetchedAt)
    : [];
  const eventExpiration =
    event === undefined
      ? undefined
      : selectNearestEventExpiration(expirationDates, event.date, event.timing);
  const requestedExpirations = [
    ...new Set([
      ...(thirtyDayExpiration === undefined ? [] : [thirtyDayExpiration]),
      ...termExpirations.map((bucket) => bucket.expiration),
      ...(eventExpiration === undefined ? [] : [eventExpiration]),
    ]),
  ].toSorted();
  const chains = await Promise.all(
    requestedExpirations.map(
      async (expiration): Promise<TradierChainPacket> => ({
        expiration,
        result: await ctx.request.json({
          url: tradierChainUrl(command.symbol, expiration),
          adapter: "tradier-options",
          init,
        }),
      }),
    ),
  );
  const packetBase = {
    symbol: command.symbol.toUpperCase(),
    status: "available" as const,
    expirations,
    chains,
    ...(eventExpiration !== undefined ? { eventExpiration } : {}),
    ...(thirtyDayExpiration !== undefined ? { thirtyDayExpiration } : {}),
    termExpirations,
  };
  const providerResult = tradierThirtyDayProviderResult(ctx, packetBase);
  const termStructure = includeTermStructure
    ? tradierTermStructureOutput(ctx, packetBase, expirationsUrl)
    : EMPTY_TOOL_OUTPUT;
  const rawSnapshots = [
    expirations.rawSnapshot,
    ...chains.flatMap((chain) =>
      isFetchJsonResult(chain.result) ? [chain.result.rawSnapshot] : [],
    ),
  ];
  return {
    ...packetBase,
    providerResult,
    termStructure,
    rawSnapshots,
    gaps: [
      ...providerResult.gaps,
      ...termStructure.gaps.filter((gap) => !providerResult.gaps.includes(gap)),
    ],
  };
}

function emptyPacket(
  symbol: string,
  status: TradierPacket["status"],
  gap: SourceGap,
): TradierPacket {
  return {
    symbol: symbol.toUpperCase(),
    status,
    chains: [],
    termExpirations: [],
    providerResult: { rawSnapshots: [], items: [], gaps: [gap] },
    termStructure: EMPTY_TOOL_OUTPUT,
    rawSnapshots: [],
    gaps: [gap],
  };
}

function tradierUnavailableGap(
  ctx: CollectContext,
  command: InstrumentCommand,
): SourceGap | undefined {
  if (!isUsListing(command.symbol, ctx.instrumentIdentity)) {
    return sourceGap({
      source: "tradier-options",
      message: `Tradier options do not support ${command.symbol} (non-US listing)`,
      provider: "tradier",
      capability: "extended-evidence",
      cause: "unsupported-coverage",
      evidenceQualityImpact: "extended-evidence-cap",
    });
  }
  return ctx.tradierApiToken === undefined
    ? sourceGap({
        source: "tradier-options",
        message: "MARKET_BOT_TRADIER_API_TOKEN is not set",
        provider: "tradier",
        capability: "extended-evidence",
        cause: "missing-credential",
        evidenceQualityImpact: "extended-evidence-cap",
      })
    : undefined;
}

function tradierThirtyDayProviderResult(
  ctx: CollectContext,
  packet: Pick<TradierPacket, "expirations" | "chains" | "symbol" | "thirtyDayExpiration">,
): ProviderResult {
  const { command } = ctx;
  if (packet.expirations === undefined) {
    return { rawSnapshots: [], items: [], gaps: [] };
  }
  if (packet.thirtyDayExpiration === undefined) {
    return {
      rawSnapshots: [packet.expirations.rawSnapshot],
      items: [],
      gaps: [
        sourceGap({
          source: "tradier-options",
          message: "No Tradier option expiration found",
          provider: "tradier",
          capability: "extended-evidence",
          cause: "provider-data-missing",
          evidenceQualityImpact: "extended-evidence-cap",
        }),
      ],
    };
  }
  const chain = packet.chains.find(
    (candidate) => candidate.expiration === packet.thirtyDayExpiration,
  );
  if (chain === undefined) {
    return {
      rawSnapshots: [packet.expirations.rawSnapshot],
      items: [],
      gaps: [],
    };
  }
  if (!isFetchJsonResult(chain.result)) {
    return {
      rawSnapshots: [packet.expirations.rawSnapshot],
      items: [],
      gaps: [chain.result],
    };
  }
  const summary = summarizeTradierIv(chain.result.payload);
  const items =
    summary === undefined
      ? []
      : [
          collectedItem(
            "options-iv",
            `${packet.symbol} options IV`,
            summary.summary,
            evidenceSource(
              `extended-tradier-iv-${packet.symbol.toLowerCase()}`,
              `${packet.symbol} options IV`,
              "tradier",
              command,
              chain.result.rawSnapshot.fetchedAt,
              tradierChainUrl(packet.symbol, packet.thirtyDayExpiration),
            ),
            summary.metrics,
          ),
        ];
  return {
    rawSnapshots: [packet.expirations.rawSnapshot, chain.result.rawSnapshot],
    items,
    gaps: [],
  };
}

export function deriveTradierImpliedMove(
  packet: TradierPacket,
  event: EarningsEvent,
  spot: number,
): { readonly impliedMove?: ImpliedMove; readonly gaps: readonly SourceGap[] } {
  if (packet.status === "unconfigured") {
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
  const expiration = packet.eventExpiration;
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
  const chain = packet.chains.find((candidate) => candidate.expiration === expiration);
  if (chain === undefined) {
    return { gaps: [] };
  }
  if (!isFetchJsonResult(chain.result)) {
    return { gaps: [chain.result] };
  }
  return impliedMoveFromPayload(chain.result, event, spot, expiration);
}

function impliedMoveFromPayload(
  chain: FetchJsonResult,
  event: EarningsEvent,
  spot: number,
  expiration: string,
): { readonly impliedMove?: ImpliedMove; readonly gaps: readonly SourceGap[] } {
  const quotes = parseOptionQuotes(chain.payload);
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
  const strikes = [...new Set(quotes.map((quote) => quote.strike))].toSorted((a, b) => a - b);
  const [firstStrike] = strikes;
  if (firstStrike === undefined) {
    return { gaps: [] };
  }
  const atmStrike = strikes.reduce((best, strike) =>
    Math.abs(strike - spot) < Math.abs(best - spot) ? strike : best,
  );
  const call = quotes.find((quote) => quote.strike === atmStrike && quote.optionType === "call");
  const put = quotes.find((quote) => quote.strike === atmStrike && quote.optionType === "put");
  if (call === undefined || put === undefined) {
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
  const straddleMidpoint = (call.bid + call.ask + put.bid + put.ask) / 2;
  return {
    impliedMove: {
      expiration,
      strike: atmStrike,
      spot,
      straddleMidpoint,
      impliedMovePct: straddleMidpoint / spot,
      sourceIds: [`extended-tradier-earnings-implied-move-${event.symbol.toLowerCase()}`],
      observedAt: chain.rawSnapshot.fetchedAt,
    },
    gaps: [],
  };
}

function tradierTermStructureOutput(
  ctx: CollectContext,
  packet: Pick<TradierPacket, "chains" | "expirations" | "symbol" | "termExpirations">,
  expirationsUrl: string,
): EvidenceRequestToolOutput {
  if (packet.expirations === undefined) {
    return EMPTY_TOOL_OUTPUT;
  }
  const bucketIvs = packet.termExpirations.flatMap((bucket) => {
    const chain = packet.chains.find((candidate) => candidate.expiration === bucket.expiration);
    if (chain === undefined || !isFetchJsonResult(chain.result)) {
      return [];
    }
    const medianIv = median(readTradierIvValues(chain.result.payload));
    return medianIv === undefined ? [] : [{ ...bucket, medianIv }];
  });
  const gaps = packet.termExpirations.flatMap((bucket) => {
    const chain = packet.chains.find((candidate) => candidate.expiration === bucket.expiration);
    if (chain === undefined) {
      return [];
    }
    if (!isFetchJsonResult(chain.result)) {
      return [chain.result];
    }
    return median(readTradierIvValues(chain.result.payload)) === undefined
      ? [
          sourceGap({
            source: "tradier-options",
            message: `No Tradier IV values found for expiration ${bucket.expiration}`,
            provider: "tradier",
            capability: "evidence-request",
            cause: "provider-data-missing",
            evidenceQualityImpact: "extended-evidence-cap",
          }),
        ]
      : [];
  });
  const rawSnapshots = [
    packet.expirations.rawSnapshot,
    ...packet.chains.flatMap((chain) =>
      isFetchJsonResult(chain.result) ? [chain.result.rawSnapshot] : [],
    ),
  ];
  if (bucketIvs.length === 0) {
    return { rawSnapshots, sources: [], items: [], gaps };
  }
  const metrics: Record<string, number | string> = {};
  for (const bucket of bucketIvs) {
    metrics[`medianIv${String(bucket.targetDte)}Dte`] = bucket.medianIv;
    metrics[`expiration${String(bucket.targetDte)}Dte`] = bucket.expiration;
    metrics[`actualDte${String(bucket.targetDte)}Dte`] = bucket.dte;
  }
  const byTarget = new Map(bucketIvs.map((bucket) => [bucket.targetDte, bucket.medianIv]));
  const iv7 = byTarget.get(7);
  const iv30 = byTarget.get(30);
  const iv60 = byTarget.get(60);
  const iv90 = byTarget.get(90);
  if (iv7 !== undefined && iv30 !== undefined) {
    metrics.iv30Minus7 = iv30 - iv7;
  }
  if (iv30 !== undefined && iv60 !== undefined) {
    metrics.iv60Minus30 = iv60 - iv30;
  }
  if (iv30 !== undefined && iv90 !== undefined) {
    metrics.iv90Minus30 = iv90 - iv30;
  }
  const summary = [
    "Tradier IV term structure:",
    bucketIvs
      .map(
        (bucket) =>
          `${String(bucket.targetDte)}D ${bucket.medianIv.toFixed(3)} (${bucket.expiration})`,
      )
      .join(", "),
    iv7 !== undefined && iv30 !== undefined ? `30D-7D slope ${(iv30 - iv7).toFixed(3)}.` : "",
    iv30 !== undefined && iv90 !== undefined ? `90D-30D slope ${(iv90 - iv30).toFixed(3)}.` : "",
  ]
    .filter((part) => part !== "")
    .join(" ");
  const fetchedAt = latestRawSnapshotFetchedAt(
    packet.chains.flatMap((chain) =>
      isFetchJsonResult(chain.result) ? [chain.result.rawSnapshot] : [],
    ),
    packet.expirations.rawSnapshot.fetchedAt,
  );
  const rawRef = rawSnapshots.at(-1)?.id;
  const source: Source = {
    id: `extended-tradier-iv-term-${packet.symbol.toLowerCase()}`,
    title: `${packet.symbol} IV term structure`,
    url: expirationsUrl,
    fetchedAt,
    kind: "extended-evidence",
    assetClass: "equity",
    symbol: packet.symbol,
    provider: "tradier",
    ...(rawRef !== undefined ? { rawRef } : {}),
    summary,
  };
  const item: ExtendedEvidenceItem = {
    category: "options-iv",
    title: `${packet.symbol} IV term structure`,
    summary,
    sourceIds: [source.id],
    observedAt: fetchedAt,
    metrics,
  };
  return { rawSnapshots, sources: [source], items: [item], gaps };
}

function readTradierExpirations(payload: unknown): readonly string[] {
  const expirations = isRecord(payload) ? payload.expirations : undefined;
  return readArray(expirations, "date")
    .filter((date): date is string => typeof date === "string")
    .toSorted();
}

function nearestExpirationBuckets(
  expirations: readonly string[],
  fetchedAt: string,
): TradierPacket["termExpirations"] {
  const used = new Set<string>();
  return TRADIER_TARGET_DTES.flatMap((targetDte) => {
    const candidates = expirations
      .map((expiration) => {
        const diff =
          new Date(`${expiration}T00:00:00.000Z`).getTime() - new Date(fetchedAt).getTime();
        const dte = Number.isFinite(diff) ? Math.max(0, Math.round(diff / DAY_MS)) : undefined;
        return dte === undefined ? undefined : { expiration, dte };
      })
      .filter(
        (candidate): candidate is { expiration: string; dte: number } => candidate !== undefined,
      )
      .filter((candidate) => !used.has(candidate.expiration))
      .toSorted((left, right) => Math.abs(left.dte - targetDte) - Math.abs(right.dte - targetDte));
    const [selected] = candidates;
    if (selected === undefined) {
      return [];
    }
    used.add(selected.expiration);
    return [{ targetDte, ...selected }];
  });
}

function selectNearestEventExpiration(
  expirations: readonly string[],
  eventDate: string,
  timing: EarningsEvent["timing"],
): string | undefined {
  const target = new Date(`${eventDate}T00:00:00Z`);
  const maxDate = new Date(target.getTime() + MAX_EXPIRATION_DAYS_AFTER_EVENT * DAY_MS);
  return expirations.find((expiration) => {
    const date = new Date(`${expiration}T00:00:00Z`);
    return (timing === "bmo" ? date >= target : date > target) && date <= maxDate;
  });
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
    const optionType = option.option_type;
    return strike !== undefined &&
      bid !== undefined &&
      ask !== undefined &&
      (optionType === "call" || optionType === "put")
      ? [{ strike, bid, ask, optionType }]
      : [];
  });
}

function readTradierIvValues(payload: unknown): readonly number[] {
  const options =
    isRecord(payload) && isRecord(payload.options) ? readArray(payload.options, "option") : [];
  return options
    .flatMap((option) => {
      if (!isRecord(option) || !isRecord(option.greeks)) {
        return [];
      }
      const value = readNumber(option.greeks, "mid_iv") ?? readNumber(option.greeks, "iv");
      return value === undefined ? [] : [value];
    })
    .toSorted((left, right) => left - right);
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0
    ? ((values[middle - 1] as number) + (values[middle] as number)) / 2
    : values[middle];
}

function tradierChainUrl(symbol: string, expiration: string): string {
  return `https://api.tradier.com/v1/markets/options/chains?${encodeQuery({
    symbol,
    expiration,
    greeks: "true",
  })}`;
}

export function earningsEventFromExtendedSnapshots(
  symbol: string,
  rawSnapshots: readonly RawSourceSnapshot[],
): EarningsEvent | undefined {
  const snapshot = rawSnapshots.find((candidate) => candidate.adapter === "finnhub-events-1");
  return snapshot === undefined
    ? undefined
    : parseNearEarningsEvent(
        snapshot.payload,
        symbol,
        snapshot.fetchedAt,
        `extended-finnhub-events-${symbol.toLowerCase()}`,
      );
}
