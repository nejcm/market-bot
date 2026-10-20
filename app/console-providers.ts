import { join } from "node:path";
import { resolveConfig } from "../src/config";
import { dataRootFromRunsDir } from "../src/data-paths";

export interface ConsoleProviderDeps {
  readonly secTickersCacheDir: string;
  readonly finnhubApiToken?: string;
  readonly secUserAgent?: string;
  readonly fetchFn: typeof fetch;
}

export function defaultConsoleProviders(dataDir: string): ConsoleProviderDeps {
  let finnhubApiToken: string | undefined = undefined;
  let secUserAgent: string | undefined = undefined;
  try {
    const appConfig = resolveConfig(process.env, { validateAlphaSearchOptions: false });
    ({ finnhubApiToken, secUserAgent } = appConfig.sourceOptions);
  } catch {
    // Unreadable config leaves the token unset; the profile card shows a Source Gap.
  }
  return {
    secTickersCacheDir: join(dataRootFromRunsDir(dataDir), "cache"),
    ...(finnhubApiToken !== undefined ? { finnhubApiToken } : {}),
    ...(secUserAgent !== undefined ? { secUserAgent } : {}),
    fetchFn: fetch,
  };
}
