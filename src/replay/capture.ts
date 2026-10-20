import { mkdir, rename, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ResearchCommand } from "../cli/args";
import type { AppConfig } from "../config";
import type { ModelProvider } from "../model/types";
import type { FetchLike } from "../sources/types";
import { readCodeVersion, type CodeVersion } from "../code-version";
import { dirtySourceHash } from "../reproducibility";
import { assertNoSecretsInText } from "./secret-scan";
import { createRecordingFetch, type DataCassetteEntry } from "./data-cassette";
import { createRecordingProvider, requestStage } from "./llm-cassette";
import { captureSettings, CAPTURE_PROVIDERS } from "./settings";
import { withReplaySession, isOfflineReplay, type ReplaySession } from "./session";
import {
  externalizeSynthesisBodies,
  makeSynthesisReplayInput,
  synthesisReplayFacts,
} from "./synthesis-input";
import { readReport } from "../run-artifact-report-reader";

export async function withRunCapture<T extends { readonly artifacts: { readonly runDir: string } }>(
  input: {
    readonly command: ResearchCommand;
    readonly config: AppConfig;
    readonly provider: ModelProvider;
    readonly now: Date;
    readonly fetchImpl?: FetchLike;
    readonly retryDelaysMs?: readonly number[];
  },
  run: (runtime: {
    readonly provider: ModelProvider;
    readonly fetchImpl: FetchLike;
    readonly codeState: { readonly codeVersion: CodeVersion; readonly sourceStateHash?: string };
  }) => Promise<T>,
): Promise<T> {
  const codeVersion = readCodeVersion();
  const sourceStateHash = codeVersion.dirty ? dirtySourceHash() : undefined;
  const codeState = {
    codeVersion,
    ...(sourceStateHash !== undefined ? { sourceStateHash } : {}),
  };
  if (input.config.captureReplay !== true) {
    return run({ provider: input.provider, fetchImpl: input.fetchImpl ?? fetch, codeState });
  }
  const secrets = [
    input.config.apiKey,
    ...CAPTURE_PROVIDERS.map((key) => input.config.sourceOptions[key]),
    input.config.sourceOptions.secUserAgent,
    ...(input.config.sourceOptions.secUserAgent?.match(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu,
    ) ?? []),
    input.config.baseUrl,
    input.config.dataDir,
    input.config.promptDir,
    input.config.sourceOptions.cacheDir,
    input.config.sourceOptions.newsSeenPath,
    input.config.sourceOptions.peerUniverseLearnedPath,
    input.config.indexOptions?.dbPath,
  ].filter((value): value is string => value !== undefined && value.length > 0);
  const representations = [
    ...new Set(
      secrets.flatMap((secret) => [
        secret,
        encodeURIComponent(secret),
        JSON.stringify(secret).slice(1, -1),
      ]),
    ),
  ].toSorted((left, right) => right.length - left.length);
  const redact = (value: string): string =>
    representations.reduce((text, secret) => text.replaceAll(secret, "redacted-secret"), value);
  const failures: string[] = [];
  let checkpoint: unknown = undefined;
  const session: ReplaySession = {
    mode: "record",
    offline: isOfflineReplay(),
    state: { values: {} },
    indexes: new Map(),
    failures,
    checkpoint: (value) => {
      checkpoint = JSON.parse(redact(JSON.stringify(value)));
    },
    redact,
  };
  const http = createRecordingFetch(input.fetchImpl ?? fetch, redact, () => {
    failures.push("HTTP body capture failed");
  });
  const llm = createRecordingProvider(input.provider, redact);
  const promptProvenance: { readonly model: string; readonly requestSha256: string }[] = [];
  const provider: ModelProvider = {
    ...llm.provider,
    generate: (request) => {
      const stage = requestStage(request);
      if (stage === "unknown") {
        failures.push("Unidentified model request");
      }
      if (stage === "final-synthesis") {
        promptProvenance.push({
          model: request.model,
          requestSha256: new Bun.CryptoHasher("sha256")
            .update(
              JSON.stringify({
                model: request.model,
                params: request.params,
                responseFormat: request.responseFormat,
                messages: request.messages,
              }),
            )
            .digest("hex"),
        });
      }
      return llm.provider.generate(request);
    },
  };
  const publish = async (runDir: string): Promise<void> => {
    const staged = join(runDir, `.replay-${crypto.randomUUID()}.partial`);
    try {
      if (failures.length > 0 || checkpoint === undefined) {
        throw new Error("Capture contains incomplete dependencies");
      }
      await mkdir(join(staged, "bodies"), { recursive: true });
      const write = async (name: string, value: unknown) => {
        const text = redact(JSON.stringify(value, null, 2));
        assertNoSecretsInText(name, text, secrets);
        await writeFile(join(staged, name), `${text}\n`, "utf8");
      };
      const bodyEntry = async (entry: DataCassetteEntry): Promise<DataCassetteEntry> => {
        const { sequence, ...recorded } = entry;
        const body = redact(recorded.body);
        let result = { ...recorded, body };
        if (body.length > 32_768) {
          const sha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex");
          assertNoSecretsInText("HTTP body", body, secrets);
          const bodyFile = `bodies/${sha256}.txt`;
          await writeFile(join(staged, bodyFile), body, "utf8");
          result = { ...recorded, body: "", bodyFile, sha256 };
        }
        return {
          ...result,
          ...(sequence === undefined
            ? {}
            : { sequence: await Promise.all(sequence.map((row) => bodyEntry(row))) }),
        };
      };
      const entries = Object.fromEntries(
        await Promise.all(
          Object.entries(http.cassette().entries).map(async ([key, entry]) => [
            key,
            await bodyEntry(entry),
          ]),
        ),
      );
      await write("data-cassette.json", { entries });
      await write("llm-cassette.json", llm.cassette());
      const state = Object.fromEntries(
        await Promise.all(
          Object.entries(session.state.values).map(async ([key, rows]) => [
            key,
            await Promise.all(
              rows.map(async (row) => {
                const body = redact(JSON.stringify(row));
                if (body.length <= 32_768) {
                  return row;
                }
                const sha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex");
                const bodyFile = `bodies/${sha256}.json`;
                assertNoSecretsInText("State body", body, secrets);
                await writeFile(join(staged, bodyFile), body, "utf8");
                return { bodyFile, sha256 };
              }),
            ),
          ]),
        ),
      );
      await write("state.json", { values: state });
      if (checkpoint !== undefined) {
        const baseline = await readFile(join(runDir, "report.json"), "utf8").then(
          (text) => readReport(JSON.parse(text)),
          () => undefined,
        );
        const synthesisBodies = new Map<string, string>();
        const synthesis = externalizeSynthesisBodies(
          makeSynthesisReplayInput(
            checkpoint,
            llm.cassette(),
            codeVersion,
            promptProvenance,
            baseline === undefined ? undefined : synthesisReplayFacts(baseline),
          ),
          (raw) => {
            const body = redact(raw);
            const sha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex");
            const bodyFile = `bodies/${sha256}.json`;
            synthesisBodies.set(bodyFile, body);
            return { bodyFile, sha256 };
          },
        );
        await Promise.all(
          [...synthesisBodies].map(([bodyFile, body]) => {
            assertNoSecretsInText("Synthesis body", body, secrets);
            return writeFile(join(staged, bodyFile), body, "utf8");
          }),
        );
        await write("final-synthesis-input.json", synthesis);
      }
      await write("meta.json", {
        replayClassification: "clean",
        now: input.now.toISOString(),
        argv: [],
        command: input.command,
        captureVersion: 1,
        settings: captureSettings(input.config),
        ...(input.retryDelaysMs === undefined ? {} : { retryDelaysMs: input.retryDelaysMs }),
      });
      await rename(staged, join(runDir, "replay"));
    } catch {
      await rm(staged, { recursive: true, force: true }).catch(() => {});
      try {
        await writeFile(
          join(runDir, "capture-failure.json"),
          JSON.stringify({
            status: "failed",
            message: "Replay capture failed; no valid capture was published",
          }),
        );
        process.stderr.write("Replay capture failed; research artifacts remain available\n");
      } catch {
        /* The research result remains authoritative. */
      }
    }
  };
  try {
    const result = await withReplaySession(session, () =>
      run({ provider, fetchImpl: http.fetch, codeState }),
    );
    await publish(result.artifacts.runDir);
    return result;
  } catch (error) {
    if (error instanceof Error && "runDir" in error && typeof error.runDir === "string") {
      await publish(error.runDir);
    }
    throw error;
  }
}
