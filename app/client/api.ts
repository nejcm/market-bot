import type { ProviderHealthDetail, RunDetail, RunFile, RunSummary } from "../types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Request failed: ${String(response.status)}`);
  }
  return (await response.json()) as unknown;
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
