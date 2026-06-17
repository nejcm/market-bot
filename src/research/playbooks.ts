import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResearchCommand } from "../cli/args";
import type { AssetClass, Depth, JobType } from "../domain/types";
import { isRecord, readString } from "../sources/guards";
import { parseSections } from "./markdown-sections";
import type { StageLabel } from "./prompt-loader";

export type PlaybookStage = Exclude<
  StageLabel,
  "evidence-request" | "playbook-selection" | "spotlight-selection" | "forecast-disagreement"
>;

export interface PlaybookMetadata {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly file: string;
  readonly jobTypes: readonly JobType[];
  readonly assetClasses: readonly AssetClass[];
  readonly depths: readonly Depth[];
  readonly stages: readonly PlaybookStage[];
}

export interface LoadedPlaybook extends PlaybookMetadata {
  readonly instruction: string;
  readonly goal?: string;
}

export interface PlaybookCandidate {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly eligibleStages: readonly PlaybookStage[];
}

export interface StagePlaybooks {
  readonly stage: PlaybookStage;
  readonly playbooks: readonly LoadedPlaybook[];
}

export interface PlaybookSelectionAudit {
  readonly selected: readonly {
    readonly stage: PlaybookStage;
    readonly playbookIds: readonly string[];
  }[];
  readonly rationale?: string;
  readonly rejected: readonly {
    readonly stage?: string;
    readonly playbookId?: string;
    readonly reason: string;
  }[];
}

interface RawSelection {
  readonly stage: string;
  readonly playbookIds: readonly string[];
}

const MAX_PLAYBOOK_CHARS = 2500;
const MAX_PLAYBOOKS_PER_STAGE = 2;
const MAX_PLAYBOOKS_PER_RUN = 6;
const MAX_SELECTOR_RATIONALE_CHARS = 500;
// Keep in sync with PlaybookStage; this runtime set validates checked-in JSON.
const VALID_PLAYBOOK_STAGES: ReadonlySet<string> = new Set([
  "specialist-analysis",
  "regime-context-analysis",
  "mover-theme-analysis",
  "instrument-evidence-analysis",
  "market-behavior-analysis",
  "critique",
  "final-synthesis",
]);

function defaultPromptDir(): string {
  return join(import.meta.dir, "../../prompts");
}

function readStringArray(record: Record<string, unknown>, key: string): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    throw new Error(`Playbook registry entry missing valid ${key} array`);
  }
  return value;
}

function assertJobTypes(values: readonly string[]): readonly JobType[] {
  for (const value of values) {
    if (
      value !== "market-overview" &&
      value !== "daily" &&
      value !== "weekly" &&
      value !== "ticker"
    ) {
      throw new Error(`Playbook registry has invalid jobType: ${value}`);
    }
  }
  return values as readonly JobType[];
}

function assertAssetClasses(values: readonly string[]): readonly AssetClass[] {
  for (const value of values) {
    if (value !== "equity" && value !== "crypto") {
      throw new Error(`Playbook registry has invalid assetClass: ${value}`);
    }
  }
  return values as readonly AssetClass[];
}

function assertDepths(values: readonly string[]): readonly Depth[] {
  for (const value of values) {
    if (value !== "brief" && value !== "deep") {
      throw new Error(`Playbook registry has invalid depth: ${value}`);
    }
  }
  return values as readonly Depth[];
}

function assertStages(values: readonly string[]): readonly PlaybookStage[] {
  for (const value of values) {
    if (!VALID_PLAYBOOK_STAGES.has(value)) {
      throw new Error(`Playbook registry has invalid stage: ${value}`);
    }
  }
  return values as readonly PlaybookStage[];
}

function parseRegistryEntry(raw: unknown): PlaybookMetadata {
  if (!isRecord(raw)) {
    throw new Error("Playbook registry entries must be objects");
  }
  const id = readString(raw, "id");
  const title = readString(raw, "title");
  const summary = readString(raw, "summary");
  const file = readString(raw, "file");
  if (id === undefined || title === undefined || summary === undefined || file === undefined) {
    throw new Error("Playbook registry entry missing id, title, summary, or file");
  }
  return {
    id,
    title,
    summary,
    file,
    jobTypes: assertJobTypes(readStringArray(raw, "jobTypes")),
    assetClasses: assertAssetClasses(readStringArray(raw, "assetClasses")),
    depths: assertDepths(readStringArray(raw, "depths")),
    stages: assertStages(readStringArray(raw, "stages")),
  };
}

export async function loadPlaybookRegistry(
  promptDir: string = defaultPromptDir(),
): Promise<readonly PlaybookMetadata[]> {
  const registryPath = join(promptDir, "playbooks", "registry.json");
  const raw = await readFile(registryPath, "utf8").catch(() => {
    throw new Error(`Playbook registry file missing: ${registryPath}`);
  });
  const parsed = parseRegistryJson(raw, registryPath);
  if (!isRecord(parsed) || !Array.isArray(parsed.playbooks)) {
    throw new Error("Playbook registry must contain a playbooks array");
  }
  const registry = parsed.playbooks.map(parseRegistryEntry);
  const ids = new Set<string>();
  for (const playbook of registry) {
    if (ids.has(playbook.id)) {
      throw new Error(`Playbook registry has duplicate id: ${playbook.id}`);
    }
    ids.add(playbook.id);
  }
  return registry;
}

function parseRegistryJson(raw: string, registryPath: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Playbook registry file has invalid JSON: ${registryPath}`);
  }
}

export function eligiblePlaybookCandidates(
  command: ResearchCommand,
  stages: readonly PlaybookStage[],
  registry: readonly PlaybookMetadata[],
): readonly PlaybookCandidate[] {
  return registry
    .map((playbook) => ({
      playbook,
      eligibleStages: stages.filter(
        (stage) =>
          playbook.stages.includes(stage) &&
          playbook.jobTypes.includes(command.jobType) &&
          playbook.assetClasses.includes(command.assetClass) &&
          playbook.depths.includes(command.depth),
      ),
    }))
    .filter((entry) => entry.eligibleStages.length > 0)
    .map(({ playbook, eligibleStages }) => ({
      id: playbook.id,
      title: playbook.title,
      summary: playbook.summary,
      eligibleStages,
    }));
}

export async function loadPlaybooksByStage(
  promptDir: string,
  registry: readonly PlaybookMetadata[],
  selected: readonly { readonly stage: PlaybookStage; readonly playbookIds: readonly string[] }[],
): Promise<readonly StagePlaybooks[]> {
  const byId = new Map(registry.map((playbook) => [playbook.id, playbook]));
  return Promise.all(
    selected.map(async (selection) => {
      const playbooks = await Promise.all(
        selection.playbookIds.map((id) => {
          const metadata = byId.get(id);
          if (metadata === undefined) {
            throw new Error(`Selected playbook id missing from registry: ${id}`);
          }
          return loadPlaybook(promptDir, metadata);
        }),
      );
      return { stage: selection.stage, playbooks };
    }),
  );
}

async function loadPlaybook(
  promptDir: string,
  metadata: PlaybookMetadata,
): Promise<LoadedPlaybook> {
  const { file, id } = metadata;
  const path = join(promptDir, "playbooks", file);
  const raw = await readFile(path, "utf8").catch(() => {
    throw new Error(`Selected playbook file missing: ${path}`);
  });
  if (raw.length > MAX_PLAYBOOK_CHARS) {
    throw new Error(`Playbook ${id} exceeds ${String(MAX_PLAYBOOK_CHARS)} characters`);
  }
  const sections = parseSections(raw);
  const { instruction, goal } = sections;
  if (instruction === undefined || instruction === "") {
    throw new Error(`Playbook ${id} missing required ## instruction section`);
  }
  return {
    ...metadata,
    instruction,
    ...(goal !== undefined && goal !== "" ? { goal } : {}),
  };
}

export function parsePlaybookSelection(
  content: string,
  candidates: readonly PlaybookCandidate[],
): PlaybookSelectionAudit {
  const parsed = parseJson(content);
  if (!isRecord(parsed) || !Array.isArray(parsed.selections)) {
    return {
      selected: [],
      rejected: [{ reason: "selector returned malformed JSON" }],
    };
  }
  const eligible = buildEligibilityMap(candidates);
  const selectedByStage = new Map<PlaybookStage, string[]>();
  const rejected: {
    readonly stage?: string;
    readonly playbookId?: string;
    readonly reason: string;
  }[] = [];
  const seen = new Set<string>();
  let runCount = 0;

  for (const raw of parsed.selections) {
    const selection = parseRawSelection(raw);
    if (typeof selection === "string") {
      rejected.push({ reason: selection });
      continue;
    }
    if (!VALID_PLAYBOOK_STAGES.has(selection.stage)) {
      rejected.push({ stage: selection.stage, reason: "invalid stage" });
      continue;
    }
    const typedStage = selection.stage as PlaybookStage;
    for (const playbookId of selection.playbookIds) {
      const key = `${selection.stage}:${playbookId}`;
      const eligibleStages = eligible.get(playbookId);
      const stageCount = selectedByStage.get(typedStage)?.length ?? 0;
      if (eligibleStages === undefined || !eligibleStages.has(typedStage)) {
        rejected.push({ stage: selection.stage, playbookId, reason: "playbook is not eligible" });
      } else if (seen.has(key)) {
        rejected.push({ stage: selection.stage, playbookId, reason: "duplicate selection" });
      } else if (stageCount >= MAX_PLAYBOOKS_PER_STAGE) {
        rejected.push({
          stage: selection.stage,
          playbookId,
          reason: "per-stage playbook cap exceeded",
        });
      } else if (runCount >= MAX_PLAYBOOKS_PER_RUN) {
        rejected.push({
          stage: selection.stage,
          playbookId,
          reason: "per-run playbook cap exceeded",
        });
      } else {
        selectedByStage.set(typedStage, [...(selectedByStage.get(typedStage) ?? []), playbookId]);
        seen.add(key);
        runCount += 1;
      }
    }
  }

  return {
    selected: [...selectedByStage.entries()].map(([stage, playbookIds]) => ({
      stage,
      playbookIds,
    })),
    ...(typeof parsed.rationale === "string"
      ? { rationale: truncateRationale(parsed.rationale) }
      : {}),
    rejected,
  };
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}

function parseRawSelection(raw: unknown): RawSelection | string {
  if (!isRecord(raw)) {
    return "selection must be an object";
  }
  const stage = readString(raw, "stage");
  const { playbookIds } = raw;
  if (stage === undefined || !Array.isArray(playbookIds)) {
    return "selection must include stage and playbookIds";
  }
  if (playbookIds.some((id) => typeof id !== "string" || id === "")) {
    return "playbookIds must be non-empty strings";
  }
  return { stage, playbookIds };
}

function buildEligibilityMap(
  candidates: readonly PlaybookCandidate[],
): ReadonlyMap<string, ReadonlySet<PlaybookStage>> {
  return new Map(candidates.map((candidate) => [candidate.id, new Set(candidate.eligibleStages)]));
}

function truncateRationale(rationale: string): string {
  const trimmed = rationale.trim();
  return trimmed.length > MAX_SELECTOR_RATIONALE_CHARS
    ? `${trimmed.slice(0, MAX_SELECTOR_RATIONALE_CHARS - 3)}...`
    : trimmed;
}
