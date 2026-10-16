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
  const stageInput = { ...input, loaded };
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
