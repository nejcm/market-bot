import { readRecordedBody } from "./body-file";
import { canonicalRequestUrl, isCredentialQueryParam } from "../sources/cache";
import type { FetchLike } from "../sources/types";

export interface DataCassetteEntry {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly bodyFile?: string;
  readonly sha256?: string;
  readonly error?: string;
  readonly errorName?: string;
  readonly sequence?: readonly DataCassetteEntry[];
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
  let url = "";
  if (typeof input === "string") {
    url = input;
  } else {
    url = input instanceof URL ? input.href : input.url;
  }
  const parsed = URL.parse(url);
  if (parsed === null) {
    return url;
  }
  for (const key of new Set(parsed.searchParams.keys())) {
    if (isCredentialQueryParam(key)) {
      parsed.searchParams.delete(key);
    }
  }
  return parsed.href;
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

// Yahoo mints a fresh crumb per credential fetch, so record and replay pin it to one placeholder;
// Replay tries the exact key first, then the pinned one (see docs/testing.md).
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
  return readRecordedBody(fixtureDir, entry.bodyFile, entry.sha256);
}

export function makeReplayFetch(cassette: DataCassette, fixtureDir?: string): FetchLike {
  const indexes = new Map<string, number>();
  return async (input, init) => {
    const exactKey = await dataCassetteKey(input, init);
    const key = cassette.entries[exactKey] === undefined ? pinnedCrumb(exactKey) : exactKey;
    const recorded = cassette.entries[key];
    const index = indexes.get(key) ?? 0;
    const entry = recorded?.sequence === undefined ? recorded : recorded.sequence[index];
    if (entry === undefined) {
      throw new Error(`Fixture data cassette miss: ${key}`);
    }
    indexes.set(key, index + 1);
    if (entry.error !== undefined) {
      const error = new Error(entry.error);
      error.name = entry.errorName ?? "Error";
      throw error;
    }
    return new Response(await replayBody(entry, fixtureDir), {
      status: entry.status,
      headers: replayHeaders(entry.headers),
    });
  };
}

export function createRecordingFetch(
  baseFetch: FetchLike = fetch,
  redact: (value: string) => string = (value) => value,
  captureFailed: () => void = () => {},
): DataCassetteRecorder {
  const entries: Record<string, DataCassetteEntry> = {};
  const sequences: Record<string, DataCassetteEntry[]> = {};
  return {
    cassette: () => ({ entries }),
    fetch: async (input, init) => {
      let key = "";
      try {
        key = redact(pinnedCrumb(await dataCassetteKey(input, init)));
      } catch {
        captureFailed();
        return baseFetch(input, init);
      }
      const sequence = (sequences[key] ??= []);
      const index = sequence.length;
      sequence.push({ status: 0, headers: {}, body: "", error: "Unfinished HTTP capture" });
      const store = (entry: DataCassetteEntry) => {
        sequence[index] = entry;
        entries[key] = { ...sequence[0]!, sequence };
      };
      const response = await Promise.resolve()
        .then(() => baseFetch(input, init))
        .catch((error: unknown) => {
          store({
            status: 0,
            headers: {},
            body: "",
            error: redact(error instanceof Error ? error.message : "HTTP request failed"),
            errorName: error instanceof Error ? error.name : "Error",
          });
          throw error;
        });
      try {
        store({
          status: response.status,
          headers: Object.fromEntries(
            Object.entries(storedHeaders(response.headers)).map(([name, value]) => [
              name,
              redact(value),
            ]),
          ),
          body: requestUrl(input).includes("/v1/test/getcrumb")
            ? CRUMB_PLACEHOLDER
            : redact(await response.clone().text()),
        });
      } catch {
        captureFailed();
      }
      return response;
    },
  };
}

export function countCassetteMisses(inner: FetchLike, keys: string[]): FetchLike {
  return async (input, init) => {
    try {
      return await inner(input, init);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Fixture data cassette miss: ")) {
        keys.push(error.message.slice("Fixture data cassette miss: ".length));
      }
      throw error;
    }
  };
}
