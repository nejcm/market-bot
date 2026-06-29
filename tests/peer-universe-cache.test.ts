import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makePeerUniverseCacheReader,
  makePeerUniverseCacheWriter,
} from "../src/research/peer-universe-cache";
import type { PeerUniverse, ProposalAudit } from "../src/research/peer-universe";

let dir = "";
let cachePath = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "peer-universe-cache-"));
  cachePath = join(dir, "peer-universe-learned.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function universe(targetSymbol: string): PeerUniverse {
  return {
    targetSymbol,
    provenance: "model-proposed-validated",
    peers: [
      {
        symbol: "AAPL",
        name: "Apple Inc.",
        role: "core",
        rationale: "peer a",
        sourceIds: ["sec-company-tickers"],
      },
      {
        symbol: "MSFT",
        name: "Microsoft",
        role: "core",
        rationale: "peer b",
        sourceIds: ["sec-company-tickers"],
      },
      {
        symbol: "GOOGL",
        name: "Alphabet",
        role: "secondary",
        rationale: "peer c",
        sourceIds: ["sec-company-tickers"],
      },
    ],
    sources: [
      {
        sourceId: "sec-company-tickers",
        title: "SEC company_tickers.json directory",
        url: "https://www.sec.gov/files/company_tickers.json",
      },
    ],
  };
}

const audit: ProposalAudit = {
  proposed: 5,
  survived: 3,
  rejectedByDirectory: 1,
  rejectedByEtf: 1,
  rejectedByListing: 0,
  modelId: "test-model",
};

describe("peer universe cache", () => {
  test("write then read round-trips a validated universe", async () => {
    const write = makePeerUniverseCacheWriter(cachePath, 90, "test-provider");
    await write("ZZZZ", universe("ZZZZ"), audit);

    const read = makePeerUniverseCacheReader(cachePath, 90);
    const result = await read("ZZZZ");

    expect(result).toBeDefined();
    expect(result?.provenance).toBe("model-proposed-validated");
    expect(result?.peers.map((p) => p.symbol)).toEqual(["AAPL", "MSFT", "GOOGL"]);
  });

  test("write rejects a universe for a different target symbol", async () => {
    const write = makePeerUniverseCacheWriter(cachePath, 90, "test-provider");

    await expect(write("ZZZZ", universe("AAAA"), audit)).rejects.toThrow("target mismatch");
  });

  test("write stamps entries with the injected clock", async () => {
    const now = new Date("2026-06-29T12:00:00.000Z");
    const write = makePeerUniverseCacheWriter(cachePath, 90, "test-provider", now);

    await write("ZZZZ", universe("ZZZZ"), audit);

    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as {
      entries: { proposedAt: string }[];
    };
    expect(parsed.entries[0]?.proposedAt).toBe(now.toISOString());
  });

  test("read normalizes symbol case", async () => {
    const write = makePeerUniverseCacheWriter(cachePath);
    await write("zzzz", universe("ZZZZ"), audit);

    const read = makePeerUniverseCacheReader(cachePath);
    expect(await read("ZZZZ")).toBeDefined();
    expect(await read("zzzz")).toBeDefined();
  });

  test("returns undefined on cache miss", async () => {
    const read = makePeerUniverseCacheReader(cachePath);
    expect(await read("NOPE")).toBeUndefined();
  });

  test("drops a stale entry past the TTL", async () => {
    // Write with an old proposedAt by writing then rewinding via a 0-day TTL reader
    const write = makePeerUniverseCacheWriter(cachePath);
    await write("ZZZZ", universe("ZZZZ"), audit);

    // Now is far in the future relative to proposedAt; ttl 90 days exceeded
    const future = new Date(Date.now() + 200 * 86_400_000);
    const read = makePeerUniverseCacheReader(cachePath, 90, future);
    expect(await read("ZZZZ")).toBeUndefined();
  });

  test("drops a poisoned entry that fails validation", async () => {
    // Hand-craft a cache file where a peer cites an unknown sourceId (validation fails).
    const poisoned = {
      version: 1,
      entries: [
        {
          targetSymbol: "ZZZZ",
          provenance: "model-proposed-validated",
          peers: [
            {
              symbol: "AAPL",
              name: "Apple",
              role: "core",
              rationale: "peer",
              sourceIds: ["unknown-source"],
            },
            {
              symbol: "MSFT",
              name: "Microsoft",
              role: "core",
              rationale: "peer",
              sourceIds: ["sec-company-tickers"],
            },
            {
              symbol: "GOOGL",
              name: "Alphabet",
              role: "secondary",
              rationale: "peer",
              sourceIds: ["sec-company-tickers"],
            },
          ],
          sources: [{ sourceId: "sec-company-tickers", title: "SEC directory" }],
          proposedAt: new Date().toISOString(),
          modelId: "test-model",
          providerName: "test",
          audit,
        },
      ],
    };
    await writeFile(cachePath, JSON.stringify(poisoned, null, 2), "utf8");

    const read = makePeerUniverseCacheReader(cachePath);
    expect(await read("ZZZZ")).toBeUndefined();
  });

  test("rejects an unknown schema version", async () => {
    await writeFile(cachePath, JSON.stringify({ version: 99, entries: [] }), "utf8");
    const read = makePeerUniverseCacheReader(cachePath);
    expect(await read("ZZZZ")).toBeUndefined();
  });

  test("returns undefined for a missing or malformed file", async () => {
    const read = makePeerUniverseCacheReader(join(dir, "does-not-exist.json"));
    expect(await read("ZZZZ")).toBeUndefined();

    await writeFile(cachePath, "not json", "utf8");
    expect(await makePeerUniverseCacheReader(cachePath)("ZZZZ")).toBeUndefined();
  });

  test("write upserts by symbol and sorts entries for stable diffs", async () => {
    const write = makePeerUniverseCacheWriter(cachePath);
    await write("ZZZZ", universe("ZZZZ"), audit);
    await write("AAAA", universe("AAAA"), audit);
    await write("ZZZZ", universe("ZZZZ"), { ...audit, survived: 4 });

    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as {
      entries: { targetSymbol: string; audit: { survived: number } }[];
    };

    expect(parsed.entries.map((e) => e.targetSymbol)).toEqual(["AAAA", "ZZZZ"]);
    expect(parsed.entries.find((e) => e.targetSymbol === "ZZZZ")?.audit.survived).toBe(4);
  });

  test("write prunes stale entries on upsert", async () => {
    // Seed a stale entry by hand, then upsert a fresh one with a short TTL writer.
    const stale = {
      version: 1,
      entries: [
        {
          ...universe("OLD"),
          targetSymbol: "OLD",
          proposedAt: new Date(Date.now() - 200 * 86_400_000).toISOString(),
          modelId: "test-model",
          providerName: "test",
          audit,
        },
      ],
    };
    await writeFile(cachePath, JSON.stringify(stale, null, 2), "utf8");

    const write = makePeerUniverseCacheWriter(cachePath, 90);
    await write("NEW", universe("NEW"), audit);

    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as {
      entries: { targetSymbol: string }[];
    };
    expect(parsed.entries.map((e) => e.targetSymbol)).toEqual(["NEW"]);
  });
});
