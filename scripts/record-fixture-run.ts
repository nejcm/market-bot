import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { goldenOutputPath, writeGoldenOutput } from "../tests/support/run-fixtures/artifacts";
import type { FixtureMeta } from "../tests/support/run-fixtures";
import { assertNoSecretsInFiles, knownSecretValues } from "./fixture-secret-scan";

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function removeTempRoot(tempRoot: string, runError: unknown): Promise<void> {
  try {
    await rm(tempRoot, { recursive: true, force: true });
  } catch (cleanupError) {
    if (runError === undefined) {
      throw cleanupError;
    }
    process.stderr.write(
      `Failed to remove fixture recorder temp dir ${tempRoot}: ${errorMessage(cleanupError)}\n`,
    );
  }
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
  let runError: unknown = undefined;
  try {
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
    const result = await persistResearchJob({
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
    await writeGoldenOutput(result.artifacts.runDir, fixtureName);
    await assertNoSecretsInFiles(
      [
        join(fixtureDir, "data-cassette.json"),
        join(fixtureDir, "llm-cassette.json"),
        join(fixtureDir, "meta.json"),
        goldenOutputPath(fixtureName),
      ],
      knownSecretValues(process.env),
    );
    process.stdout.write(`${fixtureDir}\n`);
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    await removeTempRoot(tempRoot, runError);
  }
}

await main();
