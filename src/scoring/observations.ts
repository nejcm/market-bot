import type { AssetClass, InstrumentIdentity, ResearchReport } from "../domain/types";
import type { Observation } from "../forecast/observable";
import { fetchCoinGeckoClose, fetchCoinGeckoCloseWindow } from "../sources/coingecko";
import { fetchFredObservation } from "../sources/fred";
import { fetchTradierIvObservation } from "../sources/tradier";
import { fetchYahooClose, fetchYahooCloseWindow } from "../sources/yahoo";
import { fetchCloseWithCache, type FetchCloseFn } from "./close-cache";

export type { FetchCloseFn, Observation };

export interface ObservationRepository {
  point(subject: string, assetClass: AssetClass, date: Date): Promise<Observation | undefined>;
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

function routePointFetch(
  options: Pick<ObservationRepositoryOptions, "report" | "fredApiKey" | "tradierApiToken" | "now">,
): FetchCloseFn {
  const now = options.now ?? new Date();
  return async (subject, assetClass, date) => {
    if (subject.startsWith("FRED:")) {
      return fetchFredObservation(subject.slice("FRED:".length), date, options.fredApiKey);
    }
    if (subject.startsWith("IV:")) {
      if (assetClass !== "equity") {
        return;
      }
      return fetchTradierIvObservation(
        subject.slice("IV:".length),
        date,
        options.tradierApiToken,
        fetch,
        now,
      );
    }
    if (assetClass === "equity") {
      return fetchYahooClose(subject, date);
    }
    const id = coinGeckoId(options.report, subject);
    return id === undefined ? undefined : fetchCoinGeckoClose(id, date);
  };
}

export function createObservationRepository(
  options: ObservationRepositoryOptions,
): ObservationRepository {
  const fetchPoint = options.fetchClose ?? routePointFetch(options);
  const now = options.now ?? new Date();

  return {
    async point(subject, assetClass, date) {
      const value = await fetchCloseWithCache(
        subject,
        assetClass,
        date,
        options.cacheDir,
        fetchPoint,
        now,
      );
      return value === undefined ? undefined : { subject, date: ymd(date), value };
    },

    async window(subject, assetClass, from, to) {
      if (assetClass === "equity") {
        return fetchYahooCloseWindow(subject, from, to);
      }

      const id = coinGeckoId(options.report, subject);
      return id === undefined ? [] : fetchCoinGeckoCloseWindow(subject, id, from, to);
    },
  };
}
