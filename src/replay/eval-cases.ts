import { isRecord } from "../guards";
import type { ResearchReport } from "../domain/report";
import { claimsForReport, isHistoricalForecastOutcome } from "../research/post-synthesis-audit";
import { judgeItem, type JudgeItem, type JudgeMeter, type JudgeResult } from "./eval-judge";
import { modelAuthoredReportSegments } from "../report/schema";
import { splitMetricReferences } from "../research/metric-references";
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
  /(\p{Sc})?\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:\s?(%|trillion|billion|million)|([x×TBM])(?![a-z\d]))?/giu;
const UNIT_SCALE: Readonly<Record<string, number>> = {
  trillion: 1e12,
  t: 1e12,
  billion: 1e9,
  b: 1e9,
  million: 1e6,
  m: 1e6,
  thousand: 1e3,
};
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

function firstAtLeast(sorted: readonly number[], bound: number, inclusive: boolean): number {
  let left = 0;
  let right = sorted.length;
  while (left < right) {
    const mid = (left + right) >> 1;
    if (sorted[mid]! < bound || (!inclusive && sorted[mid] === bound)) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }
  return left;
}

const countWithin = (sorted: readonly number[], lo: number, hi: number) =>
  firstAtLeast(sorted, hi, false) - firstAtLeast(sorted, lo, true);

// A derivation needs a second operand: the base itself never counts as its own counterpart.
function otherWithin(sorted: readonly number[], base: number, lo: number, hi: number): boolean {
  return countWithin(sorted, lo, hi) > (base >= lo && base <= hi ? 1 : 0);
}

type FigureToken = ReturnType<typeof figureTokens>[number];

function directlySupported(token: FigureToken, sorted: readonly number[]): boolean {
  const { value, tolerance, percent } = token;
  return (percent ? [1, 100] : [1]).some(
    (scale) => countWithin(sorted, (value - tolerance) / scale, (value + tolerance) / scale) > 0,
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
          otherWithin(
            sorted,
            base,
            base * (ratio - ratioTolerance),
            base * (ratio + ratioTolerance),
          ),
        ),
    );
  }
  return sorted.some((base) =>
    otherWithin(sorted, base, base + value - tolerance, base + value + tolerance),
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

const NARRATIVE_NUMBER =
  /(?<![\p{L}\p{N}_.])(\p{Sc})?\s?(?:\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:\s?(%|trillion|billion|million|thousand)|([x×TBM]))?(?![\p{L}\p{N}])/gu;

// Every typed numeric claim, unitless included; dates, identifiers (RSI14, 10-K), years, and ordinals are not claims.
function narrativeNumbers(text: string): number {
  const stripped = text.replaceAll(METADATA_TEXT, (match) => (/\d/u.test(match) ? " " : match));
  return [...stripped.matchAll(NARRATIVE_NUMBER)].filter(
    ([raw, currency, decimals, word, suffix]) =>
      currency !== undefined ||
      decimals !== undefined ||
      (word ?? suffix) !== undefined ||
      !/^\s?(?:19|20)\d\d$/u.test(raw),
  ).length;
}

// One accepted final-synthesis output: metric references the renderer resolves vs figures the model typed; predictions excluded.
export function synthesisFigureCounts(content: string): {
  readonly metricReferences: number;
  readonly typedFigures: number;
} {
  const { predictions: _predictions, ...payload } = JSON.parse(content) as Record<string, unknown>;
  let metricReferences = 0;
  let typedFigures = 0;
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      const { prose, references } = splitMetricReferences(node);
      metricReferences += references;
      typedFigures += narrativeNumbers(prose);
    } else if (Array.isArray(node)) {
      node.forEach((child) => walk(child));
    } else if (isRecord(node)) {
      Object.entries(node).forEach(([key, child]) => key !== "sourceIds" && walk(child));
    }
  };
  walk(payload);
  return { metricReferences, typedFigures };
}

const METADATA_KEY =
  /^(?:id|ids|url|cik|form|fy|fp|date|year|period|accn|accession\w*)$|(?:Id|Ids|Url|Date|At|Year|Period|Number)$/u;
const METADATA_TEXT =
  /https?:\/\/\S+|\b\d{10}-\d{2}-\d{6}\b|\b\d+-[a-z]+\b|\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b|\b[a-z][\w^.]*(?:-[\w^.]+)+\b/giu;
const TEXT_NUMBER =
  /(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:e[+-]?\d+)?(?:\s?(trillion|billion|million|thousand)|([TBM])(?![a-z\d]))?/giu;

// Unscaled prose/table numbers may be stated in thousands or millions; structured fields and scaled words are absolute.
function textNumbers(text: string): readonly number[] {
  const stripped = text.replaceAll(METADATA_TEXT, (match) => (/\d/u.test(match) ? " " : match));
  return [...stripped.matchAll(TEXT_NUMBER)].flatMap((match) => {
    const value = Number(`${match[1]!.replaceAll(",", "")}${match[2] ?? ""}`);
    const scale = UNIT_SCALE[(match[3] ?? match[4])?.toLowerCase() ?? ""];
    return scale === undefined ? [value, value * 1e3, value * 1e6] : [value * scale];
  });
}

function recordTags(node: Readonly<Record<string, unknown>>): readonly string[] {
  const tags = [node.id, node.sourceId].filter((id): id is string => typeof id === "string");
  return Array.isArray(node.sourceIds)
    ? [...tags, ...node.sourceIds.filter((id): id is string => typeof id === "string")]
    : tags;
}

// The projection links evidence by a sibling `<name>SourceId` field and by metric-section `defaults`; make both plain tags.
function resolveEvidenceLinks(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((child) => resolveEvidenceLinks(child));
  }
  if (!isRecord(node)) {
    return node;
  }
  const resolved: Record<string, unknown> = Object.fromEntries(
    Object.entries(node).map(([key, value]) => [key, resolveEvidenceLinks(value)]),
  );
  for (const [key, value] of Object.entries(node)) {
    const target = key.endsWith("SourceId")
      ? resolved[key.slice(0, -"SourceId".length)]
      : undefined;
    if (typeof value === "string" && isRecord(target) && target.sourceId === undefined) {
      resolved[key.slice(0, -"SourceId".length)] = { sourceId: value, ...target };
    }
  }
  const { defaults, metrics, ...section } = resolved;
  if (isRecord(defaults) && Array.isArray(metrics)) {
    return {
      ...section,
      metrics: metrics.map((metric: unknown) =>
        isRecord(metric) ? { ...defaults, ...metric } : metric,
      ),
    };
  }
  return resolved;
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
  walk(resolveEvidenceLinks(evidence), [], undefined);
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
    flagged = result.verdict === "yes" || (result.verdict === "no" ? false : undefined);
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

// Evaluation units: every model-authored report surface (summary, findings, scenarios, extras, data gaps) plus predictions.
// The language gate skips dataGaps (model and assembly text mixed); evaluation judges all of it.
function evalUnits(report: ResearchReport): readonly {
  readonly location: string;
  readonly text: string;
  readonly sourceIds: readonly string[];
}[] {
  return [
    ...modelAuthoredReportSegments(report)
      .filter((segment) => segment.text.trim() !== "")
      .map((segment) => ({
        location: segment.path,
        text: segment.text,
        sourceIds: segment.sourceIds ?? [],
      })),
    ...report.dataGaps.map((text, index) => ({
      location: `dataGaps[${String(index)}]`,
      text,
      sourceIds: [],
    })),
    ...claimsForReport(report).filter((claim) => claim.location.startsWith("predictions[")),
  ];
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
  const claims = evalUnits(input.report);
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
          claim.sourceIds.length === 0
            ? [...facts.values()].flat()
            : claim.sourceIds.flatMap((id) => facts.get(id) ?? []),
        ),
      }))
      .filter((row) => row.figures.length > 0),
    uncitedRequiredSources: input.omissionCases
      .filter((row) => omits(cited, row.requiredSourceIds))
      .map((row) => row.id),
  };
}

const CONTRADICTION_QUESTION =
  "Does the cited evidence directly contradict any statement in the claim? Missing support is not a contradiction; answer insufficient-evidence when the evidence shown cannot settle it.";
const EVIDENCE_CHARS_PER_SOURCE = 4000;
const LONG_TEXT = 300;
const MISSING_EVIDENCE = "(the final-synthesis evidence carries no record with this source id)";
const UNCITED = "final-synthesis-evidence";

interface SourceRecord {
  // Projection path, so primary evidence stays distinguishable from historical model prose.
  readonly path: string;
  readonly node: unknown;
}

// Records per source id inside the model-visible evidence projection, tagged by id/sourceId/sourceIds.
function sourceRecords(evidence: unknown): ReadonlyMap<string, readonly SourceRecord[]> {
  const records = new Map<string, SourceRecord[]>();
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, `${path}[${String(index)}]`));
    } else if (isRecord(node)) {
      for (const tag of recordTags(node)) {
        records
          .set(tag, records.get(tag) ?? [])
          .get(tag)!
          .push({ path, node });
      }
      for (const [key, child] of Object.entries(node)) {
        walk(child, path === "" ? key : `${path}.${key}`);
      }
    }
  };
  walk(evidence, "");
  return records;
}

interface EvidenceLine {
  readonly text: string;
  // The record row (ids, period, unit) a sentence of long text belongs to.
  readonly row?: number;
}

const isScalar = (value: unknown) =>
  value !== null &&
  typeof value !== "object" &&
  !(typeof value === "string" && value.length > LONG_TEXT);

// One line per record with its short fields (keeping ids, period and unit together), one per sentence of long text.
function evidenceLines(node: unknown, path: string, lines: EvidenceLine[]): void {
  if (Array.isArray(node)) {
    node.forEach((child, index) => {
      const childPath = `${path}[${String(index)}]`;
      if (isScalar(child)) {
        lines.push({ text: `${childPath}: ${String(child)}` });
      } else {
        evidenceLines(child, childPath, lines);
      }
    });
    return;
  }
  if (!isRecord(node)) {
    return;
  }
  const scalars = Object.entries(node).filter(([, value]) => isScalar(value));
  const row = scalars.length > 0 ? lines.length : undefined;
  if (row !== undefined) {
    lines.push({ text: `${path || "."} ${JSON.stringify(Object.fromEntries(scalars))}` });
  }
  for (const [key, value] of Object.entries(node)) {
    const childPath = path === "" ? key : `${path}.${key}`;
    if (typeof value === "string" && value.length > LONG_TEXT) {
      lines.push(
        ...value
          .split(/(?<=[.!?])\s+|\s(?=\[[A-Z][^\]]*\])/u)
          .filter(Boolean)
          .map((sentence) => ({
            text: `${childPath}: ${sentence}`,
            ...(row === undefined ? {} : { row }),
          })),
      );
    } else if (value !== null && typeof value === "object") {
      evidenceLines(value, childPath, lines);
    }
  }
}

const claimTerms = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .match(/[a-z]{5,}|\d[\d,.]*/gu)
      ?.map((term) => term.replaceAll(",", "").replace(/\.$/u, "")),
  );

// Whole records when they fit; otherwise the lines sharing the most claim terms and figures, with their record rows, in order.
function relevantEvidence(records: readonly SourceRecord[], claim: string): string {
  const lines: EvidenceLine[] = [];
  records.forEach((record) => evidenceLines(record.node, record.path, lines));
  if (lines.reduce((sum, line) => sum + line.text.length + 1, 0) <= EVIDENCE_CHARS_PER_SOURCE) {
    return lines.map((line) => line.text).join("\n");
  }
  const terms = claimTerms(claim);
  const ranked = lines
    .map((line, index) => ({
      index,
      score: [...claimTerms(line.text)].filter((term) => terms.has(term)).length,
    }))
    .filter((row) => row.score > 0)
    .toSorted((a, b) => b.score - a.score || a.index - b.index);
  const kept = new Set<number>();
  let used = 0;
  for (const { index } of ranked) {
    const wanted = [lines[index]!.row, index].filter(
      (row): row is number => row !== undefined && !kept.has(row),
    );
    const cost = wanted.reduce((sum, row) => sum + lines[row]!.text.length + 1, 0);
    if (used + cost <= EVIDENCE_CHARS_PER_SOURCE) {
      wanted.forEach((row) => kept.add(row));
      used += cost;
    }
  }
  return [...kept]
    .toSorted((a, b) => a - b)
    .map((index) => lines[index]!.text)
    .join("\n");
}

function unitEvidence(
  records: ReadonlyMap<string, readonly SourceRecord[]>,
  evidence: unknown,
  unit: ReturnType<typeof evalUnits>[number],
): JudgeItem["evidence"] {
  if (unit.sourceIds.length === 0) {
    return [
      {
        sourceId: UNCITED,
        text: relevantEvidence([{ path: "", node: evidence }], unit.text) || MISSING_EVIDENCE,
      },
    ];
  }
  return unit.sourceIds.map((sourceId) => ({
    sourceId,
    text: relevantEvidence(records.get(sourceId) ?? [], unit.text) || MISSING_EVIDENCE,
  }));
}

// Judge items for a generated report: one contradiction item per evaluation unit, one conveyance item per omission case.
// `evidence` must be the final-synthesis evidence projection, so the judge sees only what generation saw.
export function reportJudgeItems(
  report: ResearchReport,
  omissionCases: readonly OmissionCase[],
  evidence: unknown,
): readonly {
  readonly key: string;
  readonly kind: "contradiction" | "conveyance";
  readonly item: JudgeItem;
}[] {
  const resolved = resolveEvidenceLinks(evidence);
  const records = sourceRecords(resolved);
  const units = evalUnits(report);
  return [
    ...units.map((unit) => ({
      key: unit.location,
      kind: "contradiction" as const,
      item: {
        question: CONTRADICTION_QUESTION,
        claim: unit.text,
        evidence: unitEvidence(records, resolved, unit),
      },
    })),
    ...omissionCases.map((row) => ({
      key: row.id,
      kind: "conveyance" as const,
      item: {
        question: row.conveyance,
        claim: units.map((unit) => unit.text).join("\n"),
        evidence: [],
      },
    })),
  ];
}

type ReportJudgeItems = ReturnType<typeof reportJudgeItems>;

const judgeRequestKey = (row: ReportJudgeItems[number]) => JSON.stringify([row.kind, row.item]);

// Pre-paired samples skip byte-identical complete contradiction requests, matched as multisets.
// A matched conveyance request stays on the control side only, judged once, its verdict shared (omission veto needs it).
export function cancelMatchedItems(
  control: ReportJudgeItems,
  ablation: ReportJudgeItems,
): {
  readonly control: ReportJudgeItems;
  readonly ablation: ReportJudgeItems;
  readonly canceled: readonly { readonly control: string; readonly ablation: string }[];
  readonly sharedConveyance: readonly string[];
} {
  const open = new Map<string, string[]>();
  for (const row of control) {
    open.set(judgeRequestKey(row), [...(open.get(judgeRequestKey(row)) ?? []), row.key]);
  }
  const canceled: { control: string; ablation: string }[] = [];
  const sharedConveyance: string[] = [];
  const ablationLeft = ablation.filter((row) => {
    const match = open.get(judgeRequestKey(row))?.shift();
    if (match !== undefined && row.kind === "conveyance") {
      sharedConveyance.push(row.key);
    } else if (match !== undefined) {
      canceled.push({ control: match, ablation: row.key });
    }
    return match === undefined;
  });
  const canceledControl = new Set(canceled.map((pair) => pair.control));
  return {
    control: control.filter((row) => !canceledControl.has(row.key)),
    ablation: ablationLeft,
    canceled,
    sharedConveyance,
  };
}

// Undecided and insufficient-evidence count against the report: as a contradiction, and as not conveyed.
export async function judgeReport(
  provider: ModelProvider,
  model: string,
  items: ReturnType<typeof reportJudgeItems>,
  meter?: JudgeMeter,
): Promise<{
  readonly contradictions: readonly string[];
  readonly unconveyed: readonly string[];
  readonly undecided: number;
  readonly insufficientEvidence: number;
}> {
  const contradictions: string[] = [];
  const unconveyed: string[] = [];
  let undecided = 0;
  let insufficientEvidence = 0;
  for (const { key, kind, item } of items) {
    // oxlint-disable-next-line no-await-in-loop -- votes stay in a stable order for cassette replay
    const { verdict } = await judgeItem(provider, model, item, meter);
    undecided += verdict === "undecided" ? 1 : 0;
    insufficientEvidence += verdict === "insufficient-evidence" ? 1 : 0;
    if (kind === "contradiction" && verdict !== "no") {
      contradictions.push(key);
    } else if (kind === "conveyance" && verdict !== "yes") {
      unconveyed.push(key);
    }
  }
  return { contradictions, unconveyed, undecided, insufficientEvidence };
}
