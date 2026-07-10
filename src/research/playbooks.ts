import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssetClass, Depth, JobType } from "../domain/types";
import { runTypeProducesSynthesisReport } from "../domain/run-types";
import { isRecord, readString } from "../sources/guards";
import { parseSections } from "./markdown-sections";
import type { StageLabel } from "./prompt-loader";

export type PlaybookJobType = Exclude<JobType, "alpha-search"> | "research";

export type PlaybookStage = Exclude<
  StageLabel,
  | "evidence-request"
  | "web-gather"
  | "playbook-selection"
  | "spotlight-selection"
  | "forecast-disagreement"
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

interface RawSelection {
  readonly stage: string;
  readonly playbookIds: readonly string[];
}

const MAX_PLAYBOOK_CHARS = 2500;
const MAX_PLAYBOOKS_PER_STAGE = 2;
const MAX_PLAYBOOKS_PER_RUN = 6;
const MAX_SELECTOR_RATIONALE_CHARS = 500;
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

// Every registry playbook whose subjectKeys match the run's resolved subject is
// Mandatory at its declared stages. A registry-validation test keeps subject
// Playbooks to stages with a free mandatory seat so seating never trips a cap.
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

export function parsePlaybookSelection(
  content: string,
  candidates: readonly PlaybookCandidate[],
  mandatorySelections: readonly {
    readonly stage: PlaybookStage;
    readonly playbookIds: readonly string[];
  }[] = [],
): PlaybookSelectionAudit {
  const eligible = buildEligibilityMap(candidates);
  const selectedByStage = new Map<PlaybookStage, string[]>();
  const rejected: {
    readonly stage?: string;
    readonly playbookId?: string;
    readonly reason: string;
  }[] = [];
  const seen = new Set<string>();
  const mandatorySeen = new Set<string>();
  let runCount = 0;

  for (const selection of mandatorySelections) {
    for (const playbookId of selection.playbookIds) {
      mandatorySeen.add(selectionKey(selection.stage, playbookId));
      const { runCount: nextRunCount } = addSelection({
        selectedByStage,
        rejected,
        seen,
        mandatorySeen,
        runCount,
        eligible,
        stage: selection.stage,
        playbookId,
        required: true,
      });
      runCount = nextRunCount;
    }
  }

  const parsed = parseJson(content);
  if (!isRecord(parsed) || !Array.isArray(parsed.selections)) {
    return {
      selected: [...selectedByStage.entries()].map(([stage, playbookIds]) => ({
        stage,
        playbookIds,
      })),
      rejected: [{ reason: "selector returned malformed JSON" }],
    };
  }

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
      const { runCount: nextRunCount } = addSelection({
        selectedByStage,
        rejected,
        seen,
        mandatorySeen,
        runCount,
        eligible,
        stage: typedStage,
        playbookId,
      });
      runCount = nextRunCount;
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

function selectionKey(stage: PlaybookStage, playbookId: string): string {
  return `${stage}:${playbookId}`;
}

function addSelection(input: {
  readonly selectedByStage: Map<PlaybookStage, string[]>;
  readonly rejected: {
    readonly stage?: string;
    readonly playbookId?: string;
    readonly reason: string;
  }[];
  readonly seen: Set<string>;
  readonly mandatorySeen: ReadonlySet<string>;
  readonly runCount: number;
  readonly eligible: ReadonlyMap<string, ReadonlySet<PlaybookStage>>;
  readonly stage: PlaybookStage;
  readonly playbookId: string;
  readonly required?: boolean;
}): { readonly runCount: number } {
  const key = selectionKey(input.stage, input.playbookId);
  const eligibleStages = input.eligible.get(input.playbookId);
  const stageCount = input.selectedByStage.get(input.stage)?.length ?? 0;
  if (eligibleStages === undefined || !eligibleStages.has(input.stage)) {
    return rejectSelection(input, "playbook is not eligible");
  }
  if (input.seen.has(key)) {
    if (input.mandatorySeen.has(key)) {
      return { runCount: input.runCount };
    }
    return rejectSelection(input, "duplicate selection");
  }
  if (stageCount >= MAX_PLAYBOOKS_PER_STAGE) {
    return rejectSelection(input, "per-stage playbook cap exceeded");
  }
  if (input.runCount >= MAX_PLAYBOOKS_PER_RUN) {
    return rejectSelection(input, "per-run playbook cap exceeded");
  }
  input.selectedByStage.set(input.stage, [
    ...(input.selectedByStage.get(input.stage) ?? []),
    input.playbookId,
  ]);
  input.seen.add(key);
  return { runCount: input.runCount + 1 };
}

function rejectSelection(
  input: {
    readonly rejected: {
      readonly stage?: string;
      readonly playbookId?: string;
      readonly reason: string;
    }[];
    readonly runCount: number;
    readonly stage: PlaybookStage;
    readonly playbookId: string;
    readonly required?: boolean;
  },
  reason: string,
): { readonly runCount: number } {
  if (input.required === true) {
    throw new Error(`Mandatory playbook ${input.playbookId} for ${input.stage} failed: ${reason}`);
  }
  input.rejected.push({
    stage: input.stage,
    playbookId: input.playbookId,
    reason,
  });
  return { runCount: input.runCount };
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
