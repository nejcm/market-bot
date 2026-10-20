import { existsSync } from "node:fs";
import { readInstrumentWatchlistRows } from "../src/run-artifact-index";
import { getWatchlist, listWatchlistItems, withConsoleDb } from "./console-db";
import type { WatchlistDetail, WatchlistRowState } from "./types";

export async function readWatchlistDetail(
  dataDir: string,
  dbPath: string,
  id: number,
): Promise<WatchlistDetail | undefined> {
  // Absent DB reads empty without creating the file or its directory.
  if (!existsSync(dbPath)) {
    return undefined;
  }
  const stored = withConsoleDb(dbPath, (db) => {
    const watchlist = getWatchlist(db, id);
    if (watchlist === undefined) {
      return undefined;
    }
    return {
      watchlist,
      items: listWatchlistItems(db, id),
    };
  });
  if (stored === undefined) {
    return undefined;
  }

  const rows = await readInstrumentWatchlistRows(
    dataDir,
    stored.items.map(({ assetClass, symbol }) => ({ assetClass, symbol })),
  );
  return {
    ...stored.watchlist,
    items: stored.items.map((item, index) => ({
      ...item,
      row: rows?.[index] ?? ({ state: "index-unavailable" } satisfies WatchlistRowState),
    })),
  };
}
