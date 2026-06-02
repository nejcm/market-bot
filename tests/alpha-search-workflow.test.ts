import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJson } from "../src/artifacts";
import { redactExpiredRedditRawSnapshots } from "../src/alpha-search/raw-retention";
import { readRedditSeenIds } from "../src/alpha-search/reddit-seen";
import { runAlphaSearchWorkflow } from "../src/alpha-search/workflow";
import type { AppConfig } from "../src/config";
import type { FetchLike } from "../src/sources/types";
import { resetSourceResilienceForTests } from "../src/sources/collector";

const dataDirs: string[] = [];

afterEach(async () => {
  resetSourceResilienceForTests();
  await Promise.all(dataDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function dataDir(): string {
  const path = join(
    tmpdir(),
    `market-bot-alpha-workflow-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  dataDirs.push(path);
  return path;
}

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  const dir = dataDir();
  return {
    provider: "openai",
    quickModel: "quick",
    synthesisModel: "synthesis",
    modelTimeoutMs: 120_000,
    dataDir: dir,
    promptDir: "prompts",
    sourceOptions: {
      equityMoverLimit: 3,
      cryptoMoverLimit: 3,
      newsLimit: 3,
      sourceTimeoutMs: 1000,
    },
    evidenceRequestOptions: {
      maxRounds: 0,
      maxToolCalls: 0,
      sourceBudget: 0,
    },
    alphaSearchOptions: {
      redditClientId: "client-id",
      redditClientSecret: "client-secret",
      redditUserAgent: "market-bot test@example.test",
      redditSubreddits: ["stocks"],
      redditLookbackDays: 7,
      redditRawRetentionHours: 48,
      topCandidateLimit: 15,
      redditSeenPath: join(dir, "reddit-seen.json"),
    },
    ...overrides,
  };
}

function jsonResponse(payload: unknown): Response {
  return Response.json(payload);
}

function listingPayload(): unknown {
  return {
    data: {
      after: null,
      children: [
        {
          kind: "t3",
          data: {
            id: "post1",
            name: "t3_post1",
            subreddit: "stocks",
            title: "$AAPL strong quarter, OTCX is noisy",
            selftext: "AAPL growth looks constructive while OTCX is only mentioned.",
            author: "poster",
            created_utc: 1_779_984_000,
            score: 40,
            num_comments: 2,
            permalink: "/r/stocks/comments/post1/aapl/",
          },
        },
      ],
    },
  };
}

function commentsPayload(): unknown {
  return [
    { data: { children: [] } },
    {
      data: {
        children: [
          {
            kind: "t1",
            data: {
              id: "comment1",
              name: "t1_comment1",
              link_id: "t3_post1",
              parent_id: "t3_post1",
              subreddit: "stocks",
              body: "AAPL beat estimates; OTCX is not the ticker under review.",
              author: "commenter",
              created_utc: 1_779_984_100,
              score: 5,
              depth: 0,
            },
          },
        ],
      },
    },
  ];
}

function yahooPayload(): unknown {
  return {
    quoteResponse: {
      result: [
        {
          symbol: "AAPL",
          shortName: "Apple Inc.",
          exchange: "NMS",
          fullExchangeName: "NasdaqGS",
          quoteType: "EQUITY",
          regularMarketPrice: 195.5,
          regularMarketVolume: 55_000_000,
          marketCap: 3_000_000_000_000,
        },
        {
          symbol: "OTCX",
          shortName: "OTC Example",
          exchange: "OTC",
          quoteType: "EQUITY",
          regularMarketPrice: 2,
          regularMarketVolume: 1000,
        },
      ],
    },
  };
}

function fetchImpl(requestedUrls: string[]): FetchLike {
  return async (input) => {
    const url = String(input);
    requestedUrls.push(url);

    if (url.includes("/api/v1/access_token")) {
      return jsonResponse({ access_token: "token" });
    }
    if (url.includes("/r/stocks/new")) {
      return jsonResponse(listingPayload());
    }
    if (url.includes("/comments/post1.json")) {
      return jsonResponse(commentsPayload());
    }
    if (url.includes("query1.finance.yahoo.com")) {
      return jsonResponse(yahooPayload());
    }

    return new Response("not found", { status: 404 });
  };
}

describe("alpha-search workflow", () => {
  test("persists Reddit-ranked Yahoo-validated research leads without predictions", async () => {
    const requestedUrls: string[] = [];
    const cfg = config();
    const result = await runAlphaSearchWorkflow({
      command: { jobType: "alpha-search", assetClass: "equity", depth: "brief" },
      config: cfg,
      now: new Date("2026-06-01T00:00:00.000Z"),
      fetchImpl: fetchImpl(requestedUrls),
      retryDelaysMs: [],
    });

    await expect(readdir(result.artifacts.runDir)).resolves.toEqual(
      expect.arrayContaining(["normalized", "raw", "report.json", "report.md", "trace.json"]),
    );
    await expect(readdir(result.artifacts.normalizedDir)).resolves.toEqual(
      expect.arrayContaining([
        "reddit-candidates.json",
        "rejected-candidates.json",
        "research-leads.json",
        "source-gaps.json",
      ]),
    );

    expect(result.report.jobType).toBe("alpha-search");
    expect(result.report.predictions).toEqual([]);
    expect(result.report.extras?.researchLeads).toEqual([
      expect.objectContaining({
        symbol: "AAPL",
        name: "Apple Inc.",
        redditRank: 1,
        mentionCount: 3,
      }),
    ]);
    expect(result.report.extras?.rejectedCandidates).toEqual([
      expect.objectContaining({
        symbol: "OTCX",
        reason: "OTC or pink-sheet instrument",
        sourceIds: ["t3_post1", "t1_comment1"],
      }),
    ]);
    expect(result.markdown).toContain("## Research Leads");
    expect(result.markdown).toContain("## Rejected Candidates");
    expect(result.markdown).toContain("[t3_post1] [t1_comment1]");
    expect(result.markdown).not.toContain("## Predictions");
    expect(result.markdown).toContain("Research-only note");
    expect(requestedUrls.some((url) => url.includes("symbols=AAPL%2COTCX"))).toBe(true);

    const seenIds = await readRedditSeenIds(cfg.alphaSearchOptions.redditSeenPath);
    expect(seenIds.has("post1")).toBe(true);
    expect(seenIds.has("t3_post1")).toBe(true);

    const reportJson = JSON.parse(
      await readFile(join(result.artifacts.runDir, "report.json"), "utf8"),
    ) as { readonly jobType?: string; readonly predictions?: readonly unknown[] };
    expect(reportJson.jobType).toBe("alpha-search");
    expect(reportJson.predictions).toEqual([]);
  });

  test("redacts expired Reddit raw snapshots only", async () => {
    const dir = dataDir();
    const rawDir = join(dir, "old-run", "raw");
    await mkdir(rawDir, { recursive: true });
    await writeJson(join(rawDir, "snapshots.json"), [
      {
        id: "raw-reddit-old",
        adapter: "reddit",
        fetchedAt: "2026-05-29T00:00:00.000Z",
        payload: { data: { children: [{ data: { selftext: "raw text" } }] } },
      },
      {
        id: "raw-yahoo-old",
        adapter: "yahoo-alpha-search",
        fetchedAt: "2026-05-29T00:00:00.000Z",
        payload: { quoteResponse: { result: [] } },
      },
    ]);

    await expect(
      redactExpiredRedditRawSnapshots({
        dataDir: dir,
        retentionHours: 48,
        now: new Date("2026-06-01T00:00:00.000Z"),
      }),
    ).resolves.toBe(1);

    const snapshots = JSON.parse(await readFile(join(rawDir, "snapshots.json"), "utf8")) as {
      readonly adapter: string;
      readonly payload: unknown;
    }[];
    expect(snapshots[0]).toEqual(
      expect.objectContaining({
        adapter: "reddit",
        payload: expect.objectContaining({ redacted: true }),
      }),
    );
    expect(snapshots[1]).toEqual(
      expect.objectContaining({
        adapter: "yahoo-alpha-search",
        payload: { quoteResponse: { result: [] } },
      }),
    );
  });
});
