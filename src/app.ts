import { parseArgs } from "./cli/args";
import { resolveConfig } from "./config";
import { createOpenAIProvider } from "./model/openai";
import { persistResearchJob } from "./research/orchestrator";
import { collectSources } from "./sources/collector";
import { buildAndWriteCalibration, runScorePass } from "./scoring/index";

export async function runCli(argv: readonly string[]): Promise<string> {
  const command = parseArgs(argv);
  const config = resolveConfig();

  if (command.jobType === "score") {
    const result = await runScorePass(config.dataDir);
    await buildAndWriteCalibration(config.dataDir);
    return `Score pass complete: ${String(result.scored)} run(s) scored, ${String(result.skipped)} skipped`;
  }

  if (command.jobType === "calibration") {
    await buildAndWriteCalibration(config.dataDir);
    return "Calibration summary written to data/calibration/summary.json";
  }

  const provider = createOpenAIProvider(config);
  const collectedSources = await collectSources(command, config.sourceOptions);

  const scoreResult = await runScorePass(config.dataDir).catch((error: unknown) => {
    process.stderr.write(
      `Score pass failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  });
  if (scoreResult !== undefined) {
    await buildAndWriteCalibration(config.dataDir).catch((error: unknown) => {
      process.stderr.write(
        `Calibration build failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  }

  const result = await persistResearchJob({
    command,
    config,
    provider,
    collectedSources,
  });

  return result.artifacts.runDir;
}
