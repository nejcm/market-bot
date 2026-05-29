import type { AssetClass } from "../domain/types";
import { fetchYahooClose } from "../sources/yahoo";
import { fetchCoinGeckoClose } from "../sources/coingecko";
import { fetchFredObservation } from "../sources/fred";
import { fetchTradierIvObservation } from "../sources/tradier";
import { fetchCloseWithCache, type FetchCloseFn } from "./close-cache";

export type { FetchCloseFn };

export interface CloseRepository {
  closeAt(symbol: string, assetClass: AssetClass, date: Date): Promise<number | undefined>;
}

export interface CloseRepositoryOptions {
  readonly cacheDir?: string;
  readonly fredApiKey?: string;
  readonly tradierApiToken?: string;
  readonly now?: Date;
}

function routeFetch(
  options: Pick<CloseRepositoryOptions, "fredApiKey" | "tradierApiToken" | "now">,
): FetchCloseFn {
  const now = options.now ?? new Date();
  return async (symbol, assetClass, date) => {
    if (symbol.startsWith("FRED:")) {
      return fetchFredObservation(symbol.slice("FRED:".length), date, options.fredApiKey);
    }
    if (symbol.startsWith("IV:")) {
      if (assetClass !== "equity") {
        return;
      }
      return fetchTradierIvObservation(
        symbol.slice("IV:".length),
        date,
        options.tradierApiToken,
        fetch,
        now,
      );
    }
    if (assetClass === "equity") {
      return fetchYahooClose(symbol, date);
    }
    return fetchCoinGeckoClose(symbol.toLowerCase(), date);
  };
}

export function createCloseRepository(options: CloseRepositoryOptions = {}): CloseRepository {
  const fetchFn = routeFetch(options);
  return {
    closeAt(symbol, assetClass, date) {
      return fetchCloseWithCache(symbol, assetClass, date, options.cacheDir, fetchFn, options.now);
    },
  };
}

export function repositoryFromFetchFn(fetchFn: FetchCloseFn, cacheDir?: string): CloseRepository {
  return {
    closeAt(symbol, assetClass, date) {
      return fetchCloseWithCache(symbol, assetClass, date, cacheDir, fetchFn);
    },
  };
}
