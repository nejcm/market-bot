import { isRecord } from "../guards";
import type { ResearchReport } from "../domain/report";
import { claimsForReport, isHistoricalForecastOutcome } from "../research/post-synthesis-audit";
import type { JudgeItem, JudgeResult } from "./eval-judge";

const EVAL_CHECKS = ["contradiction", "omission", "stale-support", "extraction-error"] as const;
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
      }
    | {
        readonly check: "extraction-error";
        readonly claim: EvalClaim;
        readonly facts: readonly { readonly sourceId: string; readonly value: number }[];
      }
    | {
        readonly check: "contradiction";
        readonly claim: EvalClaim;
        readonly question: string;
      }
  );

export type OmissionCase = Extract<EvalCase, { readonly check: "omission" }>;

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
};

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
      };
    });
}

function candidates(facts: readonly number[], derived: boolean): readonly number[] {
  if (!derived) {
    return facts;
  }
  const values = [...facts];
  for (const a of facts) {
    for (const b of facts) {
      if (a !== b && b !== 0) {
        values.push(a / b, a - b);
      }
    }
  }
  return values;
}

// Derived mode accepts one ratio, difference or percent change between two facts; it is O(n^2).
export function unsupportedFigures(
  text: string,
  facts: readonly number[],
  derived: boolean,
): readonly string[] {
  const values = candidates(facts, derived);
  return figureTokens(text)
    .filter(({ value, tolerance, percent }) => {
      const matches = (candidate: number) => Math.abs(Math.abs(candidate) - value) <= tolerance;
      return !values.some(
        (candidate) =>
          matches(candidate) ||
          (percent && (matches(candidate * 100) || matches((candidate - 1) * 100))),
      );
    })
    .map(({ raw }) => raw);
}

function judgeItemForCase(
  evalCase: Extract<EvalCase, { readonly check: "contradiction" }>,
): JudgeItem {
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
    detail = unsupportedFigures(
      evalCase.claim.text,
      evalCase.facts.map((fact) => fact.value),
      true,
    );
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

function historicalSourceIds(context: unknown): ReadonlySet<string> {
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

function evidenceFigures(evidence: unknown): readonly number[] {
  const text = JSON.stringify(evidence).replaceAll(/(\d),(?=\d{3})/gu, "$1");
  return [
    ...text.matchAll(/(\d+(?:\.\d+)?(?:e[+-]?\d+)?)(?:\s?(trillion|billion|million))?/giu),
  ].map((match) => Number(match[1]) * (UNIT_SCALE[match[2]?.toLowerCase() ?? ""] ?? 1));
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
  readonly omissions: readonly string[];
} {
  const claims = claimsForReport(input.report);
  const current = new Set(input.knownSourceIds);
  const historical = historicalSourceIds(input.historicalContext);
  const facts = evidenceFigures(input.evidence);
  const cited = new Set(claims.flatMap((claim) => claim.sourceIds));
  return {
    claims: claims.length,
    staleSupport: claims
      .filter((claim) => staleSupport(claim, current, historical) !== undefined)
      .map((claim) => claim.location),
    unmatchedFigures: claims
      .map((claim) => ({
        location: claim.location,
        figures: unsupportedFigures(claim.text, facts, false),
      }))
      .filter((row) => row.figures.length > 0),
    omissions: input.omissionCases
      .filter((row) => omits(cited, row.requiredSourceIds))
      .map((row) => row.id),
  };
}
