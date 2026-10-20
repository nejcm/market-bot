import { isRecord } from "../guards";
import type { ResearchReport } from "../domain/report";
import { claimsForReport, isHistoricalForecastOutcome } from "../research/post-synthesis-audit";
import { judgeItem, type JudgeItem, type JudgeResult } from "./eval-judge";
import type { ModelProvider } from "../model/types";

const EVAL_CHECKS = [
  "contradiction",
  "unsupported-inference",
  "omission",
  "stale-support",
  "extraction-error",
] as const;
type EvalCheck = (typeof EVAL_CHECKS)[number];
type Pointer = readonly (string | number)[];
const HISTORY_SOURCE_PREFIX = "history-report-";
const STALE_EXEMPT_POSTURES = [
  "stale evidence",
  "missing required source",
  "prior forecast outcome",
  "historical forecast outcome",
] as const;

interface EvalClaim {
  readonly text: string;
  readonly sourceIds: readonly string[];
}

interface EvalCaseBase {
  readonly id: string;
  readonly capture: string;
  readonly defect: boolean;
  readonly target: { readonly file: string; readonly sha256: string; readonly pointer: Pointer };
  readonly evidence: readonly {
    readonly file: string;
    readonly pointer: Pointer;
    readonly excerpt: string;
  }[];
  readonly why: string;
}

type EvalCase = EvalCaseBase &
  (
    | {
        readonly check: "stale-support";
        readonly claim: EvalClaim;
        readonly currentSourceIds: readonly string[];
        readonly historicalSourceIds: readonly string[];
      }
    | {
        readonly check: "omission";
        readonly requiredSourceIds: readonly string[];
        readonly citedSourceIds: readonly string[];
        readonly conveyance: string;
      }
    | {
        readonly check: "extraction-error";
        readonly claim: EvalClaim;
        readonly facts: readonly EvalFact[];
      }
    | {
        readonly check: "contradiction" | "unsupported-inference";
        readonly claim: EvalClaim;
        readonly question: string;
      }
  );

interface EvalFact {
  readonly sourceId: string;
  readonly value: number;
  readonly pointer: Pointer;
  readonly excerpt: string;
  readonly scale?: number;
}

export type OmissionCase = Extract<EvalCase, { readonly check: "omission" }>;
type JudgedCase = Extract<EvalCase, { readonly check: "contradiction" | "unsupported-inference" }>;

export function parseEvalCases(value: unknown): readonly EvalCase[] {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.cases)) {
    throw new Error("Eval cases must be {version: 1, cases: []}");
  }
  const ids = new Set<string>();
  for (const row of value.cases as unknown[]) {
    if (
      !isRecord(row) ||
      typeof row.id !== "string" ||
      typeof row.capture !== "string" ||
      typeof row.defect !== "boolean" ||
      !EVAL_CHECKS.includes(row.check as EvalCheck) ||
      !isRecord(row.target) ||
      !Array.isArray(row.evidence) ||
      row.evidence.length === 0 ||
      ids.has(row.id)
    ) {
      throw new Error(`Invalid or duplicate eval case: ${JSON.stringify(row).slice(0, 120)}`);
    }
    ids.add(row.id);
  }
  return value.cases as readonly EvalCase[];
}

export function evalCaseLabel(evalCase: EvalCase): EvalCheck | "clean" {
  return evalCase.defect ? evalCase.check : "clean";
}

export function resolvePointer(root: unknown, pointer: Pointer): unknown {
  let node = root;
  for (const segment of pointer) {
    if (segment === "$json") {
      node = typeof node === "string" ? JSON.parse(node) : undefined;
    } else if (Array.isArray(node) && typeof segment === "number") {
      node = node[segment];
    } else if (isRecord(node) && typeof segment === "string") {
      node = node[segment];
    } else {
      return undefined;
    }
  }
  return node;
}

export function staleSupport(
  claim: EvalClaim,
  current: ReadonlySet<string>,
  historical: ReadonlySet<string>,
): "unresolved-citation" | "carried-over-citation" | "history-only-support" | undefined {
  const carried = claim.sourceIds.filter(
    (id) => !current.has(id) && !id.startsWith(HISTORY_SOURCE_PREFIX),
  );
  if (carried.some((id) => !historical.has(id))) {
    return "unresolved-citation";
  }
  if (carried.length > 0) {
    return "carried-over-citation";
  }
  const text = claim.text.toLowerCase();
  return claim.sourceIds.length > 0 &&
    claim.sourceIds.every((id) => id.startsWith(HISTORY_SOURCE_PREFIX)) &&
    !STALE_EXEMPT_POSTURES.some((posture) => text.includes(posture)) &&
    !isHistoricalForecastOutcome(claim.text)
    ? "history-only-support"
    : undefined;
}

export function omits(cited: ReadonlySet<string>, required: readonly string[]): boolean {
  return !required.some((id) => cited.has(id));
}

const FIGURE_PATTERN =
  /(\p{Sc})?\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:\s?(%|trillion|billion|million)|([x×TBM])(?![a-z]))?/giu;
const UNIT_SCALE: Readonly<Record<string, number>> = {
  trillion: 1e12,
  t: 1e12,
  billion: 1e9,
  b: 1e9,
  million: 1e6,
  m: 1e6,
  thousand: 1e3,
};
const UNIT_RESCALES = [1, 1e3, 1e6, 1e9] as const;
const MAX_DERIVATION_GROUP = 200;

function figureTokens(text: string) {
  return [...text.matchAll(FIGURE_PATTERN)]
    .filter((match) => match[1] !== undefined || (match[4] ?? match[5]) !== undefined)
    .map((match) => {
      const unit = (match[4] ?? match[5])?.toLowerCase() ?? "";
      const scale = UNIT_SCALE[unit] ?? 1;
      const decimals = (match[3]?.length ?? 1) - 1;
      return {
        raw: match[0].trim(),
        value: Number(`${match[2]!.replaceAll(",", "")}${match[3] ?? ""}`) * scale,
        tolerance: 0.5 * 10 ** -decimals * scale + 1e-9,
        percent: unit === "%",
        multiple: unit === "x" || unit === "×",
      };
    });
}

function anyWithin(sorted: readonly number[], lo: number, hi: number): boolean {
  let left = 0;
  let right = sorted.length;
  while (left < right) {
    const mid = (left + right) >> 1;
    if (sorted[mid]! < lo) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }
  return left < sorted.length && sorted[left]! <= hi;
}

type FigureToken = ReturnType<typeof figureTokens>[number];

function directlySupported(token: FigureToken, sorted: readonly number[]): boolean {
  const { value, tolerance, percent } = token;
  return (percent ? [1, 100] : UNIT_RESCALES).some((scale) =>
    anyWithin(sorted, (value - tolerance) / scale, (value + tolerance) / scale),
  );
}

// Registered derivations, both operands from one source record: % as ratio/margin/share or percent change, x as a ratio, currency as a difference.
function derivable(token: FigureToken, sorted: readonly number[]): boolean {
  const { value, tolerance, percent, multiple } = token;
  if (percent || multiple) {
    const ratios = percent ? [value / 100, 1 + value / 100, 1 - value / 100] : [value];
    const ratioTolerance = percent ? tolerance / 100 : tolerance;
    return sorted.some(
      (base) =>
        base > 0 &&
        ratios.some((ratio) =>
          anyWithin(sorted, base * (ratio - ratioTolerance), base * (ratio + ratioTolerance)),
        ),
    );
  }
  return sorted.some((base) =>
    anyWithin(sorted, base + value - tolerance, base + value + tolerance),
  );
}

const sortedMagnitudes = (values: readonly number[]) =>
  values.map((value) => Math.abs(value)).toSorted((a, b) => a - b);

// Facts come in groups (one per source record); direct matches use all of them, derivations stay within a group.
export function unsupportedFigures(
  text: string,
  groups: readonly (readonly number[])[],
): readonly string[] {
  const all = sortedMagnitudes(groups.flat());
  // Shortcut: dense records only support direct matches, and many small records still let ~1/3 of mutated $ figures pass; make facts unit/period-aware if that recall matters.
  const sortedGroups = groups
    .filter((group) => group.length <= MAX_DERIVATION_GROUP)
    .map((group) => sortedMagnitudes(group));
  return figureTokens(text)
    .filter(
      (token) =>
        !directlySupported(token, all) && !sortedGroups.some((group) => derivable(token, group)),
    )
    .map(({ raw }) => raw);
}

const METADATA_KEY =
  /^(?:id|ids|url|cik|form|fy|fp|date|year|period|accn|accession\w*)$|(?:Id|Ids|Url|Date|At|Year|Period|Number)$/u;
const METADATA_TEXT =
  /https?:\/\/\S+|\b\d{10}-\d{2}-\d{6}\b|\b\d+-[a-z]+\b|\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b|\b[a-z][\w^.]*(?:-[\w^.]+)+\b/giu;
const TEXT_NUMBER =
  /(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:e[+-]?\d+)?(?:\s?(trillion|billion|million|thousand))?/giu;

function textNumbers(text: string): readonly number[] {
  const stripped = text.replaceAll(METADATA_TEXT, (match) => (/\d/u.test(match) ? " " : match));
  return [...stripped.matchAll(TEXT_NUMBER)].map(
    (match) =>
      Number(`${match[1]!.replaceAll(",", "")}${match[2] ?? ""}`) *
      (UNIT_SCALE[match[3]?.toLowerCase() ?? ""] ?? 1),
  );
}

function recordTags(node: Readonly<Record<string, unknown>>): readonly string[] {
  const tags = [node.id, node.sourceId].filter((id): id is string => typeof id === "string");
  return Array.isArray(node.sourceIds)
    ? [...tags, ...node.sourceIds.filter((id): id is string => typeof id === "string")]
    : tags;
}

// Numeric fact groups per source id: one group per record tagged by id/sourceId/sourceIds, metadata excluded.
export function sourceFacts(
  evidence: unknown,
): ReadonlyMap<string, readonly (readonly number[])[]> {
  const facts = new Map<string, number[][]>();
  const walk = (node: unknown, tags: readonly string[], group: number[] | undefined): void => {
    if (Array.isArray(node)) {
      node.forEach((child) => walk(child, tags, group));
    } else if (isRecord(node)) {
      const own = recordTags(node);
      let next = tags;
      let nextGroup = group;
      if (own.length > 0) {
        next = [...tags, ...own];
        nextGroup = [];
        for (const tag of next) {
          facts
            .set(tag, facts.get(tag) ?? [])
            .get(tag)!
            .push(nextGroup);
        }
      }
      for (const [key, value] of Object.entries(node)) {
        if (!METADATA_KEY.test(key)) {
          walk(value, next, nextGroup);
        }
      }
    } else if (typeof node === "number") {
      group?.push(node);
    } else if (typeof node === "string") {
      group?.push(...textNumbers(node));
    }
  };
  walk(evidence, [], undefined);
  return facts;
}

function judgeItemForCase(evalCase: JudgedCase): JudgeItem {
  return {
    question: evalCase.question,
    claim: evalCase.claim.text,
    evidence: evalCase.evidence.map((row) => ({
      sourceId: [row.file, ...row.pointer].join("."),
      text: row.excerpt,
    })),
  };
}

export async function runEvalCase(
  evalCase: EvalCase,
  judge?: (item: JudgeItem) => Promise<JudgeResult>,
): Promise<{
  readonly id: string;
  readonly label: EvalCheck | "clean";
  readonly flagged: boolean | undefined;
  readonly pass: boolean | undefined;
  readonly detail: unknown;
}> {
  let flagged: boolean | undefined = undefined;
  let detail: unknown = undefined;
  if (evalCase.check === "stale-support") {
    detail = staleSupport(
      evalCase.claim,
      new Set(evalCase.currentSourceIds),
      new Set(evalCase.historicalSourceIds),
    );
    flagged = detail !== undefined;
  } else if (evalCase.check === "omission") {
    flagged = omits(new Set(evalCase.citedSourceIds), evalCase.requiredSourceIds);
  } else if (evalCase.check === "extraction-error") {
    detail = unsupportedFigures(evalCase.claim.text, [evalCase.facts.map((fact) => fact.value)]);
    flagged = (detail as readonly string[]).length > 0;
  } else if (judge !== undefined) {
    const result = await judge(judgeItemForCase(evalCase));
    detail = result;
    flagged = result.verdict === "undecided" ? undefined : result.verdict === "yes";
  }
  return {
    id: evalCase.id,
    label: evalCaseLabel(evalCase),
    flagged,
    pass: flagged === undefined ? undefined : flagged === evalCase.defect,
    detail,
  };
}

export function historicalSourceIds(context: unknown): ReadonlySet<string> {
  const ids = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach((child) => walk(child));
    } else if (isRecord(node)) {
      if (Array.isArray(node.sourceIds)) {
        node.sourceIds.forEach((id) => typeof id === "string" && ids.add(id));
      }
      Object.values(node).forEach((child) => walk(child));
    }
  };
  walk(context);
  return ids;
}

// Deterministic defect counts for one report produced from a saved Final-Synthesis Input.
export function scoreReportDefects(input: {
  readonly report: ResearchReport;
  readonly knownSourceIds: readonly string[];
  readonly historicalContext: unknown;
  readonly evidence: unknown;
  readonly omissionCases: readonly OmissionCase[];
}): {
  readonly claims: number;
  readonly staleSupport: readonly string[];
  readonly unmatchedFigures: readonly {
    readonly location: string;
    readonly figures: readonly string[];
  }[];
  readonly uncitedRequiredSources: readonly string[];
} {
  const claims = claimsForReport(input.report);
  const current = new Set(input.knownSourceIds);
  const historical = historicalSourceIds(input.historicalContext);
  const facts = sourceFacts(input.evidence);
  const cited = new Set(claims.flatMap((claim) => claim.sourceIds));
  return {
    claims: claims.length,
    staleSupport: claims
      .filter((claim) => staleSupport(claim, current, historical) !== undefined)
      .map((claim) => claim.location),
    unmatchedFigures: claims
      .map((claim) => ({
        location: claim.location,
        figures: unsupportedFigures(
          claim.text,
          claim.sourceIds.flatMap((id) => facts.get(id) ?? []),
        ),
      }))
      .filter((row) => row.figures.length > 0),
    uncitedRequiredSources: input.omissionCases
      .filter((row) => omits(cited, row.requiredSourceIds))
      .map((row) => row.id),
  };
}

const CONTRADICTION_QUESTION =
  "Does the cited evidence directly contradict any statement in the claim? Missing support is not a contradiction.";
const SOURCE_TEXT_LIMIT = 2000;

// Judge items for a generated report: one contradiction item per claim, one conveyance item per omission case.
export function reportJudgeItems(
  report: ResearchReport,
  omissionCases: readonly OmissionCase[],
): readonly {
  readonly key: string;
  readonly kind: "contradiction" | "conveyance";
  readonly item: JudgeItem;
}[] {
  const sources = new Map(report.sources.map((source) => [source.id, source]));
  const claims = claimsForReport(report);
  return [
    ...claims.map((claim) => ({
      key: claim.location,
      kind: "contradiction" as const,
      item: {
        question: CONTRADICTION_QUESTION,
        claim: claim.text,
        evidence: claim.sourceIds.map((sourceId) => {
          const source = sources.get(sourceId);
          // Shortcut: judge sees only the report source's title/summary/snippet, pass collected evidence if numeric conflicts matter.
          const text = [source?.title, source?.summary, source?.snippet].filter(Boolean).join("\n");
          return { sourceId, text: text.slice(0, SOURCE_TEXT_LIMIT) };
        }),
      },
    })),
    ...omissionCases.map((row) => ({
      key: row.id,
      kind: "conveyance" as const,
      item: {
        question: row.conveyance,
        claim: claims.map((claim) => claim.text).join("\n"),
        evidence: [],
      },
    })),
  ];
}

// Undecided counts against the report: as a contradiction, and as not conveyed.
export async function judgeReport(
  provider: ModelProvider,
  model: string,
  items: ReturnType<typeof reportJudgeItems>,
): Promise<{
  readonly contradictions: readonly string[];
  readonly unconveyed: readonly string[];
  readonly undecided: number;
}> {
  const contradictions: string[] = [];
  const unconveyed: string[] = [];
  let undecided = 0;
  for (const { key, kind, item } of items) {
    // oxlint-disable-next-line no-await-in-loop -- votes stay in a stable order for cassette replay
    const { verdict } = await judgeItem(provider, model, item);
    undecided += verdict === "undecided" ? 1 : 0;
    if (kind === "contradiction" && verdict !== "no") {
      contradictions.push(key);
    } else if (kind === "conveyance" && verdict !== "yes") {
      unconveyed.push(key);
    }
  }
  return { contradictions, unconveyed, undecided };
}
