import type { AssetClass, InstrumentIdentity, ResearchReport } from "../domain/types";
import type { Observation, PointObservationRequest } from "../forecast/observable";
import { fetchCoinGeckoCloseWindow } from "../sources/coingecko";
import { fetchFredObservation } from "../sources/fred";
import { fetchTradierIvObservation } from "../sources/tradier";
import { fetchYahooCloseWindow } from "../sources/yahoo";
import {
  fetchCloseWithCache,
  fetchWindowWithCache,
  type FetchCloseFn,
  type FetchWindowFn,
} from "./close-cache";

export type { FetchCloseFn, FetchWindowFn, Observation };

export interface ObservationRepository {
  point(
    request: PointObservationRequest,
    assetClass: AssetClass,
    date: Date,
  ): Promise<Observation | undefined>;
  window(
    subject: string,
    assetClass: AssetClass,
    from: Date,
    to: Date,
  ): Promise<readonly Observation[]>;
}

export interface ObservationRepositoryOptions {
  readonly report: ResearchReport;
  readonly cacheDir?: string;
  readonly fetchClose?: FetchCloseFn;
  readonly fetchWindow?: FetchWindowFn;
  readonly fredApiKey?: string;
  readonly tradierApiToken?: string;
  readonly now?: Date;
}

const CRYPTO_ID_FALLBACKS: Readonly<Record<string, string>> = {
  BTC: "bitcoin",
  ETH: "ethereum",
};

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function coinGeckoIdFromIdentity(identity: InstrumentIdentity | undefined): string | undefined {
  return identity?.providerIds?.find((id) => id.provider === "coingecko" && id.idKind === "coin-id")
    ?.value;
}

function identityForSubject(
  report: ResearchReport,
  subject: string,
): InstrumentIdentity | undefined {
  return report.sources.find(
    (source) => source.assetClass === "crypto" && source.symbol === subject,
  )?.identity;
}

function coinGeckoId(report: ResearchReport, subject: string): string | undefined {
  return (
    coinGeckoIdFromIdentity(identityForSubject(report, subject)) ??
    CRYPTO_ID_FALLBACKS[subject.toUpperCase()]
  );
}

async function pointValue(
  request: PointObservationRequest,
  assetClass: AssetClass,
  date: Date,
  options: Pick<ObservationRepositoryOptions, "fredApiKey" | "tradierApiToken" | "now">,
): Promise<number | undefined> {
  switch (request.kind) {
    case "fred": {
      return fetchFredObservation(request.subject, date, options.fredApiKey);
    }
    case "iv": {
      if (assetClass !== "equity") {
        return;
      }
      const now = options.now ?? new Date();
      return fetchTradierIvObservation(request.subject, date, options.tradierApiToken, fetch, now);
    }
  }

  const exhaustive: never = request;
  return exhaustive;
}

function routeWindowFetch(report: ResearchReport): FetchWindowFn {
  return async (subject, assetClass, from, to) => {
    if (assetClass === "equity") {
      return fetchYahooCloseWindow(subject, from, to);
    }

    const id = coinGeckoId(report, subject);
    return id === undefined ? [] : fetchCoinGeckoCloseWindow(subject, id, from, to);
  };
}

export function createObservationRepository(
  options: ObservationRepositoryOptions,
): ObservationRepository {
  const fetchWindow = options.fetchWindow ?? routeWindowFetch(options.report);
  const now = options.now ?? new Date();

  return {
    async point(request, assetClass, date) {
      const fetchPoint =
        options.fetchClose ??
        ((_subject: string, pointAssetClass: AssetClass, pointDate: Date) =>
          pointValue(request, pointAssetClass, pointDate, options));
      const value = await fetchCloseWithCache(
        request.observationSubject,
        assetClass,
        date,
        options.cacheDir,
        fetchPoint,
        now,
      );
      return value === undefined
        ? undefined
        : { subject: request.observationSubject, date: ymd(date), value };
    },

    async window(subject, assetClass, from, to) {
      return fetchWindowWithCache(
        subject,
        assetClass,
        from,
        to,
        options.cacheDir,
        fetchWindow,
        now,
      );
    },
  };
}
