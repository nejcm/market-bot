import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProfileRow, openConsoleDb, putProfileRow } from "../app/console-db";
import {
  fetchFinnhubProfile,
  normalizeFinnhubProfile,
  profileIsFresh,
} from "../app/finnhub-profile";
import { loadSecTickers, secTickersCachePath, searchSecTickers } from "../app/sec-tickers";
import { handleResearchConsoleRequest } from "../app/server";
import { researchReport } from "./support/fixtures";

const SEC_TICKERS_PAYLOAD = {
  "0": { cik_str: 320_193, ticker: "AAPL", title: "Apple Inc." },
  "1": { cik_str: 789_019, ticker: "MSFT", title: "Microsoft Corp" },
  "2": { cik_str: 1_018_724, ticker: "AMZN", title: "Amazon.com Inc" },
};

const PROFILE_PAYLOAD = {
  country: "US",
  currency: "USD",
  exchange: "NASDAQ NMS - GLOBAL MARKET",
  finnhubIndustry: "Technology",
  ipo: "1980-12-12",
  marketCapitalization: 2_940_000, // Finnhub unit: millions
  name: "Apple Inc",
  shareOutstanding: 15_000, // Finnhub unit: millions
  ticker: "AAPL",
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "research-console-symbols-"));
}

function jsonResponse(payload: unknown, status = 200): Response {
  return Response.json(payload, { status, headers: { "content-type": "application/json" } });
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof Request) {
    return input.url;
  }
  return input.toString();
}

function fetchServing(
  handler: (url: string) => Response | Promise<Response>,
  onCall?: (url: string) => void,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = urlOf(input);
    onCall?.(url);
    return await handler(url);
  }) as typeof fetch;
}

function secAndProfileHandler(url: string): Response {
  if (url.includes("company_tickers.json")) {
    return jsonResponse(SEC_TICKERS_PAYLOAD);
  }
  if (url.includes("/stock/profile2")) {
    return jsonResponse(PROFILE_PAYLOAD);
  }
  return jsonResponse({ error: `unexpected url ${url}` }, 404);
}

function consoleProviders(
  dataDir: string,
  handler: (url: string) => Response | Promise<Response>,
  options: { token?: string; onCall?: (url: string) => void } = {},
) {
  return {
    secTickersCacheDir: join(dataDir, "cache"),
    ...(options.token !== undefined ? { finnhubApiToken: options.token } : {}),
    fetchFn: fetchServing(handler, options.onCall),
  };
}

function writeRun(dataDir: string, runId: string, symbol: string): void {
  const runDir = join(dataDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "report.json"),
    `${JSON.stringify(
      researchReport({
        runId,
        jobType: "equity",
        assetClass: "equity",
        symbol,
        generatedAt: "2026-06-05T00:00:00.000Z",
      }),
    )}\n`,
    "utf8",
  );
}

function instrumentRequest(dataDir: string, symbol: string): Request {
  return new Request(
    `http://127.0.0.1/api/instruments/equity/${encodeURIComponent(symbol)}/timeline`,
  );
}

describe("sec ticker search", () => {
  test("matches ticker prefixes and names case-insensitively", () => {
    expect(searchSecTickers(SEC_TICKERS_PAYLOAD, "aa")).toEqual([
      { symbol: "AAPL", name: "Apple Inc." },
    ]);
    expect(searchSecTickers(SEC_TICKERS_PAYLOAD, "micro")).toEqual([
      { symbol: "MSFT", name: "Microsoft Corp" },
    ]);
    expect(searchSecTickers(SEC_TICKERS_PAYLOAD, "MSFT")).toEqual([
      { symbol: "MSFT", name: "Microsoft Corp" },
    ]);
    expect(searchSecTickers(SEC_TICKERS_PAYLOAD, "")).toEqual([]);
    expect(searchSecTickers("not an object", "aa")).toEqual([]);
  });

  test("ranks exact ticker matches first and caps results", () => {
    const payload = {
      "0": { cik_str: 1, ticker: "AAA", title: "Prefix Corp" },
      "1": { cik_str: 2, ticker: "AAB", title: "Second Corp" },
      "2": { cik_str: 3, ticker: "AAC", title: "AA Corp" },
    };

    expect(searchSecTickers(payload, "a", 2)).toEqual([
      { symbol: "AAA", name: "Prefix Corp" },
      { symbol: "AAB", name: "Second Corp" },
    ]);
    expect(searchSecTickers(payload, "aa", 2)[0]).toEqual({
      symbol: "AAA",
      name: "Prefix Corp",
    });
  });

  test("loads the daily cache and refetches on the next day", async () => {
    const cacheDir = join(tempDir(), "cache");
    const calls: string[] = [];
    const fetchFn = fetchServing(
      () => jsonResponse(SEC_TICKERS_PAYLOAD),
      (url) => calls.push(url),
    );
    const now = new Date("2026-06-05T12:00:00.000Z");

    const first = await loadSecTickers({ cacheDir, fetchFn, now });
    expect(first.ok).toBe(true);
    const second = await loadSecTickers({ cacheDir, fetchFn, now });
    expect(second.ok).toBe(true);
    expect(calls).toHaveLength(1);

    const nextDay = new Date("2026-06-06T00:00:00.000Z");
    await loadSecTickers({ cacheDir, fetchFn, now: nextDay });
    expect(calls).toHaveLength(2);
    expect(existsSync(secTickersCachePath(cacheDir))).toBe(true);
  });

  test("reports a failure when the fetch fails and no current cache exists", async () => {
    const cacheDir = join(tempDir(), "cache");
    const result = await loadSecTickers({
      cacheDir,
      fetchFn: fetchServing(() => jsonResponse({ error: "upstream" }, 503)),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("SEC ticker list is unavailable");
    }
  });

  test("does not serve a stale cache when the fetch fails", async () => {
    const cacheDir = join(tempDir(), "cache");
    mkdirSync(cacheDir, { recursive: true });
    const now = new Date("2026-06-06T00:00:00.000Z");
    writeFileSync(
      secTickersCachePath(cacheDir),
      `${JSON.stringify({ fetchedAt: "2026-06-04T00:00:00.000Z", payload: SEC_TICKERS_PAYLOAD })}\n`,
      "utf8",
    );

    const result = await loadSecTickers({
      cacheDir,
      fetchFn: fetchServing(() => jsonResponse({ error: "upstream" }, 503)),
      now,
    });

    expect(result.ok).toBe(false);
  });

  test("rejects a ticker list without ticker rows, fetched or cached", async () => {
    const cacheDir = join(tempDir(), "cache");
    mkdirSync(cacheDir, { recursive: true });
    const now = new Date("2026-06-05T12:00:00.000Z");
    writeFileSync(
      secTickersCachePath(cacheDir),
      `${JSON.stringify({ fetchedAt: now.toISOString(), payload: { error: "temporarily unavailable" } })}\n`,
      "utf8",
    );

    const result = await loadSecTickers({
      cacheDir,
      fetchFn: fetchServing(() => jsonResponse({ error: "temporarily unavailable" })),
      now,
    });

    expect(result.ok).toBe(false);
  });

  test("refetches past an unreadable cache file", async () => {
    const cacheDir = join(tempDir(), "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(secTickersCachePath(cacheDir), "{", "utf8");

    const result = await loadSecTickers({
      cacheDir,
      fetchFn: fetchServing(() => jsonResponse(SEC_TICKERS_PAYLOAD)),
    });

    expect(result.ok).toBe(true);
    expect(readFileSync(secTickersCachePath(cacheDir), "utf8").startsWith("{")).toBe(true);
  });
});

describe("finnhub profile adapter", () => {
  test("normalizes a full profile payload and rejects one without a name", () => {
    expect(normalizeFinnhubProfile(PROFILE_PAYLOAD)).toEqual({
      name: "Apple Inc",
      ticker: "AAPL",
      exchange: "NASDAQ NMS - GLOBAL MARKET",
      industry: "Technology",
      marketCap: 2_940_000_000_000,
      shareOutstanding: 15_000_000_000,
      ipo: "1980-12-12",
      currency: "USD",
      country: "US",
    });
    expect(normalizeFinnhubProfile({ ticker: "AAPL" })).toBeUndefined();
    expect(normalizeFinnhubProfile("not an object")).toBeUndefined();
  });

  test("treats profiles older than 30 days as stale", () => {
    const now = new Date("2026-06-15T00:00:00.000Z");
    expect(profileIsFresh("2026-05-16T00:00:00.000Z", now)).toBe(true);
    expect(profileIsFresh("2026-05-15T23:59:59.999Z", now)).toBe(false);
    expect(profileIsFresh("not a date", now)).toBe(false);
  });

  test("returns a gap for a missing token without fetching", async () => {
    const result = await fetchFinnhubProfile(
      "AAPL",
      undefined,
      fetchServing(() => {
        throw new Error("must not be called");
      }),
    );

    expect(result).toEqual({ ok: false, message: "profile unavailable: missing Finnhub token" });
  });

  test("returns a gap for provider failures", async () => {
    const forbidden = await fetchFinnhubProfile(
      "AAPL",
      "token",
      fetchServing(() => jsonResponse({ error: "Forbidden" }, 403)),
    );
    expect(forbidden).toEqual({
      ok: false,
      message: "profile unavailable: provider returned 403",
    });

    const network = await fetchFinnhubProfile(
      "AAPL",
      "token",
      fetchServing(() => {
        throw new Error("connection refused");
      }),
    );
    expect(network).toEqual({
      ok: false,
      message: "profile unavailable: connection refused",
    });

    const malformed = await fetchFinnhubProfile(
      "AAPL",
      "token",
      fetchServing(() => jsonResponse({ ticker: "AAPL" })),
    );
    expect(malformed).toEqual({
      ok: false,
      message: "profile unavailable: provider response was empty or malformed",
    });
  });

  test("fetches and normalizes a profile", async () => {
    const now = new Date("2026-06-05T12:00:00.000Z");
    const result = await fetchFinnhubProfile(
      "AAPL",
      "token",
      fetchServing((url) => {
        expect(url).toContain("/stock/profile2");
        return jsonResponse(PROFILE_PAYLOAD);
      }),
      now,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile.name).toBe("Apple Inc");
      expect(result.profile.marketCap).toBe(2_940_000_000_000);
      expect(result.fetchedAt).toBe("2026-06-05T12:00:00.000Z");
    }
  });
});

describe("console db profiles", () => {
  test("stores, replaces, and reads profile rows", () => {
    const dbPath = join(tempDir(), "console", "console.sqlite");
    const db = openConsoleDb(dbPath);
    try {
      expect(getProfileRow(db, "AAPL")).toBeUndefined();
      putProfileRow(db, "AAPL", PROFILE_PAYLOAD, "2026-06-05T00:00:00.000Z");
      putProfileRow(db, "AAPL", { name: "Newer" }, "2026-06-06T00:00:00.000Z");

      expect(getProfileRow(db, "AAPL")).toEqual({
        payload: { name: "Newer" },
        fetchedAt: "2026-06-06T00:00:00.000Z",
      });
    } finally {
      db.close();
    }
  });
});

describe("symbols API", () => {
  test("searches the SEC ticker list", async () => {
    const dataDir = tempDir();
    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/symbols?q=aa"),
      { dataDir, consoleProviders: consoleProviders(dataDir, secAndProfileHandler) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      symbols: [{ symbol: "AAPL", name: "Apple Inc." }],
    });
  });

  test("rejects a missing query", async () => {
    const dataDir = tempDir();
    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/symbols"),
      { dataDir, consoleProviders: consoleProviders(dataDir, secAndProfileHandler) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Search query is required" });
  });

  test("reports SEC list failures as an error", async () => {
    const dataDir = tempDir();
    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/symbols?q=aa"),
      {
        dataDir,
        consoleProviders: consoleProviders(dataDir, () => jsonResponse({ error: "upstream" }, 503)),
      },
    );

    expect(response.status).toBe(502);
    const payload = (await response.json()) as { readonly error: string };
    expect(payload.error).toContain("SEC ticker list is unavailable");
  });

  test("returns no symbols for non-SEC tickers", async () => {
    const dataDir = tempDir();
    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/symbols?q=xiaomi"),
      { dataDir, consoleProviders: consoleProviders(dataDir, secAndProfileHandler) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ symbols: [] });
  });

  test("rejects non-GET methods", async () => {
    const dataDir = tempDir();
    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/symbols?q=aa", { method: "POST" }),
      { dataDir, consoleProviders: consoleProviders(dataDir, secAndProfileHandler) },
    );

    expect(response.status).toBe(405);
  });
});

describe("profile refresh API", () => {
  test("refreshes and stores a profile", async () => {
    const dataDir = tempDir();
    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/profiles/aapl/refresh", { method: "POST" }),
      {
        dataDir,
        consoleProviders: consoleProviders(dataDir, secAndProfileHandler, { token: "token" }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      profile: {
        status: "available",
        profile: { name: "Apple Inc", ticker: "AAPL", marketCap: 2_940_000_000_000 },
      },
    });

    const dbPath = join(dataDir, "console", "console.sqlite");
    const db = openConsoleDb(dbPath);
    try {
      const row = getProfileRow(db, "AAPL");
      expect((row?.payload as { readonly name?: string } | undefined)?.name).toBe("Apple Inc");
    } finally {
      db.close();
    }
  });

  test("rejects cross-origin refreshes", async () => {
    const dataDir = tempDir();
    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/profiles/aapl/refresh", {
        method: "POST",
        headers: { origin: "http://evil.example" },
      }),
      { dataDir, consoleProviders: consoleProviders(dataDir, secAndProfileHandler) },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Profile request origin is not allowed",
    });
  });

  test("rejects invalid symbols", async () => {
    const dataDir = tempDir();
    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/profiles/bad%20symbol/refresh", { method: "POST" }),
      { dataDir, consoleProviders: consoleProviders(dataDir, secAndProfileHandler) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid profile request" });
  });

  test("reports provider failures as an error", async () => {
    const dataDir = tempDir();
    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/profiles/aapl/refresh", { method: "POST" }),
      {
        dataDir,
        consoleProviders: consoleProviders(
          dataDir,
          () => jsonResponse({ error: "Forbidden" }, 403),
          {
            token: "token",
          },
        ),
      },
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "profile unavailable: provider returned 403",
    });
  });
});

describe("instrument screen", () => {
  test("serves the profile card and caches it for later reads", async () => {
    const dataDir = tempDir();
    const calls: string[] = [];
    const providers = consoleProviders(dataDir, secAndProfileHandler, {
      token: "token",
      onCall: (url) => calls.push(url),
    });

    const first = await handleResearchConsoleRequest(instrumentRequest(dataDir, "aapl"), {
      dataDir,
      consoleProviders: providers,
    });
    expect(first.status).toBe(200);
    const firstPayload = (await first.json()) as {
      readonly profile?: {
        readonly status: string;
        readonly profile: { readonly name: string; readonly marketCap: number };
      };
      readonly notFound?: boolean;
    };
    expect(firstPayload.profile?.status).toBe("available");
    expect(firstPayload.profile?.profile.name).toBe("Apple Inc");
    expect(firstPayload.notFound).toBeUndefined();
    expect(calls.filter((url) => url.includes("/stock/profile2"))).toHaveLength(1);

    const second = await handleResearchConsoleRequest(instrumentRequest(dataDir, "aapl"), {
      dataDir,
      consoleProviders: consoleProviders(dataDir, () => {
        throw new Error("must not be called: profile should come from the cache");
      }),
    });
    expect(second.status).toBe(200);
    const secondPayload = (await second.json()) as {
      readonly profile?: { readonly status: string; readonly profile: { readonly name: string } };
    };
    expect(secondPayload.profile?.status).toBe("available");
    expect(secondPayload.profile?.profile.name).toBe("Apple Inc");
  });

  test("keeps the page working when the console db cannot be opened", async () => {
    const dataDir = tempDir();
    writeFileSync(join(dataDir, "console"), "not a directory", "utf8");

    const response = await handleResearchConsoleRequest(instrumentRequest(dataDir, "aapl"), {
      dataDir,
      consoleProviders: consoleProviders(dataDir, secAndProfileHandler, { token: "token" }),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      readonly profile?: { readonly status: string; readonly profile: { readonly name: string } };
      readonly notFound?: boolean;
    };
    expect(payload.profile?.status).toBe("available");
    expect(payload.profile?.profile.name).toBe("Apple Inc");
    expect(payload.notFound).toBeUndefined();
  });

  test("shows a profile source gap when the Finnhub token is missing", async () => {
    const dataDir = tempDir();
    const response = await handleResearchConsoleRequest(instrumentRequest(dataDir, "aapl"), {
      dataDir,
      consoleProviders: consoleProviders(dataDir, secAndProfileHandler),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      readonly profile?: { readonly status: string; readonly message: string };
      readonly notFound?: boolean;
    };
    expect(payload.profile).toEqual({
      status: "gap",
      message: "profile unavailable: missing Finnhub token",
    });
    expect(payload.notFound).toBeUndefined();
  });

  test("declares unknown symbols not-found when they have no runs", async () => {
    const dataDir = tempDir();
    const response = await handleResearchConsoleRequest(instrumentRequest(dataDir, "xiaomi"), {
      dataDir,
      consoleProviders: consoleProviders(dataDir, secAndProfileHandler, { token: "token" }),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { readonly notFound?: boolean };
    expect(payload.notFound).toBe(true);
  });

  test("keeps unknown symbols with runs readable", async () => {
    const dataDir = tempDir();
    writeRun(dataDir, "run-xiaomi", "XIAOMI");
    const response = await handleResearchConsoleRequest(instrumentRequest(dataDir, "xiaomi"), {
      dataDir,
      consoleProviders: consoleProviders(dataDir, secAndProfileHandler, { token: "token" }),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      readonly notFound?: boolean;
      readonly symbol?: string;
    };
    expect(payload.notFound).toBeUndefined();
    expect(payload.symbol).toBe("XIAOMI");
  });

  test("keeps the page working when the SEC list fetch fails", async () => {
    const dataDir = tempDir();
    const response = await handleResearchConsoleRequest(instrumentRequest(dataDir, "aapl"), {
      dataDir,
      consoleProviders: consoleProviders(dataDir, () => jsonResponse({ error: "upstream" }, 503)),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { readonly notFound?: boolean };
    expect(payload.notFound).toBeUndefined();
  });

  test("serves crypto instruments without profile or not-found fields", async () => {
    const dataDir = tempDir();
    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/instruments/crypto/btc/timeline"),
      { dataDir, consoleProviders: consoleProviders(dataDir, secAndProfileHandler) },
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      readonly profile?: unknown;
      readonly notFound?: boolean;
    };
    expect(payload.profile).toBeUndefined();
    expect(payload.notFound).toBeUndefined();
  });
});
