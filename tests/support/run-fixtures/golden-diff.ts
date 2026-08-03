import { isDeepStrictEqual } from "node:util";
import { readGoldenOutput, scrubbedRunArtifacts, VOLATILE_KEYS, type JsonValue } from "./artifacts";

export type GoldenDiffBucket =
  | "changed-value"
  | "added-entry"
  | "removed-entry"
  | "prose"
  | "scrub-noise";

export type GoldenChangeKind = "changed" | "added" | "removed";

export type GoldenArrayIdentityStrategy =
  | "code"
  | "code-period-series"
  | "id"
  | "key-name"
  | "period"
  | "prediction"
  | "stage"
  | "string"
  | "text";

export interface GoldenArrayIdentityRule {
  readonly label: string;
  readonly path: RegExp;
  readonly strategy: GoldenArrayIdentityStrategy;
}

export const GOLDEN_ARRAY_IDENTITIES: readonly GoldenArrayIdentityRule[] = [
  {
    label: "statement facts",
    path: /\.financialStatements\.statements\..*\.(?:annual|interim)$/u,
    strategy: "period",
  },
  {
    label: "history facts",
    path: /\.fundamentalHistory\.series\.[^.]+\.(?:annual|interim)$/u,
    strategy: "period",
  },
  {
    label: "valuation observations",
    path: /\.valuationWorkbench\.historicalMultiples\.observations$/u,
    strategy: "period",
  },
  { label: "report sources", path: /^report\.sources$/u, strategy: "id" },
  { label: "data gaps", path: /^report\.dataGaps$/u, strategy: "string" },
  { label: "predictions", path: /^report\.predictions$/u, strategy: "prediction" },
  {
    label: "findings and scenarios",
    path: /^report\.(?:keyFindings|risks|bullCase|bearCase|catalysts)$/u,
    strategy: "text",
  },
  {
    label: "statement, lens, or history series",
    path: /(?:statements|financialLenses|fundamentalHistory).*(?:lenses|metrics|series)$/u,
    strategy: "key-name",
  },
  {
    label: "run stages",
    path: /^analytics\.runShape\.stages$/u,
    strategy: "stage",
  },
  {
    label: "structured financial gaps",
    path: /\.structuredFinancialGaps$/u,
    strategy: "code",
  },
  {
    label: "validation notes",
    path: /\.(?:validationNotes|omissionNotes)$/u,
    strategy: "code-period-series",
  },
  {
    label: "history notes",
    path: /\.fundamentalHistory\.series\.[^.]+\.notes$/u,
    strategy: "string",
  },
];

export interface GoldenDiffFinding {
  readonly path: string;
  readonly kind: GoldenChangeKind;
  readonly bucket: GoldenDiffBucket;
  readonly before?: JsonValue;
  readonly after?: JsonValue;
  readonly escalationReasons: readonly string[];
}

export interface GoldenDiffResult {
  readonly findings: readonly GoldenDiffFinding[];
  readonly counts: Readonly<Record<GoldenDiffBucket, number>>;
  readonly summary: {
    readonly changed: number;
    readonly added: number;
    readonly removed: number;
  };
  readonly escalated: readonly GoldenDiffFinding[];
  readonly positionalFallbacks: readonly string[];
  readonly reorderedArrays: readonly string[];
}

export interface GoldenReview {
  readonly equal: boolean;
  readonly diff: GoldenDiffResult;
}

export interface FormatGoldenDiffOptions {
  readonly topN?: number;
}

export type GoldenReplayMode = "check" | "keep" | "live" | "write";

export interface GoldenReplayRequest {
  readonly fixtureName: string;
  readonly mode: GoldenReplayMode;
}

interface MutableDiffState {
  readonly findings: GoldenDiffFinding[];
  readonly positionalFallbacks: Set<string>;
  readonly reorderedArrays: Set<string>;
}

const PROSE_KEYS = new Set(["markdown", "message", "summary", "justification", "note", "text"]);
const SENSITIVE_KEYS = new Set([
  "cagr",
  "marginChange",
  "years",
  "periodKey",
  "periodMonths",
  "currency",
  "unit",
]);

function isRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: JsonValue, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function numberField(value: JsonValue, key: string): number | undefined {
  return isRecord(value) && typeof value[key] === "number" ? value[key] : undefined;
}

function identityFor(strategy: GoldenArrayIdentityStrategy, value: JsonValue): string | undefined {
  if (strategy === "string") {
    return typeof value === "string" ? value : undefined;
  }
  if (!isRecord(value)) {
    return;
  }
  if (strategy === "id") {
    return stringField(value, "id");
  }
  if (strategy === "prediction") {
    return stringField(value, "id") ?? stringField(value, "measurableAs");
  }
  if (strategy === "text") {
    return stringField(value, "text");
  }
  if (strategy === "key-name") {
    return stringField(value, "key") ?? stringField(value, "name");
  }
  if (strategy === "stage") {
    const stage = stringField(value, "stage");
    const attempt = numberField(value, "attempt");
    return stage === undefined || attempt === undefined ? undefined : `${stage}|${attempt}`;
  }
  if (strategy === "code") {
    return stringField(value, "code");
  }
  if (strategy === "code-period-series") {
    const code = stringField(value, "code");
    const periodKey = stringField(value, "periodKey");
    const seriesKey = stringField(value, "seriesKey");
    return code === undefined ? undefined : `${code}|${periodKey ?? ""}|${seriesKey ?? ""}`;
  }
  const periodKey = stringField(value, "periodKey");
  if (periodKey !== undefined) {
    return `${periodKey}|${stringField(value, "concept") ?? ""}`;
  }
  const periodEnd = stringField(value, "periodEnd");
  if (periodEnd === undefined) {
    return;
  }
  return [
    stringField(value, "periodStart") ?? "",
    periodEnd,
    stringField(value, "basis") ?? "",
  ].join("|");
}

function identityGroups(
  values: readonly JsonValue[],
  rule: GoldenArrayIdentityRule,
): ReadonlyMap<string, readonly JsonValue[]> | undefined {
  const groups = new Map<string, JsonValue[]>();
  for (const value of values) {
    const identity = identityFor(rule.strategy, value);
    if (identity === undefined) {
      return;
    }
    const group = groups.get(identity) ?? [];
    group.push(value);
    groups.set(identity, group);
  }
  return groups;
}

function identityTokens(
  values: readonly JsonValue[],
  rule: GoldenArrayIdentityRule,
): readonly string[] {
  const occurrences = new Map<string, number>();
  return values.map((value) => {
    const identity = identityFor(rule.strategy, value)!;
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    return `${identity}#${String(occurrence)}`;
  });
}

function leafKey(path: string): string {
  const withoutIdentities = path.replaceAll(/\[[^\]]*\]/gu, "");
  return withoutIdentities.split(".").at(-1) ?? withoutIdentities;
}

function pathKeys(path: string): readonly string[] {
  return path.replaceAll(/\[[^\]]*\]/gu, "").split(".");
}

function valueType(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  return Array.isArray(value) ? "array" : typeof value;
}

function escalationReasons(
  path: string,
  kind: GoldenChangeKind,
  bucket: GoldenDiffBucket,
  before: JsonValue | undefined,
  after: JsonValue | undefined,
): readonly string[] {
  const reasons: string[] = [];
  if (before !== undefined && after !== undefined && valueType(before) !== valueType(after)) {
    reasons.push(`value type changed from ${valueType(before)} to ${valueType(after)}`);
  }
  if (typeof before === "number" && typeof after === "number") {
    if (before !== 0 && after !== 0 && Math.sign(before) !== Math.sign(after)) {
      reasons.push("numeric sign flip");
    }
    let relativeDelta = Math.abs((after - before) / before);
    if (before === 0) {
      relativeDelta = after === 0 ? 0 : Number.POSITIVE_INFINITY;
    }
    if (relativeDelta > 0.25) {
      reasons.push("numeric relative delta exceeds 25%");
    }
  }
  if (pathKeys(path).some((key) => SENSITIVE_KEYS.has(key))) {
    reasons.push("sensitive financial identity or unit changed");
  }
  if (
    kind === "removed" &&
    /(?:^|\.)(?:validationNotes|omissionNotes|dataGaps|structuredFinancialGaps|notes|gaps)(?:\.|\[|$)/u.test(
      path,
    )
  ) {
    reasons.push("warning or data gap removed");
  }
  if (bucket === "scrub-noise") {
    reasons.push("volatile value escaped artifact scrubbing");
  }
  return reasons;
}

function bucketFor(path: string, kind: GoldenChangeKind): GoldenDiffBucket {
  const key = leafKey(path);
  if (PROSE_KEYS.has(key)) {
    return "prose";
  }
  if (kind === "added") {
    return "added-entry";
  }
  if (kind === "removed") {
    return "removed-entry";
  }
  return "changed-value";
}

function addFinding(
  state: MutableDiffState,
  path: string,
  kind: GoldenChangeKind,
  before?: JsonValue,
  after?: JsonValue,
  forcedBucket?: GoldenDiffBucket,
): void {
  const bucket = forcedBucket ?? bucketFor(path, kind);
  state.findings.push({
    path,
    kind,
    bucket,
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
    escalationReasons: escalationReasons(path, kind, bucket, before, after),
  });
}

function markdownLcs(before: readonly string[], after: readonly string[]): readonly number[][] {
  const lengths = Array.from({ length: before.length + 1 }, () =>
    Array.from({ length: after.length + 1 }, () => 0),
  );
  for (let beforeIndex = before.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = after.length - 1; afterIndex >= 0; afterIndex -= 1) {
      lengths[beforeIndex]![afterIndex] =
        before[beforeIndex] === after[afterIndex]
          ? lengths[beforeIndex + 1]![afterIndex + 1]! + 1
          : Math.max(
              lengths[beforeIndex + 1]![afterIndex]!,
              lengths[beforeIndex]![afterIndex + 1]!,
            );
    }
  }
  return lengths;
}

function diffMarkdown(state: MutableDiffState, path: string, before: string, after: string): void {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const lengths = markdownLcs(beforeLines, afterLines);
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < beforeLines.length || afterIndex < afterLines.length) {
    if (
      beforeIndex < beforeLines.length &&
      afterIndex < afterLines.length &&
      beforeLines[beforeIndex] === afterLines[afterIndex]
    ) {
      beforeIndex += 1;
      afterIndex += 1;
      continue;
    }
    if (
      afterIndex < afterLines.length &&
      (beforeIndex >= beforeLines.length ||
        lengths[beforeIndex]![afterIndex + 1]! > lengths[beforeIndex + 1]![afterIndex]!)
    ) {
      addFinding(
        state,
        `${path}[after-line=${String(afterIndex + 1)}]`,
        "added",
        undefined,
        afterLines[afterIndex],
        "prose",
      );
      afterIndex += 1;
      continue;
    }
    addFinding(
      state,
      `${path}[before-line=${String(beforeIndex + 1)}]`,
      "removed",
      beforeLines[beforeIndex],
      undefined,
      "prose",
    );
    beforeIndex += 1;
  }
}

function identityPath(
  path: string,
  rule: GoldenArrayIdentityRule,
  identity: string,
  occurrence: number,
): string {
  const suffix = occurrence === 0 ? "" : `#${String(occurrence + 1)}`;
  return `${path}[${rule.label}=${JSON.stringify(identity)}${suffix}]`;
}

function diffIdentityArray(
  state: MutableDiffState,
  path: string,
  before: readonly JsonValue[],
  after: readonly JsonValue[],
  rule: GoldenArrayIdentityRule,
  beforeGroups: ReadonlyMap<string, readonly JsonValue[]>,
  afterGroups: ReadonlyMap<string, readonly JsonValue[]>,
): void {
  const beforeTokens = identityTokens(before, rule);
  const afterTokens = identityTokens(after, rule);
  const commonTokens = new Set(beforeTokens.filter((token) => afterTokens.includes(token)));
  if (
    !isDeepStrictEqual(
      beforeTokens.filter((token) => commonTokens.has(token)),
      afterTokens.filter((token) => commonTokens.has(token)),
    )
  ) {
    state.reorderedArrays.add(path);
  }
  const identities = [...new Set([...beforeGroups.keys(), ...afterGroups.keys()])].toSorted();
  for (const identity of identities) {
    const beforeValues = beforeGroups.get(identity) ?? [];
    const afterValues = afterGroups.get(identity) ?? [];
    const length = Math.max(beforeValues.length, afterValues.length);
    for (let occurrence = 0; occurrence < length; occurrence += 1) {
      const entryPath = identityPath(path, rule, identity, occurrence);
      if (occurrence >= beforeValues.length) {
        addFinding(state, entryPath, "added", undefined, afterValues[occurrence]);
      } else if (occurrence >= afterValues.length) {
        addFinding(state, entryPath, "removed", beforeValues[occurrence]);
      } else {
        walkGolden(state, entryPath, beforeValues[occurrence]!, afterValues[occurrence]!);
      }
    }
  }
}

function diffArray(
  state: MutableDiffState,
  path: string,
  before: readonly JsonValue[],
  after: readonly JsonValue[],
): void {
  const rule = GOLDEN_ARRAY_IDENTITIES.find((candidate) => candidate.path.test(path));
  const beforeGroups = rule === undefined ? undefined : identityGroups(before, rule);
  const afterGroups = rule === undefined ? undefined : identityGroups(after, rule);
  if (rule !== undefined && beforeGroups !== undefined && afterGroups !== undefined) {
    diffIdentityArray(state, path, before, after, rule, beforeGroups, afterGroups);
    return;
  }
  state.positionalFallbacks.add(
    rule === undefined
      ? `${path} (positional matching used: no identity rule matched this array path)`
      : `${path} (positional matching used: ${rule.label} rule matched, but at least one item lacked its identity)`,
  );
  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length; index += 1) {
    const entryPath = `${path}[${String(index)}]`;
    if (index >= before.length) {
      addFinding(state, entryPath, "added", undefined, after[index]);
    } else if (index >= after.length) {
      addFinding(state, entryPath, "removed", before[index]);
    } else {
      walkGolden(state, entryPath, before[index]!, after[index]!);
    }
  }
}

function walkGolden(
  state: MutableDiffState,
  path: string,
  before: JsonValue,
  after: JsonValue,
  scrubNoise = false,
): void {
  if (isDeepStrictEqual(before, after)) {
    return;
  }
  if (scrubNoise) {
    addFinding(state, path, "changed", before, after, "scrub-noise");
    return;
  }
  if (path === "markdown" && typeof before === "string" && typeof after === "string") {
    diffMarkdown(state, path, before, after);
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    diffArray(state, path, before, after);
    return;
  }
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].toSorted();
    for (const key of keys) {
      const childPath = path === "" ? key : `${path}.${key}`;
      const childScrubNoise =
        VOLATILE_KEYS.has(key) || (key === "durationMs" && ("stage" in before || "stage" in after));
      if (!(key in before)) {
        addFinding(
          state,
          childPath,
          "added",
          undefined,
          after[key],
          childScrubNoise ? "scrub-noise" : undefined,
        );
      } else if (!(key in after)) {
        addFinding(
          state,
          childPath,
          "removed",
          before[key],
          undefined,
          childScrubNoise ? "scrub-noise" : undefined,
        );
      } else {
        walkGolden(state, childPath, before[key]!, after[key]!, childScrubNoise);
      }
    }
    return;
  }
  addFinding(state, path, "changed", before, after);
}

export function diffGolden(before: JsonValue, after: JsonValue): GoldenDiffResult {
  const state: MutableDiffState = {
    findings: [],
    positionalFallbacks: new Set<string>(),
    reorderedArrays: new Set<string>(),
  };
  walkGolden(state, "", before, after);
  const counts: Record<GoldenDiffBucket, number> = {
    "changed-value": 0,
    "added-entry": 0,
    "removed-entry": 0,
    prose: 0,
    "scrub-noise": 0,
  };
  const summary = { changed: 0, added: 0, removed: 0 };
  for (const finding of state.findings) {
    counts[finding.bucket] += 1;
    summary[finding.kind] += 1;
  }
  return {
    findings: state.findings,
    counts,
    summary,
    escalated: state.findings.filter((finding) => finding.escalationReasons.length > 0),
    positionalFallbacks: [...state.positionalFallbacks].toSorted(),
    reorderedArrays: [...state.reorderedArrays].toSorted(),
  };
}

export function reviewGolden(before: JsonValue, after: JsonValue): GoldenReview {
  return { equal: isDeepStrictEqual(before, after), diff: diffGolden(before, after) };
}

export async function reviewFixtureGolden(
  runDir: string,
  fixtureName: string,
): Promise<GoldenReview> {
  const [golden, current] = await Promise.all([
    readGoldenOutput(fixtureName),
    scrubbedRunArtifacts(runDir),
  ]);
  return reviewGolden(golden, current);
}

export function parseGoldenReplayArgs(args: readonly string[]): GoldenReplayRequest {
  const fixtureNames = args.filter((argument) => !argument.startsWith("--"));
  const flags = args.filter((argument) => argument.startsWith("--"));
  const [flag] = flags;
  if (
    fixtureNames.length !== 1 ||
    flags.length > 1 ||
    (flag !== undefined &&
      flag !== "--live" &&
      flag !== "--keep" &&
      flag !== "--write-golden" &&
      flag !== "--check-golden")
  ) {
    throw new Error(
      "Usage: bun run scripts/replay-fixture-run.ts <fixture-name> [--live|--keep|--check-golden|--write-golden]",
    );
  }
  let mode: GoldenReplayMode = "check";
  if (flag === "--live") {
    mode = "live";
  } else if (flag === "--keep") {
    mode = "keep";
  } else if (flag === "--write-golden") {
    mode = "write";
  }
  const [fixtureName] = fixtureNames;
  return { fixtureName: fixtureName!, mode };
}

function renderValue(value: JsonValue | undefined, truncate: boolean): string {
  if (value === undefined) {
    return "<missing>";
  }
  const rendered = JSON.stringify(value);
  return truncate && rendered.length > 240 ? `${rendered.slice(0, 237)}...` : rendered;
}

function formatFinding(finding: GoldenDiffFinding, truncate: boolean): string {
  const reasons =
    finding.escalationReasons.length === 0 ? "" : ` (${finding.escalationReasons.join("; ")})`;
  return `- [${finding.bucket}] ${finding.path}${reasons}: ${renderValue(finding.before, truncate)} -> ${renderValue(finding.after, truncate)}`;
}

export function formatGoldenDiff(
  diff: GoldenDiffResult,
  options: FormatGoldenDiffOptions = {},
): string {
  const topN = Math.max(0, options.topN ?? 20);
  const lines = [
    `Golden diff: ${String(diff.summary.changed)} changed / ${String(diff.summary.added)} added / ${String(diff.summary.removed)} removed`,
    `Buckets: changed-value ${String(diff.counts["changed-value"])}, added-entry ${String(diff.counts["added-entry"])}, removed-entry ${String(diff.counts["removed-entry"])}, prose ${String(diff.counts.prose)}, scrub-noise ${String(diff.counts["scrub-noise"])}`,
  ];
  if (diff.positionalFallbacks.length > 0) {
    lines.push(
      "Positional array fallbacks (action: add a stable identity rule, or verify positional matching is intentional):",
      ...diff.positionalFallbacks.map((path) => `- ${path}`),
    );
  }
  if (diff.reorderedArrays.length > 0) {
    lines.push(
      "Identity-matched array order changes:",
      ...diff.reorderedArrays.map((path) => `- ${path}`),
    );
  }
  if (diff.escalated.length > 0) {
    lines.push(
      "Escalated findings:",
      ...diff.escalated.map((finding) => formatFinding(finding, false)),
    );
  }
  const escalated = new Set(diff.escalated);
  const remaining = diff.findings.filter((finding) => !escalated.has(finding));
  if (remaining.length > 0 && topN > 0) {
    lines.push(
      `Other findings (top ${String(Math.min(topN, remaining.length))} of ${String(remaining.length)}):`,
      ...remaining.slice(0, topN).map((finding) => formatFinding(finding, true)),
    );
  }
  if (diff.findings.length === 0) {
    lines.push("No value changes detected.");
  }
  return lines.join("\n");
}

export function formatGoldenMismatch(fixtureName: string, diff: GoldenDiffResult): string {
  return `Golden output for ${fixtureName} drifted; inspect and run bun run scripts/replay-fixture-run.ts ${fixtureName} --write-golden if intentional\n${formatGoldenDiff(diff)}`;
}
