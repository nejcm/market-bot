import { parseArgs } from "./cli/args";
import { resolveConfig } from "./config";
import { createOpenAIProvider } from "./model/openai";
import { persistResearchJob } from "./research/orchestrator";
import { collectSources } from "./sources/collector";

export async function runCli(argv: readonly string[]): Promise<string> {
  const command = parseArgs(argv);
  const config = resolveConfig();
  const provider = createOpenAIProvider(config);
  const collectedSources = await collectSources(command, config.sourceOptions);
  const result = await persistResearchJob({
    command,
    config,
    provider,
    collectedSources,
  });

  return result.artifacts.runDir;
}
