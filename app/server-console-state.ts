import { existsSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../src/guards";
import {
  addPin,
  addWatchlistItem,
  createWatchlist,
  deleteWatchlist,
  getNote,
  getWatchlist,
  listPins,
  listWatchlistItems,
  listWatchlistIdsContaining,
  listWatchlists,
  putNote,
  removePin,
  removeWatchlistItem,
  renameWatchlist,
  reorderWatchlistItems,
  withConsoleDb,
} from "./console-db";
import { isSameOriginPost } from "./same-origin";
import { RUN_NOTE_MAX_LENGTH, type NoteKind, type Pin, type WatchlistSummary } from "./types";
import { readWatchlistDetail } from "./watchlists";
import {
  INSTRUMENT_SYMBOL_PATTERN,
  jsonResponse,
  decodePathname,
  isAssetClass,
  readRequestJson,
} from "./server-http";

const CONSOLE_KEY_MAX_LENGTH = 200;

function parseConsoleTarget(
  value: unknown,
): { readonly kind: NoteKind; readonly key: string } | undefined {
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
    key.length > CONSOLE_KEY_MAX_LENGTH ||
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

function readPins(dbPath: string, dataDir: string): readonly Pin[] {
  // Absent DB reads empty without creating the file or its directory.
  if (!existsSync(dbPath)) {
    return [];
  }
  return withConsoleDb(dbPath, (db) =>
    listPins(db).map((pin) =>
      existsSync(join(dataDir, pin.runId)) ? pin : { ...pin, missing: true },
    ),
  );
}

export async function handlePinRequest(
  request: Request,
  url: URL,
  dbPath: string,
  dataDir: string,
): Promise<Response | undefined> {
  if (url.pathname !== "/api/pins") {
    return undefined;
  }
  if (request.method === "GET") {
    try {
      return jsonResponse({ pins: readPins(dbPath, dataDir) });
    } catch (error: unknown) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }
  if (request.method !== "PUT" && request.method !== "DELETE") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }
  if (!isSameOriginPost(request, url)) {
    return jsonResponse({ error: "Pin request origin is not allowed" }, 403);
  }
  let value: unknown = undefined;
  try {
    value = await readRequestJson(request);
  } catch {
    return jsonResponse({ error: "Request body must be JSON" }, 400);
  }
  const target = parseConsoleTarget({
    kind: "run",
    key: isRecord(value) ? value.runId : undefined,
  });
  if (target === undefined) {
    return jsonResponse({ error: "Invalid pin request" }, 400);
  }
  try {
    if (request.method === "PUT") {
      return jsonResponse(withConsoleDb(dbPath, (db) => addPin(db, target.key)));
    }
    return jsonResponse(withConsoleDb(dbPath, (db) => ({ removed: removePin(db, target.key) })));
  } catch (error: unknown) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

export async function handleNoteRequest(
  request: Request,
  url: URL,
  dbPath: string,
): Promise<Response | undefined> {
  if (url.pathname !== "/api/notes") {
    return undefined;
  }
  if (request.method !== "GET" && request.method !== "PUT") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }
  if (request.method === "PUT" && !isSameOriginPost(request, url)) {
    return jsonResponse({ error: "Note request origin is not allowed" }, 403);
  }
  let value: unknown = undefined;
  try {
    value =
      request.method === "GET"
        ? { kind: url.searchParams.get("kind"), key: url.searchParams.get("key") }
        : await readRequestJson(request);
  } catch {
    return jsonResponse({ error: "Request body must be JSON" }, 400);
  }
  const target = parseConsoleTarget(value);
  const body = isRecord(value) ? value.body : undefined;
  if (target === undefined) {
    return jsonResponse({ error: "Invalid note request" }, 400);
  }
  try {
    if (request.method === "GET") {
      return jsonResponse({
        note: existsSync(dbPath)
          ? withConsoleDb(dbPath, (db) => getNote(db, target.kind, target.key))
          : null,
      });
    }
    if (typeof body !== "string" || body.length > RUN_NOTE_MAX_LENGTH) {
      return jsonResponse({ error: "Invalid note request" }, 400);
    }
    return jsonResponse({
      note: withConsoleDb(dbPath, (db) => putNote(db, target.kind, target.key, body)),
    });
  } catch (error: unknown) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

const WATCHLIST_NAME_MAX_LENGTH = 100;

function parseWatchlistId(raw: string): number | undefined {
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    return undefined;
  }
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : undefined;
}

function parseWatchlistName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const name = value.trim();
  return name === "" || name.length > WATCHLIST_NAME_MAX_LENGTH ? undefined : name;
}

function parseWatchlistInstrument(
  value: unknown,
): { readonly assetClass: string; readonly symbol: string } | undefined {
  if (
    !isRecord(value) ||
    value.assetClass !== "equity" ||
    typeof value.symbol !== "string" ||
    !INSTRUMENT_SYMBOL_PATTERN.test(value.symbol.trim().toUpperCase())
  ) {
    return undefined;
  }
  return { assetClass: "equity", symbol: value.symbol.trim().toUpperCase() };
}

function readWatchlists(
  dbPath: string,
  member: { readonly assetClass: string; readonly symbol: string } | undefined,
): { readonly watchlists: readonly WatchlistSummary[]; readonly memberIds?: readonly number[] } {
  // Absent DB reads empty without creating the file or its directory.
  if (!existsSync(dbPath)) {
    return member === undefined ? { watchlists: [] } : { watchlists: [], memberIds: [] };
  }
  return withConsoleDb(dbPath, (db) => ({
    watchlists: listWatchlists(db),
    ...(member === undefined
      ? {}
      : { memberIds: listWatchlistIdsContaining(db, member.assetClass, member.symbol) }),
  }));
}

export async function handleWatchlistRequest(
  request: Request,
  url: URL,
  dbPath: string,
  dataDir: string,
): Promise<Response | undefined> {
  if (url.pathname === "/api/watchlists") {
    if (request.method === "GET") {
      const symbol = url.searchParams.get("symbol");
      const member =
        symbol === null ? undefined : parseWatchlistInstrument({ assetClass: "equity", symbol });
      if (symbol !== null && member === undefined) {
        return jsonResponse({ error: "Invalid watchlist request" }, 400);
      }
      try {
        return jsonResponse(readWatchlists(dbPath, member));
      } catch (error: unknown) {
        return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }
    if (request.method === "POST") {
      if (!isSameOriginPost(request, url)) {
        return jsonResponse({ error: "Watchlist request origin is not allowed" }, 403);
      }
      let name: string | undefined = undefined;
      try {
        const body = await readRequestJson(request);
        name = isRecord(body) ? parseWatchlistName(body.name) : undefined;
      } catch (error: unknown) {
        return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
      if (name === undefined) {
        return jsonResponse({ error: "Invalid watchlist request" }, 400);
      }
      try {
        return jsonResponse(withConsoleDb(dbPath, (db) => createWatchlist(db, name)));
      } catch (error: unknown) {
        return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const listMatch = /^\/api\/watchlists\/([0-9]+)$/u.exec(url.pathname);
  if (listMatch !== null) {
    const id = parseWatchlistId(listMatch[1] ?? "");
    if (id === undefined) {
      return jsonResponse({ error: "Invalid watchlist request" }, 400);
    }
    if (request.method === "GET") {
      try {
        const watchlist = await readWatchlistDetail(dataDir, dbPath, id);
        return watchlist === undefined
          ? jsonResponse({ error: "Watchlist not found" }, 404)
          : jsonResponse({ watchlist });
      } catch (error: unknown) {
        return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }
    if (request.method === "PUT" || request.method === "DELETE") {
      if (!isSameOriginPost(request, url)) {
        return jsonResponse({ error: "Watchlist request origin is not allowed" }, 403);
      }
      if (request.method === "DELETE") {
        try {
          return jsonResponse(
            withConsoleDb(dbPath, (db) => ({ removed: deleteWatchlist(db, id) })),
          );
        } catch (error: unknown) {
          return jsonResponse(
            { error: error instanceof Error ? error.message : String(error) },
            500,
          );
        }
      }
      let name: string | undefined = undefined;
      try {
        const body = await readRequestJson(request);
        name = isRecord(body) ? parseWatchlistName(body.name) : undefined;
      } catch (error: unknown) {
        return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
      if (name === undefined) {
        return jsonResponse({ error: "Invalid watchlist request" }, 400);
      }
      try {
        const renamed = withConsoleDb(dbPath, (db) => {
          if (getWatchlist(db, id) === undefined) {
            return undefined;
          }
          renameWatchlist(db, id, name);
          return getWatchlist(db, id);
        });
        return renamed === undefined
          ? jsonResponse({ error: "Watchlist not found" }, 404)
          : jsonResponse(renamed);
      } catch (error: unknown) {
        return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const itemsMatch = /^\/api\/watchlists\/([0-9]+)\/items(?:\/([^/]+)\/([^/]+))?$/u.exec(
    url.pathname,
  );
  if (itemsMatch !== null) {
    const id = parseWatchlistId(itemsMatch[1] ?? "");
    if (id === undefined) {
      return jsonResponse({ error: "Invalid watchlist request" }, 400);
    }
    if (itemsMatch[2] === undefined) {
      if (request.method !== "PUT") {
        return jsonResponse({ error: "Method not allowed" }, 405);
      }
      if (!isSameOriginPost(request, url)) {
        return jsonResponse({ error: "Watchlist request origin is not allowed" }, 403);
      }
      let item: { readonly assetClass: string; readonly symbol: string } | undefined = undefined;
      try {
        const body = await readRequestJson(request);
        item = isRecord(body) ? parseWatchlistInstrument(body) : undefined;
      } catch (error: unknown) {
        return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
      if (item === undefined) {
        return jsonResponse({ error: "Invalid watchlist request" }, 400);
      }
      try {
        const added = withConsoleDb(dbPath, (db) => {
          if (getWatchlist(db, id) === undefined) {
            return undefined;
          }
          return addWatchlistItem(db, id, item.assetClass, item.symbol);
        });
        return added === undefined
          ? jsonResponse({ error: "Watchlist not found" }, 404)
          : jsonResponse({ item: added });
      } catch (error: unknown) {
        return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }
    const rawAssetClass = decodePathname(itemsMatch[2]);
    const symbol = decodePathname(itemsMatch[3] ?? "")?.toUpperCase();
    if (
      rawAssetClass === undefined ||
      symbol === undefined ||
      parseWatchlistInstrument({ assetClass: rawAssetClass, symbol }) === undefined
    ) {
      return jsonResponse({ error: "Invalid watchlist request" }, 400);
    }
    if (request.method !== "DELETE") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }
    if (!isSameOriginPost(request, url)) {
      return jsonResponse({ error: "Watchlist request origin is not allowed" }, 403);
    }
    try {
      return jsonResponse(
        withConsoleDb(dbPath, (db) => ({
          removed: removeWatchlistItem(db, id, rawAssetClass, symbol),
        })),
      );
    } catch (error: unknown) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  const orderMatch = /^\/api\/watchlists\/([0-9]+)\/order$/u.exec(url.pathname);
  if (orderMatch !== null) {
    const id = parseWatchlistId(orderMatch[1] ?? "");
    if (id === undefined) {
      return jsonResponse({ error: "Invalid watchlist request" }, 400);
    }
    if (request.method !== "PUT") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }
    if (!isSameOriginPost(request, url)) {
      return jsonResponse({ error: "Watchlist request origin is not allowed" }, 403);
    }
    let ordered: readonly { readonly assetClass: string; readonly symbol: string }[] = [];
    try {
      const body = await readRequestJson(request);
      const rawItems = isRecord(body) ? body.items : undefined;
      if (!Array.isArray(rawItems)) {
        return jsonResponse({ error: "Invalid watchlist request" }, 400);
      }
      const parsed = rawItems.map((item) => parseWatchlistInstrument(item));
      if (parsed.some((item) => item === undefined)) {
        return jsonResponse({ error: "Invalid watchlist request" }, 400);
      }
      ordered = parsed as readonly { readonly assetClass: string; readonly symbol: string }[];
    } catch (error: unknown) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    const items = ordered;
    try {
      const reordered = withConsoleDb(dbPath, (db) => {
        if (getWatchlist(db, id) === undefined) {
          return undefined;
        }
        const existing = listWatchlistItems(db, id).map(
          (item) => `${item.assetClass}:${item.symbol}`,
        );
        const requested = items.map((item) => `${item.assetClass}:${item.symbol}`);
        if (
          existing.length !== requested.length ||
          new Set(requested).size !== requested.length ||
          requested.some((key) => !existing.includes(key))
        ) {
          return false;
        }
        reorderWatchlistItems(db, id, items);
        return true;
      });
      if (reordered === undefined) {
        return jsonResponse({ error: "Watchlist not found" }, 404);
      }
      return reordered
        ? jsonResponse({ reordered: true })
        : jsonResponse({ error: "Reorder must include every watchlist item exactly once" }, 400);
    } catch (error: unknown) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  return undefined;
}
