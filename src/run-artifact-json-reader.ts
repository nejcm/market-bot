import { readFile } from "node:fs/promises";
import { isRecord } from "./guards";
import type { JsonFileResult } from "./run-artifact-layout";

// Shared JSON reader. Missing files return "absent"; other read or parse
// Failures return "malformed"; valid JSON keeps its parsed value.
export async function readJsonFile(path: string): Promise<JsonFileResult> {
  try {
    const raw = await readFile(path, "utf8");
    try {
      return { status: "ok", value: JSON.parse(raw) as unknown };
    } catch {
      return { status: "malformed" };
    }
  } catch (error) {
    return isRecord(error) && error.code === "ENOENT"
      ? { status: "absent" }
      : { status: "malformed" };
  }
}
