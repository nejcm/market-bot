import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalRequestUrl } from "../src/sources/cache";
import type { FetchLike } from "../src/sources/types";
import { runFixture, type FixtureMeta } from "../tests/support/run-fixtures";
import { createRecordingFetch } from "../tests/support/run-fixtures/data-cassette";
import {
  makeFinalSynthesisLiveProvider,
  type LlmCassette,
  type LlmCassetteEntry,
} from "../tests/support/run-fixtures/llm-cassette";

const USAGE =
  "Usage: bun run scripts/fixture-from-cache.ts <fixture-name> <run-id> <profile-run-id>\n" +
  "Offline converter, not the recorder: serves every request from data/cache and throws on a miss.";

const [fixtureName, runId, profileRunId, ...rest] = process.argv.slice(2);
if (
  fixtureName === undefined ||
  runId === undefined ||
  profileRunId === undefined ||
  rest.length > 0 ||
  ![fixtureName, runId, profileRunId].every((segment) =>
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment),
  )
) {
  throw new Error(USAGE);
}

interface CacheEntry {
  readonly cacheKey: string;
  readonly adapter: string;
  readonly fetchedAt: string;
  readonly payload: unknown;
}
interface StageRecord {
  readonly stage: string;
  readonly content: string;
  readonly tokenEstimate: number;
}
interface RunTrace {
  readonly symbol: string;
  readonly startedAt: string;
  readonly quickModel: string;
  readonly synthesisModel: string;
}

const root = join(import.meta.dir, "..");
const runDir = join(root, "data", "runs", runId);
const cacheDir = join(root, "data", "cache");
const fixtureDir = join(root, "tests", "fixtures", "runs", fixtureName);
for (const id of [runId, profileRunId]) {
  if (!existsSync(join(root, "data", "runs", id, "stages.json"))) {
    throw new Error(`Run ${id} has no stages.json under data/runs`);
  }
}
const trace = (await Bun.file(join(runDir, "trace.json")).json()) as RunTrace;

async function cacheEntries(
  dir: string,
  keep: (entry: CacheEntry) => boolean,
): Promise<CacheEntry[]> {
  const names = await readdir(dir);
  const entries = await Promise.all(
    names.map(async (name) => (await Bun.file(join(dir, name)).json()) as CacheEntry),
  );
  return entries.filter(keep);
}

const cached = new Map(
  [
    ...(await cacheEntries(
      join(cacheDir, trace.startedAt.slice(0, 10)),
      (entry) => entry.fetchedAt === trace.startedAt,
    )),
    ...(await cacheEntries(join(cacheDir, "accession"), () => true)),
  ].map((entry) => [entry.cacheKey, entry]),
);
const misses: string[] = [];
const adapters = [...new Set([...cached.values()].map((entry) => entry.adapter))];

async function sha256Hex(value: string): Promise<string> {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

// Mirrors the v3 key in src/sources/cache.ts; the adapter is unknown here, so every cached one is tried.
async function cachedEntry(
  url: string,
  method: string,
  body: string,
): Promise<CacheEntry | undefined> {
  const bodyHash = body === "" ? "" : await sha256Hex(body);
  const keys = await Promise.all(
    adapters.map((adapter) =>
      sha256Hex(`v3\n${adapter}\n${method}\n${bodyHash}\n${canonicalRequestUrl(url)}`),
    ),
  );
  return keys.map((key) => cached.get(key)).find((entry) => entry !== undefined);
}

// Exa keys its cache on a pseudo-URL of the search args, and the source run's reused profile capped results at 3.
async function exaSearchEntry(url: string, body: string): Promise<CacheEntry | undefined> {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  const capped = JSON.stringify({ ...parsed, numResults: 3 });
  const candidates = ["news", "market", "current-subject", "background"].flatMap((searchType) =>
    ["never", "always"].map(
      (livecrawl) =>
        `${url}?${new URLSearchParams({
          query: String(parsed.query),
          numResults: "3",
          searchType,
          startPublishedDate: String(parsed.startPublishedDate ?? "unbounded"),
          endPublishedDate: String(parsed.endPublishedDate),
          livecrawl,
        }).toString()}`,
    ),
  );
  const found = await Promise.all(candidates.map((keyUrl) => cachedEntry(keyUrl, "POST", capped)));
  return found.find((entry) => entry !== undefined);
}

const cacheFetch: FetchLike = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  const body = typeof init?.body === "string" && method !== "GET" ? init.body : "";
  const entry =
    (await cachedEntry(url, method, body)) ??
    (method === "POST" && canonicalRequestUrl(url) === "https://api.exa.ai/search"
      ? await exaSearchEntry("https://api.exa.ai/search", body)
      : undefined);
  if (entry !== undefined) {
    const isText = typeof entry.payload === "string";
    return new Response(isText ? String(entry.payload) : JSON.stringify(entry.payload), {
      status: 200,
      headers: { "content-type": isText ? "text/html" : "application/json" },
    });
  }
  misses.push(`${method} ${canonicalRequestUrl(url)}`);
  process.stderr.write(`cache miss: ${method} ${canonicalRequestUrl(url)}\n`);
  throw new Error(`No data/cache entry for ${method} ${canonicalRequestUrl(url)}`);
};

async function stageEntries(id: string): Promise<StageRecord[]> {
  return (await Bun.file(join(root, "data", "runs", id, "stages.json")).json()) as StageRecord[];
}

const entries: Record<string, LlmCassetteEntry[]> = {};
const profileStage = (await stageEntries(profileRunId)).find(
  (stage) => stage.stage === "web-subject-profile",
);
if (profileStage === undefined) {
  throw new Error(`${profileRunId} has no web-subject-profile stage output`);
}
for (const stage of [...(await stageEntries(runId)), profileStage]) {
  if (stage.stage === "forecast-disagreement") {
    continue;
  }
  const model = stage.stage === "final-synthesis" ? trace.synthesisModel : trace.quickModel;
  (entries[`${stage.stage}|${model}`] ??= []).push({
    content: stage.content,
    tokenEstimate: stage.tokenEstimate,
  });
}
const llmCassette: LlmCassette = { entries };

const meta: FixtureMeta & { readonly note: string } = {
  note: `Offline conversion of run ${runId} from data/cache, not a faithful replay: web-subject-profile output is borrowed from run ${profileRunId}, historical context and news-seen state are empty, and fixture config differs from the run (Yahoo news requests 8 items, not the cached 15; FRED, Marketaux and Massive are unconfigured, so Evidence Quality drops from high to medium). Finnhub endpoints that returned 403 were never cached and replay as cassette misses.`,
  now: trace.startedAt,
  argv: ["equity", trace.symbol, "--deep"],
  quickModel: trace.quickModel,
  synthesisModel: trace.synthesisModel,
  challengerModels: [],
  configuredProviders: ["exa", "finnhub"],
  secUserAgent: "market-bot fixture replay contact@example.invalid",
  webGatherDisabled: false,
  evidenceRequestOptions: { maxRounds: 0, maxToolCalls: 0, sourceBudget: 0 },
  webGatherOptions: { maxRounds: 2, maxToolCalls: 4, sourceBudget: 8 },
};

async function writeJson(name: string, value: unknown): Promise<void> {
  await writeFile(join(fixtureDir, name), `${JSON.stringify(value, undefined, 2)}\n`);
}

// Non-recursive: refuses to overwrite an existing fixture; a failed conversion removes only what it created.
await mkdir(fixtureDir);
async function convert(name: string): Promise<void> {
  await writeJson("meta.json", meta);
  await writeJson("llm-cassette.json", llmCassette);
  await writeJson("data-cassette.json", { entries: {} });
  const recorder = createRecordingFetch(cacheFetch);
  let finalSynthesisCalls = 0;
  const recordedFinalSynthesis = entries[`final-synthesis|${trace.synthesisModel}`] ?? [];
  const result = await runFixture(name, {
    llm: "replay",
    fetchImpl: recorder.fetch,
    provider: makeFinalSynthesisLiveProvider(llmCassette, {
      name: "recorded-final-synthesis",
      generate: async (request) => {
        const entry = recordedFinalSynthesis[finalSynthesisCalls];
        finalSynthesisCalls += 1;
        if (entry === undefined) {
          const { predictionRepromptErrors, reportValidationErrors } = JSON.parse(
            request.messages.at(-1)?.content ?? "{}",
          ) as Record<string, unknown>;
          throw new Error(
            `No recorded final-synthesis output for call ${String(finalSynthesisCalls)}: ${JSON.stringify({ predictionRepromptErrors, reportValidationErrors })}`,
          );
        }
        return entry;
      },
    }),
  });
  await result.cleanup();
  await writeJson("data-cassette.json", recorder.cassette());
}

try {
  await convert(fixtureName);
} catch (error) {
  await rm(fixtureDir, { recursive: true, force: true });
  throw error;
}
process.stdout.write(`${fixtureDir}\n${String(misses.length)} cache miss(es)\n`);
