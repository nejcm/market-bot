import type {
  CalibrationDetail,
  AlphaCohortDetail,
  ConsoleJob,
  InstrumentProfileState,
  InstrumentTimelineDetail,
  ProviderHealthDetail,
  RunDetail,
  RunFile,
  RunSearchFilters,
  RunSearchResult,
  RunSummary,
  Star,
  StarKind,
  SymbolSearchResult,
} from "../types";
import { isRecord } from "../../src/guards";

export interface CreateJobRequest {
  readonly jobType: string;
  readonly assetClass?: string;
  readonly symbol?: string;
  readonly subject?: string;
  readonly depth?: string;
  readonly horizonTradingDays?: number;
}

function isRunSummary(value: unknown): value is RunSummary {
  return (
    isRecord(value) &&
    typeof value.runId === "string" &&
    typeof value.findingCount === "number" &&
    typeof value.predictionCount === "number" &&
    typeof value.sourceCount === "number" &&
    typeof value.dataGapCount === "number" &&
    typeof value.hasScore === "boolean" &&
    Array.isArray(value.availableFiles)
  );
}

function isRunDetail(value: unknown): value is RunDetail {
  return isRecord(value) && isRunSummary(value.summary);
}

function isRunFile(value: unknown): value is RunFile {
  return isRecord(value) && typeof value.path === "string" && typeof value.content === "string";
}

function isProviderHealthDetail(value: unknown): value is ProviderHealthDetail {
  return isRecord(value);
}

function isCalibrationDetail(value: unknown): value is CalibrationDetail {
  return isRecord(value);
}

function isAlphaCohortDetail(value: unknown): value is AlphaCohortDetail {
  return isRecord(value);
}

function isInstrumentTimelineDetail(value: unknown): value is InstrumentTimelineDetail {
  return (
    isRecord(value) &&
    typeof value.assetClass === "string" &&
    typeof value.symbol === "string" &&
    typeof value.instrumentKey === "string" &&
    typeof value.generatedAt === "string" &&
    (value.source === "history" || value.source === "live") &&
    Array.isArray(value.entries) &&
    Array.isArray(value.pricePoints) &&
    isRecord(value.counts) &&
    isRecord(value.warnings) &&
    (value.profile === undefined || isInstrumentProfileState(value.profile)) &&
    (value.notFound === undefined || typeof value.notFound === "boolean")
  );
}

function isInstrumentProfileState(value: unknown): value is InstrumentProfileState {
  if (!isRecord(value) || (value.status !== "available" && value.status !== "gap")) {
    return false;
  }
  if (value.status === "gap") {
    return typeof value.message === "string";
  }
  return (
    isRecord(value.profile) &&
    typeof value.profile.name === "string" &&
    typeof value.profile.ticker === "string" &&
    typeof value.profile.fetchedAt === "string"
  );
}

function isSymbolSearchResult(value: unknown): value is SymbolSearchResult {
  return isRecord(value) && typeof value.symbol === "string";
}

function isRunSearchResult(value: unknown): value is RunSearchResult {
  return (
    isRecord(value) &&
    isRunSummary(value.run) &&
    typeof value.section === "string" &&
    typeof value.label === "string" &&
    typeof value.snippet === "string" &&
    Array.isArray(value.sourceIds) &&
    value.sourceIds.every((sourceId) => typeof sourceId === "string")
  );
}

function isConsoleJob(value: unknown): value is ConsoleJob {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.status === "string" &&
    Array.isArray(value.argv) &&
    typeof value.label === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.stdout === "string" &&
    typeof value.stderr === "string"
  );
}

function isStar(value: unknown): value is Star {
  return (
    isRecord(value) &&
    (value.kind === "run" || value.kind === "instrument") &&
    typeof value.key === "string" &&
    typeof value.createdAt === "string"
  );
}

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetch(path);
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `Request failed: ${String(response.status)}`;
    throw new Error(message);
  }
  return payload;
}

async function requestJson(method: string, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `Request failed: ${String(response.status)}`;
    throw new Error(message);
  }
  return payload;
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  return requestJson("POST", path, body);
}

export async function fetchRuns(): Promise<readonly RunSummary[]> {
  const payload = await fetchJson("/api/runs");
  if (!isRecord(payload) || !Array.isArray(payload.runs)) {
    throw new Error("Run list response is invalid");
  }

  return payload.runs.filter(isRunSummary);
}

export async function fetchRunDetail(runId: string): Promise<RunDetail> {
  const payload = await fetchJson(`/api/runs/${encodeURIComponent(runId)}`);
  if (!isRunDetail(payload)) {
    throw new Error("Run detail response is invalid");
  }

  return payload;
}

export async function fetchRunFile(runId: string, path: string): Promise<RunFile> {
  const payload = await fetchJson(
    `/api/runs/${encodeURIComponent(runId)}/files?path=${encodeURIComponent(path)}`,
  );
  if (!isRunFile(payload)) {
    throw new Error("Run file response is invalid");
  }

  return payload;
}

export async function fetchProviderHealth(): Promise<ProviderHealthDetail> {
  const payload = await fetchJson("/api/provider-health");
  if (!isProviderHealthDetail(payload)) {
    throw new Error("Provider health response is invalid");
  }

  return payload;
}

export async function fetchCalibration(): Promise<CalibrationDetail> {
  const payload = await fetchJson("/api/calibration");
  if (!isCalibrationDetail(payload)) {
    throw new Error("Calibration response is invalid");
  }

  return payload;
}

export async function fetchAlphaCohorts(): Promise<AlphaCohortDetail> {
  const payload = await fetchJson("/api/alpha-cohorts");
  if (!isAlphaCohortDetail(payload)) {
    throw new Error("Alpha cohort response is invalid");
  }

  return payload;
}

export async function fetchInstrumentTimeline(
  assetClass: string,
  symbol: string,
): Promise<InstrumentTimelineDetail> {
  const payload = await fetchJson(
    `/api/instruments/${encodeURIComponent(assetClass)}/${encodeURIComponent(symbol)}/timeline`,
  );
  if (!isInstrumentTimelineDetail(payload)) {
    throw new Error("Instrument timeline response is invalid");
  }

  return payload;
}

export async function fetchRunSearch(
  filters: RunSearchFilters,
): Promise<readonly RunSearchResult[]> {
  const params = new URLSearchParams({ query: filters.query });

  appendSearchParam(params, "symbol", filters.symbol);
  appendSearchParam(params, "assetClass", filters.assetClass);
  appendSearchParam(params, "jobType", filters.jobType);
  appendSearchParam(params, "from", filters.from);
  appendSearchParam(params, "to", filters.to);

  const payload = await fetchJson(`/api/search?${params.toString()}`);
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    throw new Error("Search response is invalid");
  }

  return payload.results.filter(isRunSearchResult);
}

function appendSearchParam(params: URLSearchParams, key: string, value: string | undefined): void {
  if (value !== undefined && value.trim() !== "") {
    params.set(key, value);
  }
}

export async function fetchJobs(): Promise<readonly ConsoleJob[]> {
  const payload = await fetchJson("/api/jobs");
  if (!isRecord(payload) || !Array.isArray(payload.jobs)) {
    throw new Error("Job list response is invalid");
  }

  return payload.jobs.filter(isConsoleJob);
}

export async function fetchStars(): Promise<readonly Star[]> {
  const payload = await fetchJson("/api/stars");
  if (!isRecord(payload) || !Array.isArray(payload.stars)) {
    throw new Error("Star list response is invalid");
  }

  return payload.stars.filter(isStar);
}

export async function addStar(kind: StarKind, key: string): Promise<Star> {
  const payload = await requestJson("PUT", "/api/stars", { kind, key });
  if (!isStar(payload)) {
    throw new Error("Star response is invalid");
  }

  return payload;
}

export async function removeStar(kind: StarKind, key: string): Promise<boolean> {
  const payload = await requestJson("DELETE", "/api/stars", { kind, key });
  if (!isRecord(payload) || typeof payload.removed !== "boolean") {
    throw new Error("Star response is invalid");
  }

  return payload.removed;
}

export async function createJob(request: CreateJobRequest): Promise<ConsoleJob> {
  const payload = await postJson("/api/jobs", request);
  if (!isConsoleJob(payload)) {
    throw new Error("Job response is invalid");
  }

  return payload;
}

export async function fetchSymbols(query: string): Promise<readonly SymbolSearchResult[]> {
  const payload = await fetchJson(`/api/symbols?q=${encodeURIComponent(query.trim())}`);
  if (!isRecord(payload) || !Array.isArray(payload.symbols)) {
    throw new Error("Symbol search response is invalid");
  }

  return payload.symbols.filter(isSymbolSearchResult);
}

export async function refreshInstrumentProfile(symbol: string): Promise<InstrumentProfileState> {
  const payload = await postJson(`/api/profiles/${encodeURIComponent(symbol)}/refresh`, {});
  if (!isRecord(payload) || !isInstrumentProfileState(payload.profile)) {
    throw new Error("Profile response is invalid");
  }

  return payload.profile;
}
