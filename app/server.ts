import { existsSync } from "node:fs";
import { extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { resolveConfig, resolveResearchConsoleConfig } from "../src/config";
import { isRecord } from "../src/guards";
import { createProvider } from "../src/model/factory";
import {
  listRunSummaries,
  readCalibrationSummary,
  readAlphaLeadCohorts,
  readProviderHealth,
  readRunDetail,
  readRunFile,
  searchRunReports,
} from "./artifacts";
import { handleRunChat, type ChatEndpointDeps } from "./chat";
import {
  addStar,
  consoleDbPath,
  listStars,
  putProfileRow,
  removeStar,
  withConsoleDb,
} from "./console-db";
import { defaultConsoleProviders, type ConsoleProviderDeps } from "./console-providers";
import { fetchFinnhubProfile } from "./finnhub-profile";
import { readInstrumentTimelineDetail } from "./instruments";
import { createJobQueue, type ResearchConsoleJobQueue } from "./jobs";
import { isSameOriginPost } from "./same-origin";
import { loadSecTickers, searchSecTickers } from "./sec-tickers";
import type { Star, StarKind } from "./types";

const DIST_DIR = resolve(import.meta.dir, "dist");
const INSTRUMENT_SYMBOL_PATTERN = /^[A-Z0-9._-]{1,20}$/u;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

interface ResearchConsoleRequestOptions {
  readonly dataDir?: string;
  readonly consoleDbPath?: string;
  readonly jobQueue?: ResearchConsoleJobQueue;
  readonly chatDeps?: ChatEndpointDeps;
  readonly consoleProviders?: ConsoleProviderDeps;
}

const DEFAULT_JOB_QUEUE = createJobQueue();

function contentType(path: string): string {
  return CONTENT_TYPES[extname(path)] ?? "application/octet-stream";
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(value)}\n`, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function isWithinDirectory(root: string, path: string): boolean {
  const childPath = relative(root, path);
  return childPath === "" || (!childPath.startsWith("..") && !isAbsolute(childPath));
}

function decodePathname(pathname: string): string | undefined {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
}

function optionalSearchParam(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key)?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function isAssetClass(value: string): value is "equity" | "crypto" {
  return value === "equity" || value === "crypto";
}

function hasParentSegment(pathname: string): boolean {
  return pathname.split(/[\\/]/u).includes("..");
}

export function researchConsoleStaticPath(
  pathname: string,
  distDir: string = DIST_DIR,
): string | undefined {
  const decoded = decodePathname(pathname);
  if (decoded === undefined || hasParentSegment(decoded)) {
    return undefined;
  }

  const normalizedPath = normalize(decoded).replace(/^([/\\])+/u, "");
  const candidate = resolve(distDir, normalizedPath === "" ? "index.html" : normalizedPath);

  if (!isWithinDirectory(distDir, candidate)) {
    return undefined;
  }

  if (existsSync(candidate)) {
    return candidate;
  }

  const indexPath = join(distDir, "index.html");
  return existsSync(indexPath) ? indexPath : undefined;
}

async function handleApiRequest(
  url: URL,
  dataDir: string,
  consoleOptions: {
    readonly consoleDbPath: string;
    readonly providers: ConsoleProviderDeps;
  },
): Promise<Response | undefined> {
  if (url.pathname === "/api/runs") {
    return jsonResponse({ runs: await listRunSummaries(dataDir) });
  }

  if (url.pathname === "/api/search") {
    const query = url.searchParams.get("query")?.trim() ?? "";
    if (query === "") {
      return jsonResponse({ error: "Search query is required" }, 400);
    }

    const symbol = optionalSearchParam(url, "symbol");
    const assetClass = optionalSearchParam(url, "assetClass");
    const jobType = optionalSearchParam(url, "jobType");
    const from = optionalSearchParam(url, "from");
    const to = optionalSearchParam(url, "to");

    return jsonResponse({
      results: await searchRunReports(dataDir, {
        query,
        ...(symbol !== undefined ? { symbol } : {}),
        ...(assetClass !== undefined ? { assetClass } : {}),
        ...(jobType !== undefined ? { jobType } : {}),
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
      }),
    });
  }

  if (url.pathname === "/api/provider-health") {
    return jsonResponse(await readProviderHealth(dataDir));
  }

  if (url.pathname === "/api/calibration") {
    return jsonResponse(await readCalibrationSummary(dataDir));
  }

  if (url.pathname === "/api/alpha-cohorts") {
    return jsonResponse(await readAlphaLeadCohorts(dataDir));
  }

  const instrumentMatch = /^\/api\/instruments\/([^/]+)\/([^/]+)\/timeline$/u.exec(url.pathname);
  if (instrumentMatch !== null) {
    const assetClass = decodePathname(instrumentMatch[1] ?? "");
    const symbol = decodePathname(instrumentMatch[2] ?? "");
    const normalizedSymbol = symbol?.toUpperCase();
    if (
      assetClass === undefined ||
      normalizedSymbol === undefined ||
      !isAssetClass(assetClass) ||
      !INSTRUMENT_SYMBOL_PATTERN.test(normalizedSymbol)
    ) {
      return jsonResponse({ error: "Invalid instrument request" }, 400);
    }

    return jsonResponse(
      await readInstrumentTimelineDetail(dataDir, assetClass, normalizedSymbol, {
        consoleDbPath: consoleOptions.consoleDbPath,
        ...consoleOptions.providers,
      }),
    );
  }

  const fileMatch = /^\/api\/runs\/([^/]+)\/files$/u.exec(url.pathname);
  if (fileMatch !== null) {
    const runId = decodePathname(fileMatch[1] ?? "");
    const requestedPath = url.searchParams.get("path");
    if (runId === undefined || requestedPath === null) {
      return jsonResponse({ error: "Invalid file request" }, 400);
    }

    const file = await readRunFile(dataDir, runId, requestedPath);
    return file === undefined ? jsonResponse({ error: "File not found" }, 404) : jsonResponse(file);
  }

  const runMatch = /^\/api\/runs\/([^/]+)$/u.exec(url.pathname);
  if (runMatch !== null) {
    const runId = decodePathname(runMatch[1] ?? "");
    if (runId === undefined) {
      return jsonResponse({ error: "Invalid run id" }, 400);
    }

    const detail = await readRunDetail(dataDir, runId);
    return detail === undefined
      ? jsonResponse({ error: "Run not found" }, 404)
      : jsonResponse(detail);
  }

  if (url.pathname.startsWith("/api/")) {
    return jsonResponse({ error: "Not found" }, 404);
  }

  return undefined;
}

async function readRequestJson(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    throw new Error("Request body must be JSON");
  }
}

async function handleJobRequest(
  request: Request,
  url: URL,
  queue: ResearchConsoleJobQueue,
): Promise<Response | undefined> {
  if (url.pathname === "/api/jobs" && request.method === "GET") {
    return jsonResponse({ jobs: queue.list() });
  }

  if (url.pathname === "/api/jobs" && request.method === "POST") {
    if (!isSameOriginPost(request, url)) {
      return jsonResponse({ error: "Job request origin is not allowed" }, 403);
    }

    try {
      const job = queue.enqueue(await readRequestJson(request));
      return jsonResponse(job, 202);
    } catch (error: unknown) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  const jobMatch = /^\/api\/jobs\/([^/]+)$/u.exec(url.pathname);
  if (jobMatch !== null && request.method === "GET") {
    const job = queue.get(jobMatch[1] ?? "");
    return job === undefined ? jsonResponse({ error: "Job not found" }, 404) : jsonResponse(job);
  }

  return undefined;
}

const NO_PROVIDER_REASON = "Run chat is unavailable: no model provider is configured";

const STAR_KEY_MAX_LENGTH = 200;

function parseStarRequest(
  value: unknown,
): { readonly kind: StarKind; readonly key: string } | undefined {
  if (!isRecord(value) || typeof value.kind !== "string" || typeof value.key !== "string") {
    return undefined;
  }
  const { kind, key: rawKey } = value;
  if (kind !== "run" && kind !== "instrument") {
    return undefined;
  }
  const key = rawKey.trim();
  if (
    key === "" ||
    key.length > STAR_KEY_MAX_LENGTH ||
    key.includes("/") ||
    key.includes("\\") ||
    key.includes("..") ||
    (kind === "run" && key.includes(":"))
  ) {
    return undefined;
  }
  if (kind === "instrument") {
    const separator = key.indexOf(":");
    if (separator <= 0) {
      return undefined;
    }
    const assetClass = key.slice(0, separator);
    const symbol = key.slice(separator + 1);
    if (!isAssetClass(assetClass) || !INSTRUMENT_SYMBOL_PATTERN.test(symbol)) {
      return undefined;
    }
  }
  return { kind, key };
}

function readStars(dbPath: string, dataDir: string): readonly Star[] {
  // Absent DB reads empty without creating the file or its directory.
  if (!existsSync(dbPath)) {
    return [];
  }
  return withConsoleDb(dbPath, (db) =>
    listStars(db).map((star) =>
      star.kind === "run" && !existsSync(join(dataDir, star.key))
        ? { ...star, missing: true }
        : star,
    ),
  );
}

async function handleStarRequest(
  request: Request,
  url: URL,
  dbPath: string,
  dataDir: string,
): Promise<Response | undefined> {
  if (url.pathname !== "/api/stars") {
    return undefined;
  }

  if (request.method === "GET") {
    return jsonResponse({ stars: readStars(dbPath, dataDir) });
  }

  if (request.method !== "PUT" && request.method !== "DELETE") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  if (!isSameOriginPost(request, url)) {
    return jsonResponse({ error: "Star request origin is not allowed" }, 403);
  }

  let parsed: { readonly kind: StarKind; readonly key: string } | undefined;
  try {
    parsed = parseStarRequest(await readRequestJson(request));
  } catch (error: unknown) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
  if (parsed === undefined) {
    return jsonResponse({ error: "Invalid star request" }, 400);
  }

  try {
    if (request.method === "PUT") {
      return jsonResponse(withConsoleDb(dbPath, (db) => addStar(db, parsed.kind, parsed.key)));
    }
    return jsonResponse(
      withConsoleDb(dbPath, (db) => ({ removed: removeStar(db, parsed.kind, parsed.key) })),
    );
  } catch (error: unknown) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

async function handleSymbolsRequest(
  request: Request,
  url: URL,
  providers: ConsoleProviderDeps,
): Promise<Response | undefined> {
  if (url.pathname !== "/api/symbols") {
    return undefined;
  }
  if (request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const query = optionalSearchParam(url, "q");
  if (query === undefined) {
    return jsonResponse({ error: "Search query is required" }, 400);
  }

  const list = await loadSecTickers({
    cacheDir: providers.secTickersCacheDir,
    fetchFn: providers.fetchFn,
    ...(providers.secUserAgent !== undefined ? { secUserAgent: providers.secUserAgent } : {}),
  });
  if (!list.ok) {
    return jsonResponse({ error: list.message }, 502);
  }
  return jsonResponse({ symbols: searchSecTickers(list.payload, query) });
}

async function handleProfileRequest(
  request: Request,
  url: URL,
  dbPath: string,
  providers: ConsoleProviderDeps,
): Promise<Response | undefined> {
  const match = /^\/api\/profiles\/([^/]+)\/refresh$/u.exec(url.pathname);
  if (match === null) {
    return undefined;
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }
  if (!isSameOriginPost(request, url)) {
    return jsonResponse({ error: "Profile request origin is not allowed" }, 403);
  }

  const symbol = decodePathname(match[1] ?? "")?.toUpperCase();
  if (symbol === undefined || !INSTRUMENT_SYMBOL_PATTERN.test(symbol)) {
    return jsonResponse({ error: "Invalid profile request" }, 400);
  }

  const fetched = await fetchFinnhubProfile(symbol, providers.finnhubApiToken, providers.fetchFn);
  if (!fetched.ok) {
    return jsonResponse({ error: fetched.message }, 502);
  }

  try {
    withConsoleDb(dbPath, (db) => putProfileRow(db, symbol, fetched.payload, fetched.fetchedAt));
  } catch (error: unknown) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
  return jsonResponse({
    profile: { status: "available", profile: { ...fetched.profile, fetchedAt: fetched.fetchedAt } },
  });
}

function buildChatDeps(dataDir: string): ChatEndpointDeps {
  const consoleConfig = resolveResearchConsoleConfig();
  if (consoleConfig.chat.disabled) {
    return { status: "unavailable", reason: "Run chat is disabled" };
  }

  try {
    const appConfig = resolveConfig(process.env, { validateAlphaSearchOptions: false });
    if (appConfig.apiKey === undefined && appConfig.provider !== "codex") {
      return { status: "unavailable", reason: NO_PROVIDER_REASON };
    }
    const provider = createProvider(appConfig);
    const chatModel = consoleConfig.chat.model ?? appConfig.quickModel;
    const reasoningEffort =
      appConfig.provider === "codex"
        ? appConfig.codexQuickReasoningEffort
        : appConfig.quickReasoningEffort;
    return {
      status: "ready",
      provider,
      chatConfig: {
        ...consoleConfig.chat,
        model: chatModel,
        ...(reasoningEffort !== undefined ? { modelParams: { reasoningEffort } } : {}),
      },
      dataDir,
    };
  } catch {
    return { status: "unavailable", reason: NO_PROVIDER_REASON };
  }
}

export async function handleResearchConsoleRequest(
  request: Request,
  options: ResearchConsoleRequestOptions = {},
): Promise<Response> {
  const url = new URL(request.url);
  const jobResponse = await handleJobRequest(request, url, options.jobQueue ?? DEFAULT_JOB_QUEUE);
  if (jobResponse !== undefined) {
    return jobResponse;
  }

  const config = resolveResearchConsoleConfig();
  const dataDir = options.dataDir ?? config.dataDir;
  const providers = options.consoleProviders ?? defaultConsoleProviders(dataDir);

  const starResponse = await handleStarRequest(
    request,
    url,
    options.consoleDbPath ?? consoleDbPath(dataDir),
    dataDir,
  );
  if (starResponse !== undefined) {
    return starResponse;
  }

  const symbolsResponse = await handleSymbolsRequest(request, url, providers);
  if (symbolsResponse !== undefined) {
    return symbolsResponse;
  }

  const profileResponse = await handleProfileRequest(
    request,
    url,
    options.consoleDbPath ?? consoleDbPath(dataDir),
    providers,
  );
  if (profileResponse !== undefined) {
    return profileResponse;
  }

  // Chat endpoint — before read-only API and static handler
  const chatDeps = options.chatDeps ?? buildChatDeps(dataDir);
  const chatResponse = await handleRunChat(request, url, chatDeps);
  if (chatResponse !== undefined) {
    return chatResponse;
  }

  const apiResponse = await handleApiRequest(url, dataDir, {
    consoleDbPath: options.consoleDbPath ?? consoleDbPath(dataDir),
    providers,
  });
  if (apiResponse !== undefined) {
    return apiResponse;
  }

  const path = researchConsoleStaticPath(url.pathname);

  if (path === undefined) {
    return new Response("Research Console App assets not built. Run bun run app:build.\n", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  return new Response(Bun.file(path), {
    headers: { "content-type": contentType(path) },
  });
}

if (import.meta.main) {
  const config = resolveResearchConsoleConfig();

  Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: (request) => handleResearchConsoleRequest(request),
  });

  process.stdout.write(`Research Console App listening at http://${config.host}:${config.port}\n`);
}
