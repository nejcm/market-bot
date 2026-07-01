import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, type ResearchCommand } from "../src/cli/args";
import { resolveConfig } from "../src/config";
import { readCodeVersion } from "../src/code-version";
import { createProvider } from "../src/model/factory";
import { collectSources } from "../src/sources/collector";
import { persistResearchJob } from "../src/research/orchestrator";
import {
  commandWithResolvedResearchSubject,
  resolveResearchSubject,
} from "../src/research/research-subject-identity";
import { createRecordingFetch } from "../tests/support/run-fixtures/data-cassette";
import { createRecordingProvider } from "../tests/support/run-fixtures/llm-cassette";
import type { FixtureMeta } from "../tests/support/run-fixtures";

function usage(): never {
  throw new Error(
    "Usage: bun run scripts/record-fixture-run.ts <fixture-name> <command...> [--brief|--deep]",
  );
}

function researchCommand(argv: readonly string[]): ResearchCommand {
  const command = parseArgs(argv);
  if (
    command.jobType === "market-overview" ||
    command.jobType === "equity" ||
    command.jobType === "crypto" ||
    command.jobType === "research"
  ) {
    return command;
  }
  throw new Error("Fixture recorder requires a research command");
}

function commandArgv(raw: readonly string[]): readonly string[] {
  return raw.filter((arg) => arg !== "--brief");
}

function knownSecretValues(env: Record<string, string | undefined>): readonly string[] {
  return [
    env.OPENAI_API_KEY,
    env.MARKET_BOT_OPENAI_API_KEY,
    env.ANTHROPIC_API_KEY,
    env.MARKET_BOT_ANTHROPIC_API_KEY,
    env.MARKET_BOT_MARKETAUX_API_TOKEN,
    env.MARKET_BOT_FINNHUB_API_TOKEN,
    env.MARKET_BOT_FRED_API_KEY,
    env.MARKET_BOT_TRADIER_API_TOKEN,
    env.MARKET_BOT_GLASSNODE_API_KEY,
    env.MARKET_BOT_MASSIVE_API_KEY,
    env.MARKET_BOT_POLYGON_API_KEY,
    env.MARKET_BOT_EXA_API_KEY,
  ].filter((value): value is string => value !== undefined && value.length >= 8);
}

async function assertNoSecrets(dir: string, secrets: readonly string[]): Promise<void> {
  if (secrets.length === 0) {
    return;
  }
  const files = ["data-cassette.json", "llm-cassette.json", "meta.json"];
  await Promise.all(
    files.map(async (file) => {
      const content = await readFile(join(dir, file), "utf8");
      const leaked = secrets.find((secret) => content.includes(secret));
      if (leaked !== undefined) {
        throw new Error(`Secret-like value leaked into ${file}`);
      }
    }),
  );
}

async function main(): Promise<void> {
  const [fixtureName, ...rawCommand] = process.argv.slice(2);
  if (fixtureName === undefined || rawCommand.length === 0) {
    usage();
  }

  const argv = commandArgv(rawCommand);
  const rawResearchCommand = researchCommand(argv);
  const resolvedSubject = resolveResearchSubject(rawResearchCommand);
  const command = commandWithResolvedResearchSubject(rawResearchCommand, resolvedSubject);
  const tempRoot = await mkdtemp(join(tmpdir(), `market-bot-record-${fixtureName}-`));
  const now = new Date();
  const resolvedConfig = resolveConfig(process.env, { validateAlphaSearchOptions: false });
  const config = {
    ...resolvedConfig,
    dataDir: join(tempRoot, "runs"),
    sourceOptions: {
      ...resolvedConfig.sourceOptions,
      cacheDir: join(tempRoot, "cache"),
      newsSeenPath: join(tempRoot, "news-seen.json"),
      peerUniverseLearnedPath: join(tempRoot, "peer-universe-learned.json"),
    },
  };
  const fetchRecorder = createRecordingFetch(fetch);
  const providerRecorder = createRecordingProvider(createProvider(config));
  const collectedSources = await collectSources(command, config.sourceOptions, {
    now,
    fetchImpl: fetchRecorder.fetch,
    ...(resolvedSubject !== undefined ? { resolvedSubject } : {}),
    peerUniverse: {
      provider: providerRecorder.provider,
      model: config.quickModel,
      cachePath:
        config.sourceOptions.peerUniverseLearnedPath ?? join(tempRoot, "peer-universe.json"),
    },
  });
  await persistResearchJob({
    command,
    config,
    provider: providerRecorder.provider,
    collectedSources,
    now,
    sourceFetchImpl: fetchRecorder.fetch,
  });

  const fixtureDir = join(import.meta.dir, "..", "tests", "fixtures", "runs", fixtureName);
  await mkdir(fixtureDir, { recursive: true });
  const meta: FixtureMeta & { readonly codeVersion: unknown } = {
    now: now.toISOString(),
    argv,
    quickModel: config.quickModel,
    synthesisModel: config.synthesisModel,
    challengerModels: config.forecastDisagreementOptions?.challengerModels ?? [],
    ...(config.sourceOptions.secUserAgent !== undefined
      ? { secUserAgent: "market-bot fixture replay contact@example.invalid" }
      : {}),
    webGatherDisabled: config.webGatherDisabled,
    evidenceRequestOptions: config.evidenceRequestOptions,
    webGatherOptions: config.webGatherOptions,
    codeVersion: readCodeVersion(),
  };
  await writeFile(
    join(fixtureDir, "data-cassette.json"),
    `${JSON.stringify(fetchRecorder.cassette(), null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(fixtureDir, "llm-cassette.json"),
    `${JSON.stringify(providerRecorder.cassette(), null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(fixtureDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  await assertNoSecrets(fixtureDir, knownSecretValues(process.env));
  process.stdout.write(`${fixtureDir}\n`);
}

await main();
