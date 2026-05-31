import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { readNewsSeenEntries, recordSeenNewsSources } from "../src/sources/news-seen";
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
      command: { jobType: "daily", assetClass: "equity", depth: "brief" },
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
      command: { jobType: "daily", assetClass: "equity", depth: "brief" },
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
        lane: "daily:equity",
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
      command: { jobType: "daily", assetClass: "equity", depth: "brief" },
      runId: "run-1",
      seenAt: "2026-05-15T00:00:00.000Z",
      sources: [newsSource({ url: "https://example.test/new" })],
    });

    const entries = await readNewsSeenEntries(path);

    expect(entries.map((entry) => entry.canonicalUrl)).toEqual(["https://example.test/new"]);
    expect(readdirSync(dirname(path)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });
});
