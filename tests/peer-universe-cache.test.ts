import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makePeerUniverseCacheReader,
  makePeerUniverseCacheWriter,
  makePeerUniverseEvaluationRecorder,
  makePeerUniverseRefreshClaimer,
  makePeerUniverseRefreshReleaser,
} from "../src/research/peer-universe-cache";
import {
  resolvePeerUniverseWithFallback,
  type PeerUniverse,
  type ProposalAudit,
} from "../src/research/peer-universe";
import { createPeerUniverseProposer } from "../src/research/peer-universe-proposal";

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
    expect(result?.universe?.provenance).toBe("model-proposed-validated");
    expect(result?.universe?.peers.map((p) => p.symbol)).toEqual(["AAPL", "MSFT", "GOOGL"]);
    expect(result?.refresh).toBe("not-needed");
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
    expect(await read("ZZZZ")).toMatchObject({ refresh: "due" });
    expect((await read("ZZZZ"))?.universe).toBeUndefined();
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
    expect(await read("ZZZZ")).toMatchObject({ refresh: "due" });
    expect((await read("ZZZZ"))?.universe).toBeUndefined();
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
    const first = await write("ZZZZ", universe("ZZZZ"), audit);
    await write("AAAA", universe("AAAA"), audit);
    await write("ZZZZ", universe("ZZZZ"), { ...audit, survived: 4 }, first);

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

describe("peer universe refresh policy", () => {
  const day0 = new Date("2026-10-07T00:00:00.000Z");
  const day1 = new Date("2026-10-08T00:00:00.000Z");
  const day2 = new Date("2026-10-09T00:00:00.000Z");
  const oldGeneration = "2020-01-01T00:00:00.000Z";

  const write = (now: Date, observed?: string, survived = 3) =>
    makePeerUniverseCacheWriter(cachePath, 90, "p", now)(
      "ZZZZ",
      universe("ZZZZ"),
      { ...audit, survived },
      observed,
    );
  const record = (now: Date, generation: string, usablePeerCount: number) =>
    makePeerUniverseEvaluationRecorder(cachePath, now)("ZZZZ", generation, usablePeerCount);
  const claim = (now: Date, generation: string) =>
    makePeerUniverseRefreshClaimer(cachePath, 90, now)("ZZZZ", generation);
  const refreshAt = async (now: Date) =>
    (await makePeerUniverseCacheReader(cachePath, 90, now)("ZZZZ"))?.refresh;

  async function seed(): Promise<string> {
    const generation = await write(day0);
    if (generation === undefined) {
      throw new Error("seed write skipped");
    }
    return generation;
  }

  async function storedEntry(): Promise<Record<string, unknown> | undefined> {
    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as {
      entries: Record<string, unknown>[];
    };
    return parsed.entries.find((entry) => entry.targetSymbol === "ZZZZ");
  }

  test("an unevaluated entry needs no refresh, matching the pre-change cache files", async () => {
    await seed();
    expect(await refreshAt(day1)).toBe("not-needed");
  });

  test("feedback below MIN_USABLE_PEERS makes the next read due; at the threshold it does not", async () => {
    const generation = await seed();
    await record(day0, generation, 3);
    expect(await refreshAt(day1)).toBe("not-needed");
    await record(day1, generation, 2);
    const read = await makePeerUniverseCacheReader(cachePath, 90, day2)("ZZZZ");
    expect(read?.refresh).toBe("due");
    expect(read?.generation).toBe(generation);
  });

  test("feedback for a superseded generation is ignored", async () => {
    await seed();
    await record(day1, oldGeneration, 0);
    expect((await storedEntry())?.evaluation).toBeUndefined();
  });

  test("older feedback never overwrites newer feedback in either direction", async () => {
    const generation = await seed();
    await record(day2, generation, 0);
    await record(day1, generation, 3);
    expect((await storedEntry())?.evaluation).toEqual({
      usablePeerCount: 0,
      evaluatedAt: day2.toISOString(),
    });
    await record(day2, generation, 3);
    await record(day1, generation, 0);
    expect((await storedEntry())?.evaluation).toMatchObject({ usablePeerCount: 3 });
  });

  test("only one concurrent claim wins and a failed refresh keeps the allowance consumed", async () => {
    const generation = await seed();
    await record(day0, generation, 0);
    const claims = await Promise.all([claim(day1, generation), claim(day1, generation)]);
    expect(claims.toSorted()).toEqual([false, true]);
    expect(await storedEntry()).toMatchObject({
      proposedAt: generation,
      windowStartedAt: generation,
      refreshAttemptedAt: day1.toISOString(),
    });
    expect(await refreshAt(day2)).toBe("used");
  });

  test("a refresh replacement carries the window and still allows no second refresh", async () => {
    const generation = await seed();
    await record(day0, generation, 0);
    await claim(day1, generation);
    const next = await write(day1, generation);
    expect(next).toBe(day1.toISOString());
    expect(await storedEntry()).toMatchObject({
      windowStartedAt: generation,
      refreshAttemptedAt: day1.toISOString(),
    });
    expect((await storedEntry())?.evaluation).toBeUndefined();
    await record(day1, day1.toISOString(), 0);
    expect(await refreshAt(day2)).toBe("used");
  });

  test("a write against a superseded generation is skipped", async () => {
    await seed();
    expect(await write(day1, oldGeneration, 9)).toBeUndefined();
    expect((await storedEntry())?.proposedAt).toBe(day0.toISOString());
  });

  test("a write over an expired generation survives a concurrent prune by another symbol", async () => {
    const generation = await seed();
    const day91 = new Date(day0.getTime() + 91 * 86_400_000);
    await makePeerUniverseCacheWriter(cachePath, 90, "p", day91)("AAAA", universe("AAAA"), audit);
    expect(await storedEntry()).toBeUndefined();

    expect(await write(day91, generation)).toBe(day91.toISOString());
    expect((await storedEntry())?.proposedAt).toBe(day91.toISOString());
  });

  test("a delayed cache-miss write cannot overwrite a newer refresh", async () => {
    const generation = await seed();
    await record(day0, generation, 0);
    await claim(day1, generation);
    await write(day1, generation);
    expect(await write(day2, undefined, 9)).toBeUndefined();
    expect((await storedEntry())?.proposedAt).toBe(day1.toISOString());
  });

  test("a claim is refused once newer feedback shows enough usable peers", async () => {
    const generation = await seed();
    await record(day0, generation, 0);
    await record(day1, generation, 3);
    expect(await claim(day2, generation)).toBe(false);
  });

  test("an expired entry stays due every run and is never claimable", async () => {
    const generation = await seed();
    const day91 = new Date(day0.getTime() + 91 * 86_400_000);
    const day92 = new Date(day0.getTime() + 92 * 86_400_000);
    expect(await refreshAt(day91)).toBe("due");
    expect(await claim(day91, generation)).toBe(false);
    expect(await refreshAt(day92)).toBe("due");
    expect(await storedEntry()).not.toHaveProperty("refreshAttemptedAt");
  });

  test("the allowance returns once the TTL window anchor expires", async () => {
    const generation = await seed();
    await record(day0, generation, 0);
    await claim(day1, generation);
    const refreshed = (await write(day1, generation)) ?? "";
    await record(day1, refreshed, 1);
    const afterWindow = new Date(day0.getTime() + 90.5 * 86_400_000);
    expect(await refreshAt(afterWindow)).toBe("due");
    expect(await claim(afterWindow, refreshed)).toBe(true);
    expect((await storedEntry())?.windowStartedAt).toBe(afterWindow.toISOString());
  });

  test("feedback on one symbol keeps a concurrently written symbol", async () => {
    const generation = await seed();
    await Promise.all([
      record(day1, generation, 1),
      makePeerUniverseCacheWriter(cachePath, 90, "p", day1)("AAAA", universe("AAAA"), audit),
    ]);
    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as {
      entries: { targetSymbol: string; evaluation?: { usablePeerCount: number } }[];
    };
    expect(parsed.entries.map((e) => e.targetSymbol)).toEqual(["AAAA", "ZZZZ"]);
    expect(parsed.entries[1]?.evaluation?.usablePeerCount).toBe(1);
  });

  test("an attempt spent under a superseded proposer revision is granted once more", async () => {
    const generation = await seed();
    await record(day0, generation, 0);
    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as {
      entries: Record<string, unknown>[];
    };
    await writeFile(
      cachePath,
      JSON.stringify({
        ...parsed,
        entries: parsed.entries.map((entry) => ({
          ...entry,
          refreshAttemptedAt: day0.toISOString(),
        })),
      }),
      "utf8",
    );
    expect(await refreshAt(day1)).toBe("due");
    expect(await claim(day1, generation)).toBe(true);
    expect(await refreshAt(day2)).toBe("used");
  });

  test("a release returns only this run's claim", async () => {
    const generation = await seed();
    await record(day0, generation, 0);
    await claim(day1, generation);
    expect(await makePeerUniverseRefreshReleaser(cachePath, day2)("ZZZZ", generation)).toBe(false);
    expect(await refreshAt(day2)).toBe("used");
    expect(await makePeerUniverseRefreshReleaser(cachePath, day1)("ZZZZ", generation)).toBe(true);
    expect(await refreshAt(day2)).toBe("due");
  });

  test("an SEC directory outage releases the claim so the next run can refresh", async () => {
    const generation = await seed();
    await record(day0, generation, 0);
    const fallbackAt = (now: Date) => ({
      cacheRead: makePeerUniverseCacheReader(cachePath, 90, now),
      cacheWrite: makePeerUniverseCacheWriter(cachePath, 90, "p", now),
      claimRefresh: makePeerUniverseRefreshClaimer(cachePath, 90, now),
      releaseRefresh: makePeerUniverseRefreshReleaser(cachePath, now),
      propose: createPeerUniverseProposer({
        provider: {
          name: "test",
          generate: async () => {
            throw new Error("model must not run without the directory");
          },
        },
        model: "test-model",
        request: {
          json: async () => ({
            source: "sec-edgar",
            message: "SEC tickers timeout",
            capability: "extended-evidence",
            cause: "fetch-failed",
            evidenceQualityImpact: "extended-evidence-cap",
          }),
          text: async () => {
            throw new Error("listing must not be fetched");
          },
        },
      }),
    });
    const inputs = { marketCap: 450e6, sic: "3661" };

    const outage = await resolvePeerUniverseWithFallback(
      "ZZZZ",
      fallbackAt(day1),
      undefined,
      undefined,
      inputs,
    );

    expect(outage.status).toBe("resolved");
    expect(outage.refresh).toEqual({ outcome: "unavailable", allowanceReleased: true });
    expect(await refreshAt(day2)).toBe("due");
    expect(await claim(day2, generation)).toBe(true);
  });

  test("an older proposer revision cannot reclaim an allowance a newer one consumed", async () => {
    const generation = await seed();
    await record(day0, generation, 0);
    expect(await makePeerUniverseRefreshClaimer(cachePath, 90, day1, 3)("ZZZZ", generation)).toBe(
      true,
    );
    expect((await makePeerUniverseCacheReader(cachePath, 90, day2, 2)("ZZZZ"))?.refresh).toBe(
      "used",
    );
    expect(await makePeerUniverseRefreshClaimer(cachePath, 90, day2, 2)("ZZZZ", generation)).toBe(
      false,
    );
  });

  test("an obsolete claimant cannot publish over or release a newer revision's claim", async () => {
    const generation = await seed();
    await record(day0, generation, 0);
    const day1Later = new Date(day1.getTime() + 1000);
    expect(await makePeerUniverseRefreshClaimer(cachePath, 90, day1, 2)("ZZZZ", generation)).toBe(
      true,
    );
    expect(
      await makePeerUniverseRefreshClaimer(cachePath, 90, day1Later, 3)("ZZZZ", generation),
    ).toBe(true);
    const writeV2 = makePeerUniverseCacheWriter(cachePath, 90, "p", day1, 2);
    expect(await writeV2("ZZZZ", universe("ZZZZ"), audit, generation, true)).toBeUndefined();
    expect(await makePeerUniverseRefreshReleaser(cachePath, day1, 2)("ZZZZ", generation)).toBe(
      false,
    );
    expect(await storedEntry()).toMatchObject({
      proposedAt: generation,
      refreshAttemptedAt: day1Later.toISOString(),
      refreshProposerRevision: 3,
    });
    const writeV3 = makePeerUniverseCacheWriter(cachePath, 90, "p", day1Later, 3);
    expect(await writeV3("ZZZZ", universe("ZZZZ"), audit, generation, true)).toBe(
      day1Later.toISOString(),
    );
  });
});
