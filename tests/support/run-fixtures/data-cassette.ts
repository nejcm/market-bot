import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalRequestUrl } from "../../../src/sources/cache";
import type { FetchLike } from "../../../src/sources/types";

export interface DataCassetteEntry {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly bodyFile?: string;
  readonly sha256?: string;
}

export interface DataCassette {
  readonly entries: Readonly<Record<string, DataCassetteEntry>>;
}

export interface DataCassetteRecorder {
  readonly cassette: () => DataCassette;
  readonly fetch: FetchLike;
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const buffer = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requestMethod(init: RequestInit | undefined): string {
  return (init?.method ?? "GET").toUpperCase();
}

async function requestBodyHash(init: RequestInit | undefined): Promise<string> {
  const body = init?.body;
  if (body === undefined || body === null) {
    return "";
  }
  if (typeof body === "string") {
    return sha256Hex(body);
  }
  throw new Error("Fixture data cassette supports only string request bodies");
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

export async function dataCassetteKey(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<string> {
  return [
    requestMethod(init),
    await requestBodyHash(init),
    canonicalRequestUrl(requestUrl(input)),
  ].join(" ");
}

// Yahoo mints a fresh crumb per credential fetch, so an authed quote URL recorded with one crumb
// Can never be requested again: replay reads the cassette's single getcrumb entry, builds a URL
// That matches nothing, dead-ends at 401 and degrades in ways the recorded golden never saw.
// Both record and replay therefore pin the crumb to one placeholder. Pinning rather than deleting
// Keeps the un-authed 401 and its authed 200 in separate entries — they differ only by this
// Parameter, since headers are not part of the key — so replay still walks the credential path
// Instead of being handed the authed response on the first, un-authed call.
// The canonicalRequestUrl helper already drops credential parameters proper (api_key, api_token,
// Token, access_token); the crumb is the only rotating value that survives it.
// Replay looks the exact key up first and falls back to the pinned one, which needs no flag and
// Cannot misfire in either direction: a legacy cassette stores real crumbs, so it can only be hit
// Exactly — the fallback key is absent from it, leaving its recorded dead-ends intact — while a
// Pinned cassette stores the placeholder, which no live crumb can equal, so its authed entries are
// Only ever reached through the fallback.
const CRUMB_PLACEHOLDER = "fixture-crumb";

function pinnedCrumb(key: string): string {
  const separator = key.lastIndexOf(" ");
  const url = key.slice(separator + 1);
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has("crumb")) {
      return key;
    }
    parsed.searchParams.set("crumb", CRUMB_PLACEHOLDER);
    return `${key.slice(0, separator + 1)}${canonicalRequestUrl(parsed.toString())}`;
  } catch {
    return key;
  }
}

function replayHeaders(headers: Readonly<Record<string, string>>): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    result.set(key, value);
  }
  return result;
}

function storedHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    const normalizedKey = key.toLowerCase();
    if (["content-type", "etag", "last-modified"].includes(normalizedKey)) {
      result[normalizedKey] = value;
    }
  }
  return result;
}

async function replayBody(entry: DataCassetteEntry, fixtureDir?: string): Promise<string> {
  if (entry.bodyFile === undefined) {
    return entry.body;
  }
  if (fixtureDir === undefined) {
    throw new Error("Fixture data cassette entry bodyFile requires a fixture directory");
  }
  const body = await readFile(join(fixtureDir, entry.bodyFile), "utf8");
  if (entry.sha256 !== undefined && (await sha256Hex(body)) !== entry.sha256) {
    throw new Error(`Fixture data cassette body hash mismatch: ${entry.bodyFile}`);
  }
  return body;
}

export function makeReplayFetch(cassette: DataCassette, fixtureDir?: string): FetchLike {
  return async (input, init) => {
    const exactKey = await dataCassetteKey(input, init);
    const key = cassette.entries[exactKey] === undefined ? pinnedCrumb(exactKey) : exactKey;
    const entry = cassette.entries[key];
    if (entry === undefined) {
      throw new Error(`Fixture data cassette miss: ${key}`);
    }
    return new Response(await replayBody(entry, fixtureDir), {
      status: entry.status,
      headers: replayHeaders(entry.headers),
    });
  };
}

export function createRecordingFetch(baseFetch: FetchLike = fetch): DataCassetteRecorder {
  const entries: Record<string, DataCassetteEntry> = {};
  return {
    cassette: () => ({ entries }),
    fetch: async (input, init) => {
      const key = pinnedCrumb(await dataCassetteKey(input, init));
      const response = await baseFetch(input, init);
      const body = await response.clone().text();
      entries[key] = {
        status: response.status,
        headers: storedHeaders(response.headers),
        body,
      };
      return response;
    },
  };
}
