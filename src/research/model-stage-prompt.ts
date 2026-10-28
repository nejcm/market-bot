import { isRecord } from "../guards";
import type { ModelRequest } from "../model/types";
import { withUntrustedModelInputRule } from "../model/trust-guard";
import { loadStagePrompt, type StageLabel } from "./prompt-loader";
import { buildStagePrompt, buildRecordedStageSteering, type StageInput } from "./prompts";

export async function buildModelStageRequest(
  stage: StageLabel,
  model: string,
  promptDir: string,
  input: Omit<StageInput, "loaded">,
): Promise<{
  readonly request: ModelRequest;
  readonly steering: ReturnType<typeof buildRecordedStageSteering>;
}> {
  const loaded = await loadStagePrompt(stage, input.command, promptDir);
  // Usage is run telemetry, not evidence; keeping it out of priorStages leaves prompts unchanged.
  const priorStages = input.priorStages?.map((row) =>
    isRecord(row) && "usage" in row ? omitUsage(row) : row,
  );
  const stageInput = {
    ...input,
    ...(priorStages !== undefined ? { priorStages } : {}),
    loaded,
  };
  const params =
    stage === "final-synthesis"
      ? input.context.runParams.synthesisModelParams
      : input.context.runParams.quickModelParams;
  return {
    request: {
      model,
      ...(params !== undefined ? { params } : {}),
      responseFormat: "json",
      messages: [
        { role: "system", content: withUntrustedModelInputRule(loaded.system) },
        { role: "user", content: buildStagePrompt(stage, stageInput) },
      ],
    },
    steering: buildRecordedStageSteering(stage, stageInput),
  };
}

function omitUsage({ usage: _usage, ...row }: Record<string, unknown>): Record<string, unknown> {
  return row;
}
