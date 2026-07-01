import { canonicalRequestUrl } from "../../../src/sources/cache";
import type { FetchLike } from "../../../src/sources/types";

export interface DataCassetteEntry {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
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

export function makeReplayFetch(cassette: DataCassette): FetchLike {
  return async (input, init) => {
    const key = await dataCassetteKey(input, init);
    const entry = cassette.entries[key];
    if (entry === undefined) {
      throw new Error(`Fixture data cassette miss: ${key}`);
    }
    return new Response(entry.body, {
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
      const key = await dataCassetteKey(input, init);
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
