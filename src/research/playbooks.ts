import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssetClass, Depth, JobType } from "../domain/job-type";
import { runTypeProducesSynthesisReport } from "../domain/run-types";
import { isRecord, readString } from "../guards";
import { parseSections } from "./markdown-sections";
import type { StageLabel } from "./prompt-loader";

type PlaybookJobType = Exclude<JobType, "alpha-search"> | "research";

export type PlaybookStage = Exclude<
  StageLabel,
  "evidence-request" | "web-gather" | "spotlight-selection" | "forecast-disagreement"
>;

export interface PlaybookCommandScope {
  readonly jobType: PlaybookJobType;
  readonly assetClass: AssetClass;
  readonly depth: Depth;
  readonly symbol?: string;
  readonly subjectKey?: string;
}

export interface PlaybookMetadata {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly file: string;
  readonly jobTypes: readonly PlaybookJobType[];
  readonly assetClasses: readonly AssetClass[];
  readonly depths: readonly Depth[];
  readonly stages: readonly PlaybookStage[];
  readonly subjectKeys?: readonly string[];
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

export const MAX_PLAYBOOK_CHARS = 2500;
const SOURCE_DISCIPLINE_PLAYBOOK_ID = "source-discipline";
const SYNTHESIS_DISCIPLINE_PLAYBOOK_ID = "synthesis-discipline";
const THEMATIC_RESEARCH_PLAYBOOK_ID = "thematic-research";
const SOURCE_DISCIPLINE_STAGES: readonly PlaybookStage[] = ["critique"];
const SYNTHESIS_DISCIPLINE_STAGES: readonly PlaybookStage[] = ["final-synthesis"];
const THEMATIC_RESEARCH_STAGES: readonly PlaybookStage[] = [
  "specialist-analysis",
  "final-synthesis",
];
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

// This throwing validator rejects empty strings instead of reading leniently.
function readStringArray(record: Record<string, unknown>, key: string): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    throw new Error(`Playbook registry entry missing valid ${key} array`);
  }
  return value;
}

function readOptionalStringArray(
  record: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  if (record[key] === undefined) {
    return undefined;
  }
  const value = record[key];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || item === "")
  ) {
    throw new Error(`Playbook registry entry has invalid ${key} array`);
  }
  return value;
}

function assertJobTypes(values: readonly string[]): readonly PlaybookJobType[] {
  for (const value of values) {
    if (
      value !== "market-overview" &&
      value !== "daily" &&
      value !== "weekly" &&
      value !== "equity" &&
      value !== "crypto" &&
      value !== "research"
    ) {
      throw new Error(`Playbook registry has invalid jobType: ${value}`);
    }
  }
  return values as readonly PlaybookJobType[];
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
  const subjectKeys = readOptionalStringArray(raw, "subjectKeys");
  return {
    id,
    title,
    summary,
    file,
    jobTypes: assertJobTypes(readStringArray(raw, "jobTypes")),
    assetClasses: assertAssetClasses(readStringArray(raw, "assetClasses")),
    depths: assertDepths(readStringArray(raw, "depths")),
    stages: assertStages(readStringArray(raw, "stages")),
    ...(subjectKeys !== undefined ? { subjectKeys } : {}),
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
  command: PlaybookCommandScope,
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
          playbook.depths.includes(command.depth) &&
          playbookMatchesSubject(playbook, command),
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

// A subject-keyed playbook is eligible only when the run's resolved subject
// Matches one of its declared subjectKeys; entries without the field are
// Unrestricted and behave exactly as before.
function playbookMatchesSubject(
  playbook: PlaybookMetadata,
  command: PlaybookCommandScope,
): boolean {
  if (playbook.subjectKeys === undefined) {
    return true;
  }
  return command.subjectKey !== undefined && playbook.subjectKeys.includes(command.subjectKey);
}

// Thread the resolved research subject key onto a playbook command scope so
// Subject-keyed playbooks can be gated and mandatorily seated.
export function playbookScopeWithSubjectKey(
  command: PlaybookCommandScope,
  subjectKey: string | undefined,
): PlaybookCommandScope {
  return {
    ...command,
    ...(subjectKey !== undefined ? { subjectKey } : {}),
  };
}

export function mandatoryPlaybookSelections(
  command: PlaybookCommandScope,
  stages: readonly PlaybookStage[],
  candidates: readonly PlaybookCandidate[],
  registry: readonly PlaybookMetadata[],
): readonly { readonly stage: PlaybookStage; readonly playbookIds: readonly string[] }[] {
  const sourceDiscipline =
    command.jobType === "research"
      ? mandatoryPlaybookSelection({
          playbookId: SOURCE_DISCIPLINE_PLAYBOOK_ID,
          label: "research source-discipline",
          stages,
          requiredStages: SOURCE_DISCIPLINE_STAGES,
          candidates,
        })
      : [];
  const synthesisDiscipline = runTypeProducesSynthesisReport(command.jobType)
    ? mandatoryPlaybookSelection({
        playbookId: SYNTHESIS_DISCIPLINE_PLAYBOOK_ID,
        label: "synthesis-discipline",
        stages,
        requiredStages: SYNTHESIS_DISCIPLINE_STAGES,
        candidates,
      })
    : [];
  const thematicResearch =
    command.jobType === "research"
      ? mandatoryPlaybookSelection({
          playbookId: THEMATIC_RESEARCH_PLAYBOOK_ID,
          label: "research thematic-research",
          stages,
          requiredStages: THEMATIC_RESEARCH_STAGES,
          candidates,
        })
      : [];

  return [
    ...sourceDiscipline,
    ...synthesisDiscipline,
    ...thematicResearch,
    ...subjectPlaybookSelections(command, stages, candidates, registry),
  ];
}

function subjectPlaybookSelections(
  command: PlaybookCommandScope,
  stages: readonly PlaybookStage[],
  candidates: readonly PlaybookCandidate[],
  registry: readonly PlaybookMetadata[],
): readonly { readonly stage: PlaybookStage; readonly playbookIds: readonly string[] }[] {
  const { subjectKey } = command;
  if (command.jobType !== "research" || subjectKey === undefined) {
    return [];
  }
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  return registry
    .filter(
      (entry) => entry.subjectKeys?.includes(subjectKey) === true && candidateIds.has(entry.id),
    )
    .flatMap((entry) =>
      mandatoryPlaybookSelection({
        playbookId: entry.id,
        label: `research subject ${entry.id}`,
        stages,
        requiredStages: entry.stages,
        candidates,
      }),
    );
}

function mandatoryPlaybookSelection(input: {
  readonly playbookId: string;
  readonly label: string;
  readonly stages: readonly PlaybookStage[];
  readonly requiredStages: readonly PlaybookStage[];
  readonly candidates: readonly PlaybookCandidate[];
}): readonly { readonly stage: PlaybookStage; readonly playbookIds: readonly string[] }[] {
  const requiredStages = input.requiredStages.filter((stage) => input.stages.includes(stage));
  if (requiredStages.length === 0) {
    return [];
  }
  const eligible = buildEligibilityMap(input.candidates);
  const playbookStages = eligible.get(input.playbookId) ?? new Set<PlaybookStage>();
  const missingStages = requiredStages.filter((stage) => !playbookStages.has(stage));
  if (missingStages.length > 0) {
    throw new Error(
      `Mandatory playbook ${input.playbookId} is not eligible for ${input.label} stages: ${missingStages.join(", ")}`,
    );
  }
  return requiredStages.map((stage) => ({
    stage,
    playbookIds: [input.playbookId],
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

export function selectPlaybooks(
  command: PlaybookCommandScope,
  stages: readonly PlaybookStage[],
  registry: readonly PlaybookMetadata[],
): PlaybookSelectionAudit {
  const candidates = eligiblePlaybookCandidates(command, stages, registry);
  const mandatory = mandatoryPlaybookSelections(command, stages, candidates, registry);
  return {
    selected: stages
      .map((stage) => ({
        stage,
        playbookIds: [
          ...new Set([
            ...mandatory
              .filter((selection) => selection.stage === stage)
              .flatMap((selection) => selection.playbookIds),
            ...candidates
              .filter((candidate) => candidate.eligibleStages.includes(stage))
              .map((candidate) => candidate.id),
          ]),
        ],
      }))
      .filter((selection) => selection.playbookIds.length > 0),
    rationale: "Deterministic selection of all eligible playbooks plus mandatory selections.",
    rejected: [],
  };
}

function buildEligibilityMap(
  candidates: readonly PlaybookCandidate[],
): ReadonlyMap<string, ReadonlySet<PlaybookStage>> {
  return new Map(candidates.map((candidate) => [candidate.id, new Set(candidate.eligibleStages)]));
}
