import { join } from "node:path";
import { readJsonFile } from "./run-artifact-json-reader";
import { RUN_ARTIFACT_FILES, type JsonFileResult } from "./run-artifact-layout";

export async function readAnalytics(runDir: string): Promise<JsonFileResult> {
  return await readJsonFile(join(runDir, RUN_ARTIFACT_FILES.analytics));
}
