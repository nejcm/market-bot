import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { isRecord, readNumber, readString, readStringArray } from "../src/guards";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..");
const DATA_DIR = resolve(REPOSITORY_ROOT, "data");
const EVALUATIONS_DIR = resolve(DATA_DIR, "evaluations");
const EVALUATION_PREFIX = "deep-equity-";
const EVALUATION_FILE = "evaluation.json";
const REPORT_FILE = "report.json";
const BUNDLE_FILE = "normalized/evidence-bundle.json";
const SHARED_NOTE =
  "These values come from the single evidence bundle both arms consumed. They are identical by construction and are not a comparison.";
const GAP_BASIS = "deterministic-append, identical by construction";

export type VariantName = "legacy" | "simplified";
export type EvidenceClass = "core" | "material" | "supplemental";
export type UnavailableReason =
  | "variant-failure"
  | "artifact-unreadable"
  | "pair-missing"
  | "evidence-input-divergent"
  | "evidence-annotations-divergent"
  | "lane-has-no-collected-sources"
  | "no-deterministic-rendering"
  | "plan-provenance-not-run-input"
  | "malformed-ledger-entries";
export type DenominatorRef =
  | { readonly name: "lane-mapped-collected"; readonly symbol: "D1"; readonly value: number }
  | { readonly name: "lane-collected"; readonly lane: string; readonly value: number }
  | {
      readonly name: "evidence-class-collected";
      readonly evidenceClass: EvidenceClass;
      readonly value: number;
    }
  | {
      readonly name: "deterministic-source-gaps";
      readonly cause?: string;
      readonly value: number;
    };
export type Measured =
  | { readonly status: "measured"; readonly value: number; readonly denominator: DenominatorRef }
  | { readonly status: "unavailable"; readonly reason: UnavailableReason };

export interface ParsedArguments {
  readonly root?: string;
  readonly json: boolean;
  readonly out?: string;
}
interface Plan {
  readonly provenance: string;
  readonly loadSource: string;
  readonly scenarios: readonly string[];
  readonly repetitions: readonly number[];
  readonly expectedPairCount: number;
}
export interface Governance {
  readonly evidenceLanes: Readonly<Record<string, unknown>>;
  readonly sourceGaps: readonly unknown[];
  readonly sourceLedger: Readonly<Record<string, unknown>>;
}
export interface SourceItem {
  readonly id: string;
  readonly lanes: readonly string[];
  readonly evidenceClasses: readonly EvidenceClass[];
  readonly kind?: string;
}
export interface MalformedLedgerEntry {
  readonly index: number;
  readonly reason: "entry-not-record" | "id-missing-or-invalid";
  readonly lane?: string;
  readonly kind?: string;
}
export interface CoverageMeasurement {
  readonly citedSourceIds: readonly string[];
  readonly uncitedSourceIds: readonly string[];
  readonly measurement: Measured;
}
export interface GapDisclosure {
  readonly key: string;
  readonly source?: string;
  readonly cause?: string;
  readonly symbol?: string;
  readonly rendering?: string;
  readonly status: "disclosed" | "not-disclosed" | "undetermined";
  readonly reason?: "no-deterministic-rendering";
}
export interface GapFacet {
  readonly disclosedCount: Measured;
  readonly notDisclosedCount: Measured;
  readonly undeterminedCount: Measured;
}
export interface VariantCoverage {
  readonly lanes: readonly (CoverageMeasurement & {
    readonly lane: string;
    readonly evidenceClass?: EvidenceClass;
  })[];
  readonly byEvidenceClass: Readonly<Record<EvidenceClass, CoverageMeasurement>>;
  readonly laneMapped: CoverageMeasurement;
  readonly uncitedCollectedSources: readonly SourceItem[];
  readonly carriedNotLaneMapped: readonly SourceItem[];
  readonly citedNotLaneMapped: readonly SourceItem[];
  readonly sourceDenominators: {
    readonly laneMappedCollectedSourceIds: number;
    readonly laneMembershipEntries: number;
    readonly reportCarriedSources: number;
    readonly multiLaneDuplicateEntries: number;
    readonly malformedLedgerEntries: {
      readonly count: number;
      readonly entries: readonly MalformedLedgerEntry[];
    };
    readonly omissionCheckAuthoritative: boolean;
    readonly d1PlusCarriedNotLaneMappedEqualsD3: boolean;
    readonly d2MinusD1EqualsMultiLaneDuplicateEntries: boolean;
  };
  readonly gapDisclosure: GapFacet & {
    readonly basis: typeof GAP_BASIS;
    readonly entries: readonly GapDisclosure[];
    readonly byCause: Readonly<Record<string, GapFacet>>;
    readonly providerDataMissing: GapFacet;
  };
}
export type ArmAssessment =
  | { readonly status: "available"; readonly runDir?: string; readonly governanceHash: string }
  | {
      readonly status: "unavailable";
      readonly reason: "variant-failure" | "artifact-unreadable" | "pair-missing";
      readonly runDir?: string;
      readonly error?: string;
    };
export interface PairAssessment {
  readonly pair: string;
  readonly scenario: string;
  readonly repetition: number;
  readonly judged: boolean;
  readonly status: "compared" | "not-adjudicable" | "unavailable" | "missing";
  readonly sharedEvidenceInput:
    | "verified-identical"
    | "identical-modulo-annotations"
    | "divergent"
    | "unverifiable";
  readonly arms: Readonly<Record<VariantName, ArmAssessment>>;
  readonly unavailableReasons: readonly UnavailableReason[];
  readonly sharedCoverageContext?: Readonly<Record<string, unknown>>;
}
export interface CoverageComparison {
  readonly pair: string;
  readonly scenario: string;
  readonly repetition: number;
  readonly variants: Readonly<Record<VariantName, VariantCoverage>>;
  readonly omissions: {
    readonly legacyUncited: readonly SourceItem[];
    readonly simplifiedUncited: readonly SourceItem[];
    readonly simplifiedOnlyUncited: readonly SourceItem[];
    readonly legacyOnlyUncited: readonly SourceItem[];
    readonly bothUncited: readonly SourceItem[];
    readonly simplifiedOnlyCoreMaterial: readonly SourceItem[];
    readonly simplifiedOnlyCoreMaterialCount: Measured;
  };
}
export interface CoverageDiffTotals {
  readonly plannedPairCount: number;
  readonly pairsCompared: number;
  readonly pairsNotAdjudicable: number;
  readonly pairsUnavailable: number;
  readonly pairsMissing: number;
  readonly reconciles: boolean;
  readonly coreMaterialOmissionCount: Measured;
  readonly omissionCheckUnavailableCount: number;
  readonly unmatchedRecordCount: number;
}
export interface CoverageDiffArtifact {
  readonly version: 1;
  readonly evaluationRoot: string;
  readonly selectedAutomatically: boolean;
  readonly plan: Plan;
  readonly adjudicable: boolean;
  readonly adjudicationBlockers: readonly {
    readonly reason: UnavailableReason | "plan-load-source-operator-recovery";
    readonly pairs: readonly string[];
    readonly blocking: boolean;
  }[];
  readonly totals: CoverageDiffTotals;
  readonly pairs: readonly PairAssessment[];
  readonly comparisons: readonly CoverageComparison[];
  readonly notComparedAndWhy: readonly {
    readonly subject: string;
    readonly reason: string;
  }[];
}

interface SourceState {
  readonly lanes: Set<string>;
  readonly evidenceClasses: Set<EvidenceClass>;
  kind?: string;
}
interface SourceCatalog {
  readonly sources: ReadonlyMap<string, SourceState>;
  readonly malformedEntries: readonly MalformedLedgerEntry[];
}
interface ArmResult {
  readonly assessment: ArmAssessment;
  readonly report?: Readonly<Record<string, unknown>>;
  readonly governance?: Governance;
}

function usage(): never {
  throw new Error(
    "Usage: bun run scripts/diff-evidence-coverage.ts [evaluation-root] [--json] [--out <path>]\n" +
      "       Informs the zero-critical-material-evidence-omissions operator gate.\n" +
      "       It does not decide it and emits no pass/fail verdict.",
  );
}
function requiredFlagValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new TypeError(`${flag} requires a value`);
  }
  return value;
}
export function parseArguments(args: readonly string[]): ParsedArguments {
  let root: string | undefined = undefined;
  let json = false;
  let out: string | undefined = undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      json = true;
    } else if (argument === "--out") {
      out = requiredFlagValue(args, index, argument);
      index += 1;
    } else if (argument === undefined || argument.startsWith("--") || root !== undefined) {
      usage();
    } else {
      root = argument;
    }
  }
  return {
    ...(root === undefined ? {} : { root }),
    json,
    ...(out === undefined ? {} : { out }),
  };
}

function measured(value: number, denominator: DenominatorRef): Measured {
  return { status: "measured", value, denominator };
}
function asEvidenceClass(value: unknown): EvidenceClass | undefined {
  return value === "core" || value === "material" || value === "supplemental" ? value : undefined;
}
function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string"))]
    : [];
}
function governanceOf(bundle: unknown): Governance | undefined {
  if (!isRecord(bundle) || !isRecord(bundle.governance)) {
    return undefined;
  }
  const value = bundle.governance;
  if (
    !isRecord(value.evidenceLanes) ||
    !Array.isArray(value.evidenceLanes.lanes) ||
    !Array.isArray(value.sourceGaps) ||
    !isRecord(value.sourceLedger) ||
    !Array.isArray(value.sourceLedger.sources)
  ) {
    return undefined;
  }
  return {
    evidenceLanes: value.evidenceLanes,
    sourceGaps: value.sourceGaps,
    sourceLedger: value.sourceLedger,
  };
}
function planOf(evaluation: unknown): Plan {
  if (!isRecord(evaluation) || !isRecord(evaluation.plan)) {
    throw new Error("evaluation.json does not contain an authoritative plan");
  }
  const raw = evaluation.plan;
  const scenarios =
    Array.isArray(raw.scenarios) &&
    raw.scenarios.every((value): value is string => typeof value === "string" && value !== "")
      ? raw.scenarios
      : undefined;
  const repetitions =
    Array.isArray(raw.repetitions) &&
    raw.repetitions.every((value): value is number => Number.isInteger(value) && value > 0)
      ? raw.repetitions
      : undefined;
  const expectedPairCount = readNumber(raw, "expectedPairCount");
  if (
    scenarios === undefined ||
    repetitions === undefined ||
    scenarios.length === 0 ||
    repetitions.length === 0 ||
    expectedPairCount !== scenarios.length * repetitions.length
  ) {
    throw new Error("evaluation.json plan does not define a consistent planned pair denominator");
  }
  return {
    provenance: readString(raw, "provenance") ?? "(missing)",
    loadSource: readString(raw, "loadSource") ?? "(missing)",
    scenarios,
    repetitions,
    expectedPairCount,
  };
}

export function resolvedRunDir(runDir: string): string {
  return isAbsolute(runDir) ? runDir : resolve(REPOSITORY_ROOT, runDir);
}
export function collectCitationReferences(
  value: unknown,
  references: string[] = [],
): readonly string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectCitationReferences(item, references);
    }
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (key === "sourceIds" && Array.isArray(item)) {
        references.push(...item.filter((id): id is string => typeof id === "string"));
      } else {
        collectCitationReferences(item, references);
      }
    }
  }
  return references;
}
export function hashGovernance(governance: Governance): string {
  return new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify({
        evidenceLanes: governance.evidenceLanes,
        sourceGaps: governance.sourceGaps,
        sourceLedger: governance.sourceLedger,
      }),
    )
    .digest("hex");
}

// Collect-once-run-both does not make the persisted bundle byte-identical across arms.
// On equity-nbis-deep a financial-table-mapping MODEL stage runs inside both variants.
// Untagged-table validation then writes its rejection reasons into governance gap prose.
// Two arms sharing one collected input therefore still hash differently.
// Measured on equity-nbis-deep/3: ledger, coveredSourceIds and gapIds all identical.
// Only the human-readable gap text differed, and the whole pair was discarded for it.
// That reported "could not check" about a pair that was fully checkable.
// It is the denominator-laundering failure class pointing the conservative way.
// This hash covers only what the omission analysis actually reads.
// So annotation prose cannot suppress a real comparison, and a real input divergence still can.
export function hashAdjudicationRelevantGovernance(governance: Governance): string {
  return new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify({
        sourceLedger: governance.sourceLedger,
        lanes: lanesOf(governance).map((lane) => ({
          lane: lane.lane,
          evidenceClass: lane.evidenceClass,
          status: lane.status,
          coveredSourceIds: lane.coveredSourceIds,
          gapIds: lane.gapIds,
        })),
      }),
    )
    .digest("hex");
}

function lanesOf(governance: Governance): readonly Record<string, unknown>[] {
  return (governance.evidenceLanes.lanes as readonly unknown[]).filter((lane) => isRecord(lane));
}
function sourceCatalog(governance: Governance): SourceCatalog {
  const catalog = new Map<string, SourceState>();
  const malformedEntries: MalformedLedgerEntry[] = [];
  const laneClasses = new Map(
    lanesOf(governance).flatMap((lane) => {
      const name = readString(lane, "lane");
      const laneClass = asEvidenceClass(lane.evidenceClass);
      return name === undefined || laneClass === undefined ? [] : [[name, laneClass] as const];
    }),
  );
  for (const [index, candidate] of (
    governance.sourceLedger.sources as readonly unknown[]
  ).entries()) {
    if (!isRecord(candidate)) {
      malformedEntries.push({ index, reason: "entry-not-record" });
      continue;
    }
    const entry = candidate;
    const id = readString(entry, "id");
    if (id === undefined) {
      const lane = readString(entry, "lane");
      const kind = readString(entry, "kind");
      malformedEntries.push({
        index,
        reason: "id-missing-or-invalid",
        ...(lane === undefined ? {} : { lane }),
        ...(kind === undefined ? {} : { kind }),
      });
      continue;
    }
    const state =
      catalog.get(id) ??
      ({
        lanes: new Set<string>(),
        evidenceClasses: new Set<EvidenceClass>(),
      } satisfies SourceState);
    const lane = readString(entry, "lane");
    if (lane !== undefined) {
      state.lanes.add(lane);
      const laneClass = laneClasses.get(lane);
      if (laneClass !== undefined) {
        state.evidenceClasses.add(laneClass);
      }
    }
    const kind = readString(entry, "kind");
    if (state.kind === undefined && kind !== undefined) {
      state.kind = kind;
    }
    catalog.set(id, state);
  }
  return { sources: catalog, malformedEntries };
}
function reportCatalog(report: Readonly<Record<string, unknown>>): ReadonlyMap<string, string> {
  const catalog = new Map<string, string>();
  for (const source of Array.isArray(report.sources) ? report.sources : []) {
    if (!isRecord(source)) {
      continue;
    }
    const id = readString(source, "id");
    if (id !== undefined && !catalog.has(id)) {
      catalog.set(id, readString(source, "kind") ?? "");
    }
  }
  return catalog;
}
function sourceItems(
  ids: readonly string[],
  catalog: ReadonlyMap<string, SourceState>,
  report?: ReadonlyMap<string, string>,
): readonly SourceItem[] {
  return ids.map((id) => {
    const state = catalog.get(id);
    const kind = state?.kind ?? report?.get(id);
    return {
      id,
      lanes: state === undefined ? [] : [...state.lanes],
      evidenceClasses: state === undefined ? [] : [...state.evidenceClasses],
      ...(kind === undefined || kind === "" ? {} : { kind }),
    };
  });
}
function coverage(
  cited: ReadonlySet<string>,
  denominatorIds: readonly string[],
  denominator: DenominatorRef,
): CoverageMeasurement {
  const citedSourceIds = denominatorIds.filter((id) => cited.has(id));
  return {
    citedSourceIds,
    uncitedSourceIds: denominatorIds.filter((id) => !cited.has(id)),
    measurement:
      denominatorIds.length === 0
        ? { status: "unavailable", reason: "lane-has-no-collected-sources" }
        : measured(citedSourceIds.length / denominatorIds.length, denominator),
  };
}

function gapRendering(gap: Readonly<Record<string, unknown>>): string | undefined {
  const source = readString(gap, "source");
  const message = readString(gap, "message")?.replaceAll(/\s+/gu, " ").trim();
  if (source === undefined || message === undefined) {
    return undefined;
  }
  const base = `${source}: ${message}`;
  const symbol = readString(gap, "symbol")?.trim();
  return symbol === undefined || base.toUpperCase().includes(symbol.toUpperCase())
    ? base
    : `${base} [${symbol}]`;
}
function gapFacet(entries: readonly GapDisclosure[], cause?: string): GapFacet {
  const denominator: DenominatorRef = {
    name: "deterministic-source-gaps",
    ...(cause === undefined ? {} : { cause }),
    value: entries.length,
  };
  const count = (status: GapDisclosure["status"]): Measured =>
    measured(entries.filter((entry) => entry.status === status).length, denominator);
  return {
    disclosedCount: count("disclosed"),
    notDisclosedCount: count("not-disclosed"),
    undeterminedCount: count("undetermined"),
  };
}
export function analyzeGapDisclosure(
  report: Readonly<Record<string, unknown>>,
  sourceGaps: readonly unknown[],
): VariantCoverage["gapDisclosure"] {
  const dataGaps = strings(report.dataGaps);
  const entries = sourceGaps
    .filter((gap) => isRecord(gap))
    .map((gap): GapDisclosure => {
      const source = readString(gap, "source");
      const cause = readString(gap, "cause");
      const symbol = readString(gap, "symbol");
      const rendering = gapRendering(gap);
      const common = {
        key: JSON.stringify([source ?? null, cause ?? null, symbol ?? null]),
        ...(source === undefined ? {} : { source }),
        ...(cause === undefined ? {} : { cause }),
        ...(symbol === undefined ? {} : { symbol }),
      };
      return rendering === undefined
        ? { ...common, status: "undetermined", reason: "no-deterministic-rendering" }
        : {
            ...common,
            rendering,
            status: dataGaps.some((gapText) => gapText.startsWith(rendering))
              ? "disclosed"
              : "not-disclosed",
          };
    });
  const causes = [...new Set(entries.map((entry) => entry.cause ?? "(missing cause)"))];
  const byCause = Object.fromEntries(
    causes.map((cause) => [
      cause,
      gapFacet(
        entries.filter((entry) => (entry.cause ?? "(missing cause)") === cause),
        cause,
      ),
    ]),
  );
  return {
    basis: GAP_BASIS,
    entries,
    ...gapFacet(entries),
    byCause,
    providerDataMissing: byCause["provider-data-missing"] ?? gapFacet([], "provider-data-missing"),
  };
}

function buildVariantCoverage(
  report: Readonly<Record<string, unknown>>,
  governance: Governance,
): VariantCoverage {
  const cited = new Set(collectCitationReferences(report));
  const lanes = lanesOf(governance);
  const laneCoverage = lanes.map((lane) => {
    const name = readString(lane, "lane") ?? "(missing lane)";
    const laneClass = asEvidenceClass(lane.evidenceClass);
    const ids = strings(lane.coveredSourceIds);
    return {
      lane: name,
      ...(laneClass === undefined ? {} : { evidenceClass: laneClass }),
      ...coverage(cited, ids, { name: "lane-collected", lane: name, value: ids.length }),
    };
  });
  const byEvidenceClass = Object.fromEntries(
    (["core", "material", "supplemental"] as const).map((laneClass) => {
      const ids = [
        ...new Set(
          lanes
            .filter((lane) => asEvidenceClass(lane.evidenceClass) === laneClass)
            .flatMap((lane) => strings(lane.coveredSourceIds)),
        ),
      ];
      return [
        laneClass,
        coverage(cited, ids, {
          name: "evidence-class-collected",
          evidenceClass: laneClass,
          value: ids.length,
        }),
      ];
    }),
  ) as unknown as Readonly<Record<EvidenceClass, CoverageMeasurement>>;
  const { sources: catalog, malformedEntries } = sourceCatalog(governance);
  const d1Ids = [...catalog.keys()];
  const reportSources = reportCatalog(report);
  const d3Ids = [...reportSources.keys()];
  const carriedIds = d3Ids.filter((id) => !catalog.has(id));
  const d2 = Array.isArray(governance.sourceLedger.sources)
    ? governance.sourceLedger.sources.length
    : 0;
  const d3 = Array.isArray(report.sources) ? report.sources.length : 0;
  const cataloguedLaneMemberships = [...catalog.values()].reduce(
    (sum, source) => sum + source.lanes.size,
    0,
  );
  const multiLaneDuplicateEntries = cataloguedLaneMemberships - d1Ids.length;
  return {
    lanes: laneCoverage,
    byEvidenceClass,
    laneMapped: coverage(cited, d1Ids, {
      name: "lane-mapped-collected",
      symbol: "D1",
      value: d1Ids.length,
    }),
    uncitedCollectedSources: sourceItems(
      d1Ids.filter((id) => !cited.has(id)),
      catalog,
    ),
    carriedNotLaneMapped: sourceItems(carriedIds, catalog, reportSources),
    citedNotLaneMapped: sourceItems(
      carriedIds.filter((id) => cited.has(id)),
      catalog,
      reportSources,
    ),
    sourceDenominators: {
      laneMappedCollectedSourceIds: d1Ids.length,
      laneMembershipEntries: d2,
      reportCarriedSources: d3,
      multiLaneDuplicateEntries,
      malformedLedgerEntries: {
        count: malformedEntries.length,
        entries: malformedEntries,
      },
      omissionCheckAuthoritative: malformedEntries.length === 0,
      d1PlusCarriedNotLaneMappedEqualsD3: d1Ids.length + carriedIds.length === d3,
      d2MinusD1EqualsMultiLaneDuplicateEntries: d2 - d1Ids.length === multiLaneDuplicateEntries,
    },
    gapDisclosure: analyzeGapDisclosure(report, governance.sourceGaps),
  };
}
export function analyzeVariantCoverage(report: unknown, bundle: unknown): VariantCoverage {
  const governance = governanceOf(bundle);
  if (!isRecord(report) || governance === undefined) {
    throw new Error("report or evidence bundle is not analyzable");
  }
  return buildVariantCoverage(report, governance);
}

function sharedContext(governance: Governance): Readonly<Record<string, unknown>> {
  const summary = isRecord(governance.evidenceLanes.summary)
    ? governance.evidenceLanes.summary
    : {};
  return {
    sharedCoverageContextNote: SHARED_NOTE,
    coverageRatio: readNumber(summary, "coverageRatio") ?? null,
    plannedLaneCount: readNumber(summary, "plannedLaneCount") ?? null,
    coreGapLaneCount: readNumber(summary, "coreGapLaneCount") ?? null,
    materialGapLaneCount: readNumber(summary, "materialGapLaneCount") ?? null,
    lanes: lanesOf(governance).map((lane) => ({
      lane: readString(lane, "lane") ?? "(missing lane)",
      evidenceClass: asEvidenceClass(lane.evidenceClass) ?? null,
      status: readString(lane, "status") ?? null,
      gapIds: readStringArray(lane, "gapIds") ?? [],
    })),
  };
}
function assessArm(value: unknown): ArmResult {
  if (!isRecord(value)) {
    return {
      assessment: {
        status: "unavailable",
        reason: "variant-failure",
        error: "missing variant record",
      },
    };
  }
  const status = readString(value, "status");
  const runDir = readString(value, "runDir");
  if (status !== "success") {
    return {
      assessment: {
        status: "unavailable",
        reason: "variant-failure",
        ...(runDir === undefined ? {} : { runDir }),
        error: readString(value, "error") ?? `variant status is ${status ?? "missing"}`,
      },
    };
  }
  const governance = governanceOf(value.bundle);
  const artifactError = readString(value, "artifactError");
  if (artifactError !== undefined || governance === undefined || !isRecord(value.report)) {
    return {
      assessment: {
        status: "unavailable",
        reason: "artifact-unreadable",
        ...(runDir === undefined ? {} : { runDir }),
        error: artifactError ?? "report or evidence bundle is unreadable",
      },
    };
  }
  return {
    assessment: {
      status: "available",
      ...(runDir === undefined ? {} : { runDir }),
      governanceHash: hashGovernance(governance),
    },
    report: value.report,
    governance,
  };
}
function compareOmissions(
  legacy: VariantCoverage,
  simplified: VariantCoverage,
): CoverageComparison["omissions"] {
  const legacyIds = new Set(legacy.uncitedCollectedSources.map((source) => source.id));
  const simplifiedIds = new Set(simplified.uncitedCollectedSources.map((source) => source.id));
  const simplifiedOnly = simplified.uncitedCollectedSources.filter(
    (source) => !legacyIds.has(source.id),
  );
  const coreMaterial = simplifiedOnly.filter((source) =>
    source.evidenceClasses.some((value) => value === "core" || value === "material"),
  );
  const d1 = simplified.sourceDenominators.laneMappedCollectedSourceIds;
  return {
    legacyUncited: legacy.uncitedCollectedSources,
    simplifiedUncited: simplified.uncitedCollectedSources,
    simplifiedOnlyUncited: simplifiedOnly,
    legacyOnlyUncited: legacy.uncitedCollectedSources.filter(
      (source) => !simplifiedIds.has(source.id),
    ),
    bothUncited: legacy.uncitedCollectedSources.filter((source) => simplifiedIds.has(source.id)),
    simplifiedOnlyCoreMaterial: coreMaterial,
    simplifiedOnlyCoreMaterialCount: measured(coreMaterial.length, {
      name: "lane-mapped-collected",
      symbol: "D1",
      value: d1,
    }),
  };
}

export function analyzePairCoverage(
  scenario: string,
  repetition: number,
  record: Readonly<Record<string, unknown>> | undefined,
): { readonly assessment: PairAssessment; readonly comparison?: CoverageComparison } {
  const pair = `${scenario}/${String(repetition)}`;
  if (record === undefined) {
    const arm: ArmAssessment = {
      status: "unavailable",
      reason: "pair-missing",
      error: "planned pair has no record",
    };
    return {
      assessment: {
        pair,
        scenario,
        repetition,
        judged: false,
        status: "missing",
        sharedEvidenceInput: "unverifiable",
        arms: { legacy: arm, simplified: arm },
        unavailableReasons: ["pair-missing"],
      },
    };
  }
  const variants = isRecord(record.variants) ? record.variants : {};
  const legacy = assessArm(variants.legacy);
  const simplified = assessArm(variants.simplified);
  const arms = { legacy: legacy.assessment, simplified: simplified.assessment };
  const unavailable = Object.values(arms).filter(
    (arm): arm is Extract<ArmAssessment, { status: "unavailable" }> => arm.status === "unavailable",
  );
  if (unavailable.length > 0) {
    return {
      assessment: {
        pair,
        scenario,
        repetition,
        judged: isRecord(record.judge),
        status: "unavailable",
        sharedEvidenceInput: "unverifiable",
        arms,
        unavailableReasons: [...new Set(unavailable.map((arm) => arm.reason))],
      },
    };
  }
  if (
    legacy.assessment.status !== "available" ||
    simplified.assessment.status !== "available" ||
    legacy.governance === undefined ||
    simplified.governance === undefined ||
    legacy.report === undefined ||
    simplified.report === undefined
  ) {
    throw new Error(`available pair ${pair} lost loaded artifacts`);
  }
  const governanceDiffers =
    legacy.assessment.governanceHash !== simplified.assessment.governanceHash;
  const adjudicationInputDiffers =
    hashAdjudicationRelevantGovernance(legacy.governance) !==
    hashAdjudicationRelevantGovernance(simplified.governance);
  if (adjudicationInputDiffers) {
    return {
      assessment: {
        pair,
        scenario,
        repetition,
        judged: isRecord(record.judge),
        status: "not-adjudicable",
        sharedEvidenceInput: "divergent",
        arms,
        unavailableReasons: ["evidence-input-divergent"],
      },
    };
  }
  // Annotation-only divergence: the arms read the same sources and lanes, so the omission
  // Comparison below is valid. Reported rather than dropped, and never silent — the reason travels
  // With the pair so a reader can see that the bundles were not byte-identical.
  const annotationsDiverge = governanceDiffers;
  const legacyCoverage = buildVariantCoverage(legacy.report, legacy.governance);
  const simplifiedCoverage = buildVariantCoverage(simplified.report, simplified.governance);
  const hasMalformedLedgerEntries =
    !legacyCoverage.sourceDenominators.omissionCheckAuthoritative ||
    !simplifiedCoverage.sourceDenominators.omissionCheckAuthoritative;
  return {
    assessment: {
      pair,
      scenario,
      repetition,
      judged: isRecord(record.judge),
      status: "compared",
      sharedEvidenceInput: annotationsDiverge
        ? "identical-modulo-annotations"
        : "verified-identical",
      arms,
      unavailableReasons: [
        ...(hasMalformedLedgerEntries ? (["malformed-ledger-entries"] as const) : []),
        ...(annotationsDiverge ? (["evidence-annotations-divergent"] as const) : []),
      ],
      sharedCoverageContext: sharedContext(legacy.governance),
    },
    comparison: {
      pair,
      scenario,
      repetition,
      variants: { legacy: legacyCoverage, simplified: simplifiedCoverage },
      omissions: compareOmissions(legacyCoverage, simplifiedCoverage),
    },
  };
}

function recordsOf(evaluation: unknown): readonly Record<string, unknown>[] {
  return isRecord(evaluation) && Array.isArray(evaluation.records)
    ? evaluation.records.filter(isRecord)
    : [];
}
export function analyzeEvaluation(
  evaluation: unknown,
  evaluationRoot = "(in-memory)",
  selectedAutomatically = false,
): CoverageDiffArtifact {
  const plan = planOf(evaluation);
  const records = recordsOf(evaluation);
  const unmatchedRecordCount = records.filter((record) => {
    const scenario = readString(record, "scenario");
    const repetition = readNumber(record, "repetition");
    return (
      scenario === undefined ||
      repetition === undefined ||
      !plan.scenarios.includes(scenario) ||
      !plan.repetitions.includes(repetition)
    );
  }).length;
  const results = plan.scenarios.flatMap((scenario) =>
    plan.repetitions.map((repetition) =>
      analyzePairCoverage(
        scenario,
        repetition,
        records.find(
          (record) =>
            readString(record, "scenario") === scenario &&
            readNumber(record, "repetition") === repetition,
        ),
      ),
    ),
  );
  const pairs = results.map((result) => result.assessment);
  const comparisons = results.flatMap((result) =>
    result.comparison === undefined ? [] : [result.comparison],
  );
  const count = (status: PairAssessment["status"]): number =>
    pairs.filter((pair) => pair.status === status).length;
  const pairsCompared = count("compared");
  const pairsNotAdjudicable = count("not-adjudicable");
  const pairsUnavailable = count("unavailable");
  const pairsMissing = count("missing");
  const malformedLedgerPairCount = pairs.filter((pair) =>
    pair.unavailableReasons.includes("malformed-ledger-entries"),
  ).length;
  const reconciles =
    pairsCompared + pairsNotAdjudicable + pairsUnavailable + pairsMissing ===
    plan.expectedPairCount;
  if (!reconciles) {
    throw new Error("coverage diff totals do not reconcile to the plan");
  }
  const allPairs = pairs.map((pair) => pair.pair);
  const adjudicationBlockers: CoverageDiffArtifact["adjudicationBlockers"][number][] = [];
  if (plan.provenance !== "run-input") {
    adjudicationBlockers.push({
      reason: "plan-provenance-not-run-input",
      pairs: allPairs,
      blocking: true,
    });
  }
  if (plan.loadSource === "operator-recovery") {
    adjudicationBlockers.push({
      reason: "plan-load-source-operator-recovery",
      pairs: allPairs,
      blocking: false,
    });
  }
  for (const reason of [
    "pair-missing",
    "variant-failure",
    "artifact-unreadable",
    "evidence-input-divergent",
    "malformed-ledger-entries",
  ] as const) {
    const affected = pairs
      .filter((pair) => pair.unavailableReasons.includes(reason))
      .map((pair) => pair.pair);
    if (affected.length > 0) {
      adjudicationBlockers.push({ reason, pairs: affected, blocking: true });
    }
  }
  // Non-blocking on purpose: the arms read the same sources and lanes, so the comparison stands.
  // Recorded anyway, because the persisted bundles were not byte-identical and a reader who assumes
  // Collect-once-run-both guarantees that would misread the pair.
  const annotationDivergentPairs = pairs
    .filter((pair) => pair.unavailableReasons.includes("evidence-annotations-divergent"))
    .map((pair) => pair.pair);
  if (annotationDivergentPairs.length > 0) {
    adjudicationBlockers.push({
      reason: "evidence-annotations-divergent",
      pairs: annotationDivergentPairs,
      blocking: false,
    });
  }
  const totalD1 = comparisons.reduce(
    (sum, item) => sum + item.variants.simplified.sourceDenominators.laneMappedCollectedSourceIds,
    0,
  );
  const omissions = comparisons.reduce(
    (sum, item) => sum + item.omissions.simplifiedOnlyCoreMaterial.length,
    0,
  );
  return {
    version: 1,
    evaluationRoot,
    selectedAutomatically,
    plan,
    adjudicable:
      plan.provenance === "run-input" &&
      pairsCompared === plan.expectedPairCount &&
      malformedLedgerPairCount === 0,
    adjudicationBlockers,
    totals: {
      plannedPairCount: plan.expectedPairCount,
      pairsCompared,
      pairsNotAdjudicable,
      pairsUnavailable,
      pairsMissing,
      reconciles,
      coreMaterialOmissionCount:
        plan.provenance === "run-input"
          ? measured(omissions, {
              name: "lane-mapped-collected",
              symbol: "D1",
              value: totalD1,
            })
          : { status: "unavailable", reason: "plan-provenance-not-run-input" },
      omissionCheckUnavailableCount:
        pairsNotAdjudicable + pairsUnavailable + pairsMissing + malformedLedgerPairCount,
      unmatchedRecordCount,
    },
    pairs,
    comparisons,
    notComparedAndWhy: [
      {
        subject: "coverageRatio, materialGapLaneCount, coreGapLaneCount, and per-lane gapIds",
        reason: "They come from the shared evidence bundle and cannot differ between paired arms.",
      },
      {
        subject: "model-authored report.dataGaps prose",
        reason: "Free-text rewording is not structural evidence and is not set-differenced.",
      },
    ],
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
async function loadVariant(value: unknown): Promise<unknown> {
  if (!isRecord(value) || readString(value, "status") !== "success") {
    return value;
  }
  const storedRunDir = readString(value, "runDir");
  if (storedRunDir === undefined) {
    return { ...value, artifactError: "successful variant has no runDir" };
  }
  const runDir = resolvedRunDir(storedRunDir);
  try {
    const [report, bundle] = await Promise.all([
      readJson(resolve(runDir, REPORT_FILE)),
      readJson(resolve(runDir, BUNDLE_FILE)),
    ]);
    return { ...value, report, bundle };
  } catch (error) {
    return { ...value, artifactError: error instanceof Error ? error.message : String(error) };
  }
}
async function loadRecord(record: Record<string, unknown>): Promise<Record<string, unknown>> {
  const variants = isRecord(record.variants) ? record.variants : {};
  const [legacy, simplified] = await Promise.all([
    loadVariant(variants.legacy),
    loadVariant(variants.simplified),
  ]);
  return { ...record, variants: { legacy, simplified } };
}
export async function loadEvaluationRoot(root: string): Promise<unknown> {
  const evaluationPath = resolve(root, EVALUATION_FILE);
  let evaluation: unknown = undefined;
  try {
    evaluation = await readJson(evaluationPath);
  } catch (error) {
    throw new Error(
      `Cannot read ${evaluationPath}: ${error instanceof Error ? error.message : error}`,
      { cause: error },
    );
  }
  return isRecord(evaluation)
    ? {
        ...evaluation,
        records: await Promise.all(recordsOf(evaluation).map((record) => loadRecord(record))),
      }
    : evaluation;
}
export async function diffEvidenceCoverageRoot(
  root: string,
  selectedAutomatically = false,
): Promise<CoverageDiffArtifact> {
  const evaluationRoot = resolve(root);
  return analyzeEvaluation(
    await loadEvaluationRoot(evaluationRoot),
    evaluationRoot,
    selectedAutomatically,
  );
}
async function mostRecentEvaluationRoot(): Promise<string> {
  const entries = await readdir(EVALUATIONS_DIR, { withFileTypes: true }).catch((error) => {
    throw new Error(`Cannot read evaluation directory ${EVALUATIONS_DIR}`, { cause: error });
  });
  const latest = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(EVALUATION_PREFIX))
    .map((entry) => entry.name)
    .toSorted()
    .at(-1);
  if (latest === undefined) {
    throw new Error(`No ${EVALUATION_PREFIX}* directories found under ${EVALUATIONS_DIR}`);
  }
  return resolve(EVALUATIONS_DIR, latest);
}

function shortPair(pair: string): string {
  const [scenario, repetition] = pair.split("/");
  return `${(scenario ?? pair)
    .replace(/^equity-analysis-/u, "")
    .replace(/^equity-/u, "")
    .replace(/-deep$/u, "")}/${repetition ?? "?"}`;
}
export function renderHuman(artifact: CoverageDiffArtifact): string {
  const unavailable =
    artifact.totals.pairsNotAdjudicable +
    artifact.totals.pairsUnavailable +
    artifact.totals.pairsMissing;
  const reasons = artifact.adjudicationBlockers
    .filter((item) => item.blocking)
    .map((item) => `${item.reason}: ${item.pairs.map(shortPair).join(", ")}`)
    .join("; ");
  const omission =
    artifact.totals.coreMaterialOmissionCount.status === "measured"
      ? String(artifact.totals.coreMaterialOmissionCount.value)
      : `n/a (${artifact.totals.coreMaterialOmissionCount.reason})`;
  const denominatorLines = artifact.comparisons.flatMap((comparison) =>
    (["legacy", "simplified"] as const).map((variant) => {
      const denominators = comparison.variants[variant].sourceDenominators;
      const malformedDetail = denominators.malformedLedgerEntries.entries
        .map((entry) => `index ${String(entry.index)}: ${entry.reason}`)
        .join(", ");
      return `  ${comparison.pair} ${variant}: D1=${String(
        denominators.laneMappedCollectedSourceIds,
      )}, D2=${String(denominators.laneMembershipEntries)}, malformed-ledger=${String(
        denominators.malformedLedgerEntries.count,
      )}${malformedDetail === "" ? "" : ` (${malformedDetail})`}, multi-lane-duplicates=${String(
        denominators.multiLaneDuplicateEntries,
      )}, D2-D1-reconciles=${String(
        denominators.d2MinusD1EqualsMultiLaneDuplicateEntries,
      )}, omission-check-authoritative=${String(denominators.omissionCheckAuthoritative)}`;
    }),
  );
  const lines = [
    `Evaluation root: ${artifact.evaluationRoot}`,
    `adjudicable: ${String(artifact.adjudicable)} — ${String(unavailable)} of ${String(
      artifact.totals.plannedPairCount,
    )} planned pairs not compared${reasons === "" ? "" : ` (${reasons})`}`,
    "",
    "Pair coverage:",
    ...artifact.pairs.map(
      (pair) =>
        `  ${pair.pair}: ${pair.status}, shared-evidence-input=${pair.sharedEvidenceInput}, judged=${String(pair.judged)}`,
    ),
    "",
    "Source denominators:",
    ...denominatorLines,
    "",
    "Totals:",
    `  simplified: core/material omissions=${omission} over lane-mapped-collected (D1), pairs-compared=${String(
      artifact.totals.pairsCompared,
    )}, pairs-unavailable=${String(
      artifact.totals.pairsUnavailable,
    )}, pairs-missing=${String(artifact.totals.pairsMissing)}, reconciles=${String(
      artifact.totals.reconciles,
    )}`,
    `  not-adjudicable=${String(
      artifact.totals.pairsNotAdjudicable,
    )}, omission-check-unavailable=${String(
      artifact.totals.omissionCheckUnavailableCount,
    )}, unmatched-records=${String(artifact.totals.unmatchedRecordCount)}`,
  ];
  return `${lines.join("\n")}\n`;
}
export function assertOutputOutsideData(out: string): string {
  const outputPath = resolve(REPOSITORY_ROOT, out);
  const relativeToData = relative(DATA_DIR, outputPath);
  if (relativeToData === "" || (!relativeToData.startsWith("..") && !isAbsolute(relativeToData))) {
    throw new Error("--out must not write under data/");
  }
  return outputPath;
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  const selectedAutomatically = parsed.root === undefined;
  const root = parsed.root === undefined ? await mostRecentEvaluationRoot() : parsed.root;
  if (selectedAutomatically) {
    process.stderr.write(`Selected evaluation root: ${root}\n`);
  }
  const artifact = await diffEvidenceCoverageRoot(root, selectedAutomatically);
  const json = `${JSON.stringify(artifact, null, 2)}\n`;
  if (parsed.out !== undefined) {
    const outputPath = assertOutputOutsideData(parsed.out);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, json, "utf8");
    process.stderr.write(`Wrote ${outputPath}\n`);
  }
  process.stdout.write(parsed.json ? json : renderHuman(artifact));
}
if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `Evidence coverage diff failed: ${error instanceof Error ? error.message : error}\n`,
    );
    process.exitCode = 1;
  }
}
