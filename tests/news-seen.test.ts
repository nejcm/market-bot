import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { legacyMarketOverviewCommand } from "./support/commands";
import {
  filterSeenNewsSources,
  NEWS_SEEN_GRACE_MS,
  readNewsSeenEntries,
  recordSeenNewsSources,
} from "../src/sources/news-seen";
import { newsSource } from "./support/fixtures";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempSeenPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "news-seen-test-"));
  tmpDirs.push(dir);
  return join(dir, "news-seen.json");
}

describe("news seen index", () => {
  test("records attached news and preserves first-seen metadata on update", async () => {
    const path = tempSeenPath();

    await recordSeenNewsSources({
      path,
      retentionDays: 30,
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      runId: "run-1",
      seenAt: "2026-05-01T00:00:00.000Z",
      sources: [
        newsSource({
          title: "First title",
          url: "https://www.example.test/story?utm_source=feed",
          provider: "yahoo-news",
        }),
      ],
    });
    await recordSeenNewsSources({
      path,
      retentionDays: 30,
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      runId: "run-2",
      seenAt: "2026-05-02T00:00:00.000Z",
      sources: [
        newsSource({
          title: "Updated title",
          url: "https://example.test/story",
          provider: "marketaux",
        }),
      ],
    });

    const entries = await readNewsSeenEntries(path);

    expect(entries).toEqual([
      {
        lane: "market-overview:equity",
        canonicalUrl: "https://example.test/story",
        title: "Updated title",
        provider: "marketaux",
        firstRunId: "run-1",
        lastRunId: "run-2",
        firstSeenAt: "2026-05-01T00:00:00.000Z",
        lastSeenAt: "2026-05-02T00:00:00.000Z",
      },
    ]);
  });

  test("concurrent records keep each other's entries", async () => {
    const path = tempSeenPath();
    const record = (runId: string, url: string) =>
      recordSeenNewsSources({
        path,
        retentionDays: 30,
        command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
        runId,
        seenAt: "2026-05-01T00:00:00.000Z",
        sources: [newsSource({ title: runId, url })],
      });

    await Promise.all([
      record("run-a", "https://example.test/a"),
      record("run-b", "https://example.test/b"),
    ]);

    const entries = await readNewsSeenEntries(path);
    expect(entries.map((entry) => entry.lastRunId).toSorted()).toEqual(["run-a", "run-b"]);
  });

  test("prunes expired entries while recording fresh news", async () => {
    const path = tempSeenPath();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        entries: [
          {
            lane: "daily:equity",
            canonicalUrl: "https://example.test/old",
            title: "Old story",
            firstRunId: "old-run",
            lastRunId: "old-run",
            firstSeenAt: "2026-04-01T00:00:00.000Z",
            lastSeenAt: "2026-04-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );

    await recordSeenNewsSources({
      path,
      retentionDays: 30,
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      runId: "run-1",
      seenAt: "2026-05-15T00:00:00.000Z",
      sources: [newsSource({ url: "https://example.test/new" })],
    });

    const entries = await readNewsSeenEntries(path);

    expect(entries.map((entry) => entry.canonicalUrl)).toEqual(["https://example.test/new"]);
    expect(readdirSync(dirname(path)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  test("does not suppress a repeat first sighted within the grace window", async () => {
    const path = tempSeenPath();
    const command = legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" });
    await recordSeenNewsSources({
      path,
      retentionDays: 30,
      command,
      runId: "run-1",
      seenAt: "2026-05-20T11:00:00.000Z",
      sources: [newsSource({ title: "Same-day story", url: "https://example.test/same-day" })],
    });

    const result = await filterSeenNewsSources(
      [newsSource({ title: "Same-day story", url: "https://example.test/same-day" })],
      {
        path,
        retentionDays: 30,
        command,
        now: new Date("2026-05-20T12:00:00.000Z"),
        graceMs: NEWS_SEEN_GRACE_MS,
      },
    );

    expect(result.newsSources).toHaveLength(1);
    expect(result.graceExemptedNewsSourceCount).toBe(1);
    expect(result.sourceGaps).toEqual([]);
  });

  test("suppresses a repeat first seen 25 h ago but re-seen 1 h ago", async () => {
    const path = tempSeenPath();
    const command = legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" });
    const repeated = newsSource({ title: "Daily repeat", url: "https://example.test/daily" });
    const fresh = newsSource({ title: "New story", url: "https://example.test/new" });

    await recordSeenNewsSources({
      path,
      retentionDays: 30,
      command,
      runId: "run-1",
      seenAt: "2026-05-19T11:00:00.000Z",
      sources: [repeated],
    });
    await recordSeenNewsSources({
      path,
      retentionDays: 30,
      command,
      runId: "run-2",
      seenAt: "2026-05-20T11:00:00.000Z",
      sources: [repeated],
    });

    const result = await filterSeenNewsSources([repeated, fresh], {
      path,
      retentionDays: 30,
      command,
      now: new Date("2026-05-20T12:00:00.000Z"),
      graceMs: NEWS_SEEN_GRACE_MS,
    });

    expect(result.newsSources.map((source) => source.title)).toEqual(["New story"]);
    expect(result.graceExemptedNewsSourceCount).toBe(0);
  });

  test("treats a repeat first sighted exactly at the grace boundary as suppressed", async () => {
    const path = tempSeenPath();
    const command = legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" });
    const now = new Date("2026-05-20T12:00:00.000Z");
    const atBoundary = newsSource({
      title: "Boundary story",
      url: "https://example.test/boundary",
    });
    const justInside = newsSource({ title: "Inside story", url: "https://example.test/inside" });
    await recordSeenNewsSources({
      path,
      retentionDays: 30,
      command,
      runId: "run-1",
      seenAt: new Date(now.getTime() - NEWS_SEEN_GRACE_MS).toISOString(),
      sources: [atBoundary],
    });
    await recordSeenNewsSources({
      path,
      retentionDays: 30,
      command,
      runId: "run-2",
      seenAt: new Date(now.getTime() - NEWS_SEEN_GRACE_MS + 1).toISOString(),
      sources: [justInside],
    });

    const result = await filterSeenNewsSources([atBoundary, justInside], {
      path,
      retentionDays: 30,
      command,
      now,
      graceMs: NEWS_SEEN_GRACE_MS,
    });

    expect(result.newsSources.map((source) => source.title)).toEqual(["Inside story"]);
    expect(result.graceExemptedNewsSourceCount).toBe(1);
  });

  test("keeps suppression and grace scoped to the command lane", async () => {
    const path = tempSeenPath();
    const equityCommand = legacyMarketOverviewCommand("daily", {
      assetClass: "equity",
      depth: "brief",
    });
    const cryptoCommand = legacyMarketOverviewCommand("daily", {
      assetClass: "crypto",
      depth: "brief",
    });
    const source = newsSource({
      title: "Lane story",
      url: "https://example.test/lane",
      assetClass: "crypto",
    });
    await recordSeenNewsSources({
      path,
      retentionDays: 30,
      command: cryptoCommand,
      runId: "run-1",
      seenAt: "2026-05-20T11:00:00.000Z",
      sources: [source],
    });

    const result = await filterSeenNewsSources([source], {
      path,
      retentionDays: 30,
      command: equityCommand,
      now: new Date("2026-05-20T12:00:00.000Z"),
      graceMs: NEWS_SEEN_GRACE_MS,
    });

    expect(result.newsSources).toHaveLength(1);
    expect(result.graceExemptedNewsSourceCount).toBe(0);
  });
});
