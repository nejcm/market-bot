import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord } from "../sources/guards";
import type { RedditDiscussionPost } from "../sources/reddit";

export interface RedditSeenEntry {
  readonly id: string;
  readonly fullname: string;
  readonly subreddit: string;
  readonly firstRunId: string;
  readonly lastRunId: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

interface RedditSeenIndex {
  readonly version: 1;
  readonly entries: readonly RedditSeenEntry[];
}

const INDEX_VERSION = 1;

function readEntry(value: unknown): RedditSeenEntry | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.fullname !== "string" ||
    typeof value.subreddit !== "string" ||
    typeof value.firstRunId !== "string" ||
    typeof value.lastRunId !== "string" ||
    typeof value.firstSeenAt !== "string" ||
    typeof value.lastSeenAt !== "string"
  ) {
    return undefined;
  }

  return {
    id: value.id,
    fullname: value.fullname,
    subreddit: value.subreddit,
    firstRunId: value.firstRunId,
    lastRunId: value.lastRunId,
    firstSeenAt: value.firstSeenAt,
    lastSeenAt: value.lastSeenAt,
  };
}

export async function readRedditSeenEntries(path: string): Promise<readonly RedditSeenEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
      return [];
    }

    return parsed.entries
      .map(readEntry)
      .filter((entry): entry is RedditSeenEntry => entry !== undefined);
  } catch {
    return [];
  }
}

export async function readRedditSeenIds(path: string): Promise<ReadonlySet<string>> {
  const entries = await readRedditSeenEntries(path);
  return new Set(entries.flatMap((entry) => [entry.id, entry.fullname]));
}

async function writeRedditSeenIndex(path: string, index: RedditSeenIndex): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  } catch (error: unknown) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export async function recordRedditSeenPosts(options: {
  readonly path: string;
  readonly runId: string;
  readonly seenAt: string;
  readonly posts: readonly RedditDiscussionPost[];
}): Promise<void> {
  const existing = await readRedditSeenEntries(options.path);
  const entriesByFullname = new Map(existing.map((entry) => [entry.fullname, entry]));

  for (const post of options.posts) {
    const current = entriesByFullname.get(post.fullname);
    entriesByFullname.set(post.fullname, {
      id: post.id,
      fullname: post.fullname,
      subreddit: post.subreddit,
      firstRunId: current?.firstRunId ?? options.runId,
      lastRunId: options.runId,
      firstSeenAt: current?.firstSeenAt ?? options.seenAt,
      lastSeenAt: options.seenAt,
    });
  }

  await writeRedditSeenIndex(options.path, {
    version: INDEX_VERSION,
    entries: [...entriesByFullname.values()].toSorted((left, right) =>
      left.fullname.localeCompare(right.fullname),
    ),
  });
}
