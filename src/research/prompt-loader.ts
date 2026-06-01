import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResearchCommand } from "../cli/args";

export type StageLabel =
  | "evidence-request"
  | "specialist-analysis"
  | "regime-context-analysis"
  | "mover-theme-analysis"
  | "instrument-evidence-analysis"
  | "market-behavior-analysis"
  | "critique"
  | "final-synthesis";

export interface LoadedPrompt {
  readonly system: string;
  readonly instruction: string;
  readonly goal: string;
}

// ---------------------------------------------------------------------------
// Section parser — splits markdown by "## <heading>" markers
// ---------------------------------------------------------------------------

function parseSections(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const regex = /^## (.+)$/gmu;
  const positions: { heading: string; start: number }[] = [];

  let match: RegExpExecArray | null = regex.exec(content);
  while (match !== null) {
    positions.push({ heading: (match[1] ?? "").trim().toLowerCase(), start: match.index });
    match = regex.exec(content);
  }

  for (let i = 0; i < positions.length; i++) {
    const current = positions[i];
    const next = positions[i + 1];
    if (current === undefined) {
      continue;
    }
    const bodyStart = content.indexOf("\n", current.start) + 1;
    const bodyEnd = next !== undefined ? next.start : content.length;
    result[current.heading] = content.slice(bodyStart, bodyEnd).trim();
  }

  return result;
}

// ---------------------------------------------------------------------------
// Override file key — matches the prompt file name for a given command
// ---------------------------------------------------------------------------

function overrideKey(command: ResearchCommand): string {
  if (command.jobType === "ticker") {
    return "ticker";
  }
  return `${command.jobType}-${command.assetClass}`;
}

// ---------------------------------------------------------------------------
// Default prompt directory — resolved relative to this source file
// ---------------------------------------------------------------------------

function defaultPromptDir(): string {
  return join(import.meta.dir, "../../prompts");
}

function requireBaseSection(
  sections: Record<string, string>,
  section: keyof LoadedPrompt,
  basePath: string,
): string {
  const value = sections[section];
  if (value === undefined || value === "") {
    throw new Error(`Prompt base file ${basePath} missing required ## ${section} section`);
  }
  return value;
}

function rejectUnsupportedOverrideSections(
  sections: Record<string, string>,
  overridePath: string,
): void {
  for (const section of Object.keys(sections)) {
    if (section !== "instruction" && section !== "goal") {
      throw new Error(`Prompt override file ${overridePath} has unsupported ## ${section} section`);
    }
  }
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loadStagePrompt(
  stage: StageLabel,
  command: ResearchCommand,
  promptDir?: string,
): Promise<LoadedPrompt> {
  const dir = promptDir ?? defaultPromptDir();
  const basePath = join(dir, stage, "base.md");

  const baseContent = await readFile(basePath, "utf8").catch(() => {
    throw new Error(`Prompt base file missing: ${basePath}`);
  });

  const base = parseSections(baseContent);
  const system = requireBaseSection(base, "system", basePath);
  let instruction = requireBaseSection(base, "instruction", basePath);
  let goal = requireBaseSection(base, "goal", basePath);

  const overridePath = join(dir, stage, `${overrideKey(command)}.md`);
  const overrideContent = await readFile(overridePath, "utf8").catch(() => null);

  if (overrideContent !== null) {
    const override = parseSections(overrideContent);
    rejectUnsupportedOverrideSections(override, overridePath);
    if (override["instruction"] !== undefined) {
      instruction = `${instruction}\n\n${override["instruction"]}`;
    }
    if (override["goal"] !== undefined) {
      goal = `${goal}\n\n${override["goal"]}`;
    }
  }

  return { system, instruction, goal };
}
