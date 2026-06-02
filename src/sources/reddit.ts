import { sourceGap } from "../domain/source-gaps";
import type { SourceGap, SourceGapCause } from "../domain/types";
import { isRecord, optionalString, readNumber, readString } from "./guards";
import { encodeQuery } from "./news-utils";
import type { FetchLike, RawSourceSnapshot } from "./types";

const REDDIT_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const REDDIT_API_URL = "https://oauth.reddit.com";
const REDDIT_LISTING_LIMIT = 100;
const REDDIT_COMMENT_LIMIT = 25;
const REDDIT_MAX_LISTING_PAGES = 10;
const REDDIT_MAX_COMMENT_PARSE_DEPTH = 25;
const DEFAULT_COMMENT_DEPTH = 1;

export interface RedditDiscoveryClientOptions {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly userAgent: string;
  readonly subreddits: readonly string[];
  readonly lookbackDays: number;
  readonly fetchedAt: string;
  readonly commentDepth?: number;
  readonly seenRedditIds?: ReadonlySet<string>;
  readonly fetchImpl?: FetchLike;
}

export interface RedditDiscussionPost {
  readonly id: string;
  readonly fullname: string;
  readonly subreddit: string;
  readonly title: string;
  readonly selfText: string;
  readonly author: string;
  readonly createdAt: string;
  readonly score: number;
  readonly upvoteRatio?: number;
  readonly commentCount: number;
  readonly permalink: string;
  readonly url?: string;
}

export interface RedditDiscussionComment {
  readonly id: string;
  readonly fullname: string;
  readonly postId: string;
  readonly parentId: string;
  readonly subreddit: string;
  readonly body: string;
  readonly author: string;
  readonly createdAt: string;
  readonly score: number;
  readonly depth: number;
}

export interface RedditDiscussionCollectionResult {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly posts: readonly RedditDiscussionPost[];
  readonly comments: readonly RedditDiscussionComment[];
  readonly sourceGaps: readonly SourceGap[];
}

interface RedditToken {
  readonly accessToken: string;
}

type RedditJsonResult =
  | {
      readonly ok: true;
      readonly payload: unknown;
    }
  | {
      readonly ok: false;
      readonly gap: SourceGap;
    };

function redditGap(input: { readonly message: string; readonly cause: SourceGapCause }): SourceGap {
  return sourceGap({
    source: "reddit",
    message: input.message,
    provider: "reddit",
    capability: "discussion",
    cause: input.cause,
    evidenceQualityImpact: "core-cap",
  });
}

function missingCredentialGap(): SourceGap {
  return redditGap({
    message: "missing MARKET_BOT_REDDIT_CLIENT_ID or MARKET_BOT_REDDIT_CLIENT_SECRET",
    cause: "missing-credential",
  });
}

function subredditWhitelistGap(): SourceGap {
  return redditGap({
    message: "missing MARKET_BOT_REDDIT_SUBREDDITS whitelist",
    cause: "validation-failed",
  });
}

function responseFailureGap(response: Response): SourceGap {
  if (response.status === 429) {
    const retryAfter =
      response.headers.get("retry-after") ?? response.headers.get("x-ratelimit-reset");
    return redditGap({
      message: `reddit rate limited${retryAfter !== null ? ` retryAfterSeconds=${retryAfter}` : ""}`,
      cause: "fetch-failed",
    });
  }

  return redditGap({
    message: `reddit request failed with status ${response.status}`,
    cause: "fetch-failed",
  });
}

function fetchFailureGap(error: unknown): SourceGap {
  const message = error instanceof Error ? error.message : "fetch failed";
  return redditGap({
    message: `reddit request failed: ${message}`,
    cause: "fetch-failed",
  });
}

function authHeaders(userAgent: string, token: string): Record<string, string> {
  return {
    accept: "application/json",
    authorization: `Bearer ${token}`,
    "user-agent": userAgent,
  };
}

async function readJson(response: Response): Promise<RedditJsonResult> {
  try {
    return { ok: true, payload: (await response.json()) as unknown };
  } catch {
    return {
      ok: false,
      gap: redditGap({
        message: "reddit response was not valid JSON",
        cause: "malformed-response",
      }),
    };
  }
}

async function fetchToken(options: RedditDiscoveryClientOptions): Promise<RedditToken | SourceGap> {
  const { clientId, clientSecret, fetchImpl = fetch, userAgent } = options;
  if (clientId === undefined || clientSecret === undefined) {
    return missingCredentialGap();
  }

  const response = await fetchImpl(REDDIT_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": userAgent,
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  }).catch((error: unknown) => fetchFailureGap(error));
  if (!(response instanceof Response)) {
    return response;
  }
  if (!response.ok) {
    return responseFailureGap(response);
  }

  const json = await readJson(response);
  if (!json.ok) {
    return json.gap;
  }
  const { payload } = json;
  const accessToken = isRecord(payload) ? readString(payload, "access_token") : undefined;
  if (accessToken === undefined) {
    return redditGap({
      message: "reddit OAuth response missing bearer access token",
      cause: "malformed-response",
    });
  }

  return { accessToken };
}

async function fetchRedditJson(
  url: string,
  token: RedditToken,
  options: RedditDiscoveryClientOptions,
): Promise<RedditJsonResult> {
  const response = await (options.fetchImpl ?? fetch)(url, {
    headers: authHeaders(options.userAgent, token.accessToken),
  }).catch((error: unknown) => fetchFailureGap(error));
  if (!(response instanceof Response)) {
    return { ok: false, gap: response };
  }

  if (!response.ok) {
    return { ok: false, gap: responseFailureGap(response) };
  }

  return readJson(response);
}

async function collectSequential<TItem, TResult>(
  items: readonly TItem[],
  collect: (item: TItem) => Promise<TResult>,
): Promise<readonly TResult[]> {
  return items.reduce<Promise<TResult[]>>(async (previousResults, item) => {
    const results = await previousResults;
    // Local accumulator preserves sequential requests without the O(N^2) array spread cost.
    results.push(await collect(item));
    return results;
  }, Promise.resolve([]));
}

function dateFromUtcSeconds(value: number | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return new Date(value * 1000).toISOString();
}

function absoluteRedditUrl(path: string | undefined): string | undefined {
  if (path === undefined) {
    return undefined;
  }
  if (/^https?:\/\//iu.test(path)) {
    return path;
  }
  return `https://www.reddit.com${path}`;
}

function isListingGap(value: readonly unknown[] | SourceGap): value is SourceGap {
  return !Array.isArray(value);
}

function parsePost(value: unknown): RedditDiscussionPost | undefined {
  if (!isRecord(value) || value.kind !== "t3" || !isRecord(value.data)) {
    return undefined;
  }

  const id = readString(value.data, "id");
  const fullname = readString(value.data, "name");
  const subreddit = readString(value.data, "subreddit");
  const title = readString(value.data, "title");
  const createdAt = dateFromUtcSeconds(readNumber(value.data, "created_utc"));
  if (
    id === undefined ||
    fullname === undefined ||
    subreddit === undefined ||
    title === undefined ||
    createdAt === undefined
  ) {
    return undefined;
  }

  const permalink = absoluteRedditUrl(optionalString(value.data, "permalink"));
  const upvoteRatio = readNumber(value.data, "upvote_ratio");
  const url = optionalString(value.data, "url");
  return {
    id,
    fullname,
    subreddit,
    title,
    selfText: optionalString(value.data, "selftext") ?? "",
    author: optionalString(value.data, "author") ?? "[unknown]",
    createdAt,
    score: readNumber(value.data, "score") ?? 0,
    ...(upvoteRatio !== undefined ? { upvoteRatio } : {}),
    commentCount: readNumber(value.data, "num_comments") ?? 0,
    permalink: permalink ?? `https://www.reddit.com/comments/${id}`,
    ...(url !== undefined ? { url } : {}),
  };
}

function parseComment(value: unknown): RedditDiscussionComment | undefined {
  if (!isRecord(value) || value.kind !== "t1" || !isRecord(value.data)) {
    return undefined;
  }

  const id = readString(value.data, "id");
  const fullname = readString(value.data, "name");
  const linkId = readString(value.data, "link_id");
  const parentId = readString(value.data, "parent_id");
  const subreddit = readString(value.data, "subreddit");
  const body = readString(value.data, "body");
  const createdAt = dateFromUtcSeconds(readNumber(value.data, "created_utc"));
  if (
    id === undefined ||
    fullname === undefined ||
    linkId === undefined ||
    parentId === undefined ||
    subreddit === undefined ||
    body === undefined ||
    createdAt === undefined
  ) {
    return undefined;
  }

  return {
    id,
    fullname,
    postId: linkId.replace(/^t3_/u, ""),
    parentId,
    subreddit,
    body,
    author: optionalString(value.data, "author") ?? "[unknown]",
    createdAt,
    score: readNumber(value.data, "score") ?? 0,
    depth: readNumber(value.data, "depth") ?? 0,
  };
}

function parseCommentsDeep(
  children: readonly unknown[],
  remainingDepth = REDDIT_MAX_COMMENT_PARSE_DEPTH,
): readonly RedditDiscussionComment[] {
  return children.flatMap((child) => {
    const comment = parseComment(child);
    if (remainingDepth <= 0) {
      return comment === undefined ? [] : [comment];
    }
    if (!isRecord(child) || !isRecord(child.data) || !isRecord(child.data.replies)) {
      return comment === undefined ? [] : [comment];
    }

    const replies = listingChildren(child.data.replies);
    if (isListingGap(replies)) {
      return comment === undefined ? [] : [comment];
    }

    const nested = parseCommentsDeep(replies, remainingDepth - 1);
    return comment === undefined ? nested : [comment, ...nested];
  });
}

function listingChildren(payload: unknown): readonly unknown[] | SourceGap {
  if (!isRecord(payload) || !isRecord(payload.data) || !Array.isArray(payload.data.children)) {
    return redditGap({
      message: "reddit listing response missing children",
      cause: "malformed-response",
    });
  }

  return payload.data.children;
}

function listingAfter(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.data)) {
    return undefined;
  }
  return optionalString(payload.data, "after");
}

function commentsChildren(payload: unknown): readonly unknown[] | SourceGap {
  if (!Array.isArray(payload) || payload.length < 2) {
    return redditGap({
      message: "reddit comments response missing listing",
      cause: "malformed-response",
    });
  }
  return listingChildren(payload[1]);
}

function listingUrl(subreddit: string, after: string | undefined): string {
  const params: Record<string, string> = {
    limit: String(REDDIT_LISTING_LIMIT),
    raw_json: "1",
  };
  if (after !== undefined) {
    params.after = after;
  }
  return `${REDDIT_API_URL}/r/${encodeURIComponent(subreddit)}/new?${encodeQuery(params)}`;
}

function commentsUrl(post: RedditDiscussionPost, depth: number): string {
  return `${REDDIT_API_URL}/r/${encodeURIComponent(post.subreddit)}/comments/${encodeURIComponent(
    post.id,
  )}.json?${encodeQuery({
    limit: String(REDDIT_COMMENT_LIMIT),
    depth: String(depth),
    sort: "top",
    raw_json: "1",
  })}`;
}

function isWithinLookback(
  post: RedditDiscussionPost,
  options: RedditDiscoveryClientOptions,
): boolean {
  const minTime =
    new Date(options.fetchedAt).getTime() - options.lookbackDays * 24 * 60 * 60 * 1000;
  return new Date(post.createdAt).getTime() >= minTime;
}

function isSeen(post: RedditDiscussionPost, seen: ReadonlySet<string> | undefined): boolean {
  return seen?.has(post.fullname) === true || seen?.has(post.id) === true;
}

async function collectSubredditPosts(
  subreddit: string,
  token: RedditToken,
  options: RedditDiscoveryClientOptions,
): Promise<{
  readonly snapshots: RawSourceSnapshot[];
  readonly posts: RedditDiscussionPost[];
  readonly gaps: SourceGap[];
}> {
  const snapshots: RawSourceSnapshot[] = [];
  const posts: RedditDiscussionPost[] = [];
  const gaps: SourceGap[] = [];

  async function collectPage(after: string | undefined, pageCount: number): Promise<void> {
    const result = await fetchRedditJson(listingUrl(subreddit, after), token, options);
    if (!result.ok) {
      gaps.push(result.gap);
      return;
    }
    const { payload } = result;
    snapshots.push({
      id: `raw-reddit-listing-${subreddit}-${snapshots.length + 1}`,
      adapter: "reddit",
      fetchedAt: options.fetchedAt,
      payload,
    });

    const children = listingChildren(payload);
    if (isListingGap(children)) {
      gaps.push(children);
      return;
    }

    const parsedPosts = children
      .map((child) => parsePost(child))
      .filter((post): post is RedditDiscussionPost => post !== undefined);
    const pagePosts = parsedPosts.filter(
      (post) => isWithinLookback(post, options) && !isSeen(post, options.seenRedditIds),
    );
    posts.push(...pagePosts);
    const nextAfter =
      parsedPosts.length > 0 && parsedPosts.every((post) => !isWithinLookback(post, options))
        ? undefined
        : listingAfter(payload);
    if (nextAfter !== undefined && pageCount < REDDIT_MAX_LISTING_PAGES) {
      await collectPage(nextAfter, pageCount + 1);
    }
  }

  await collectPage(undefined, 1);

  return { snapshots, posts, gaps };
}

async function collectPostComments(
  post: RedditDiscussionPost,
  token: RedditToken,
  options: RedditDiscoveryClientOptions,
): Promise<{
  readonly snapshot?: RawSourceSnapshot;
  readonly comments: readonly RedditDiscussionComment[];
  readonly gaps: readonly SourceGap[];
}> {
  const result = await fetchRedditJson(
    commentsUrl(post, options.commentDepth ?? DEFAULT_COMMENT_DEPTH),
    token,
    options,
  );
  if (!result.ok) {
    return { comments: [], gaps: [result.gap] };
  }
  const { payload } = result;

  const children = commentsChildren(payload);
  if (isListingGap(children)) {
    return { comments: [], gaps: [children] };
  }

  return {
    snapshot: {
      id: `raw-reddit-comments-${post.id}`,
      adapter: "reddit",
      fetchedAt: options.fetchedAt,
      payload,
    },
    comments: parseCommentsDeep(children),
    gaps: [],
  };
}

export async function collectRedditDiscussions(
  options: RedditDiscoveryClientOptions,
): Promise<RedditDiscussionCollectionResult> {
  if (options.subreddits.length === 0) {
    return { rawSnapshots: [], posts: [], comments: [], sourceGaps: [subredditWhitelistGap()] };
  }

  const token = await fetchToken(options);
  if (!("accessToken" in token)) {
    return { rawSnapshots: [], posts: [], comments: [], sourceGaps: [token] };
  }

  const subredditResults = await collectSequential(options.subreddits, (subreddit) =>
    collectSubredditPosts(subreddit, token, options),
  );
  const posts = subredditResults.flatMap((result) => result.posts);
  const commentResults = await collectSequential(posts, (post) =>
    collectPostComments(post, token, options),
  );

  return {
    rawSnapshots: [
      ...subredditResults.flatMap((result) => result.snapshots),
      ...commentResults.flatMap((result) =>
        result.snapshot === undefined ? [] : [result.snapshot],
      ),
    ],
    posts,
    comments: commentResults.flatMap((result) => result.comments),
    sourceGaps: [
      ...subredditResults.flatMap((result) => result.gaps),
      ...commentResults.flatMap((result) => result.gaps),
    ],
  };
}
