import { SOURCE_KINDS, type Source } from "../domain/types";
import { isRecord } from "../guards";
import type { DeepEquityEvidenceBundleV1 } from "./types";

const SOURCE_KIND_SET: ReadonlySet<string> = new Set(SOURCE_KINDS);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNumberArray(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number");
}

function isMarketSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.sourceId) &&
    (value.assetClass === "equity" || value.assetClass === "crypto") &&
    isNonEmptyString(value.symbol) &&
    typeof value.price === "number" &&
    typeof value.changePercent24h === "number" &&
    typeof value.volume === "number" &&
    isNonEmptyString(value.observedAt)
  );
}

function isSource(value: unknown): value is Source {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.title) &&
    isNonEmptyString(value.fetchedAt) &&
    typeof value.kind === "string" &&
    SOURCE_KIND_SET.has(value.kind)
  );
}

function isSourceGap(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.source) && isNonEmptyString(value.message);
}

function isVerifiedMarketSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.symbol) &&
    value.assetClass === "equity" &&
    isNonEmptyString(value.analysisDate) &&
    isNonEmptyString(value.fetchedAt) &&
    isNonEmptyString(value.latestSessionDate) &&
    isRecord(value.ohlcv) &&
    isRecord(value.indicators) &&
    Array.isArray(value.recentCloses)
  );
}

function isSourcePlan(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.version === 1 || value.version === 2) &&
    isNonEmptyString(value.generatedAt) &&
    isRecord(value.run) &&
    Array.isArray(value.lanes)
  );
}

function isEvidenceLanes(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.version === 1 || value.version === 2) &&
    isNonEmptyString(value.generatedAt) &&
    Array.isArray(value.lanes)
  );
}

function isSourceLedger(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.version === 1 || value.version === 2) &&
    isNonEmptyString(value.generatedAt) &&
    Array.isArray(value.sources) &&
    value.sources.every(
      (source) => isRecord(source) && isNonEmptyString(source.id) && isNonEmptyString(source.kind),
    )
  );
}

function isHistoricalContext(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.generatedAt) &&
    typeof value.recentDays === "number" &&
    isNumberArray(value.anchorMonths) &&
    Array.isArray(value.runs) &&
    Array.isArray(value.sources) &&
    value.sources.every(isSource) &&
    isStringArray(value.gaps) &&
    isRecord(value.audit) &&
    Array.isArray(value.artifactDeltas)
  );
}

function optionalRecord(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || isRecord(record[key]);
}

export function readDeepEquityEvidenceBundle(
  value: unknown,
): DeepEquityEvidenceBundleV1 | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isRecord(value.run) ||
    !isNonEmptyString(value.run.symbol) ||
    !isNonEmptyString(value.run.analysisAsOf) ||
    (value.run.identity !== undefined && !isRecord(value.run.identity)) ||
    !isRecord(value.evidence) ||
    !Array.isArray(value.evidence.marketSnapshots) ||
    !value.evidence.marketSnapshots.every(isMarketSnapshot) ||
    !Array.isArray(value.evidence.supplementalMarketSnapshots) ||
    !value.evidence.supplementalMarketSnapshots.every(isMarketSnapshot) ||
    !Array.isArray(value.evidence.newsSources) ||
    !value.evidence.newsSources.every(isSource) ||
    !Array.isArray(value.evidence.extendedSources) ||
    !value.evidence.extendedSources.every(isSource) ||
    (value.evidence.verifiedMarketSnapshot !== undefined &&
      !isVerifiedMarketSnapshot(value.evidence.verifiedMarketSnapshot)) ||
    (value.evidence.extendedEvidence !== undefined && !isRecord(value.evidence.extendedEvidence)) ||
    (value.evidence.webSubjectProfile !== undefined &&
      !isRecord(value.evidence.webSubjectProfile)) ||
    !isRecord(value.derived) ||
    !optionalRecord(value.derived, "financialStatements") ||
    !optionalRecord(value.derived, "fundamentalHistory") ||
    !optionalRecord(value.derived, "financialLenses") ||
    !optionalRecord(value.derived, "capitalOwnership") ||
    !optionalRecord(value.derived, "subsequentFinancing") ||
    !optionalRecord(value.derived, "analystExpectations") ||
    !optionalRecord(value.derived, "institutionalOwnership") ||
    !optionalRecord(value.derived, "valuationComps") ||
    !optionalRecord(value.derived, "valuationWorkbench") ||
    !optionalRecord(value.derived, "reverseDcf") ||
    !optionalRecord(value.derived, "earningsSetup") ||
    !optionalRecord(value.derived, "businessFramework") ||
    !isRecord(value.governance) ||
    !Array.isArray(value.governance.sourceGaps) ||
    !value.governance.sourceGaps.every(isSourceGap) ||
    !isSourcePlan(value.governance.sourcePlan) ||
    !isEvidenceLanes(value.governance.evidenceLanes) ||
    !isSourceLedger(value.governance.sourceLedger) ||
    (value.governance.modelInputSanitization !== undefined &&
      !isRecord(value.governance.modelInputSanitization)) ||
    (value.governance.newsAnalytics !== undefined && !isRecord(value.governance.newsAnalytics)) ||
    !isRecord(value.context) ||
    !isHistoricalContext(value.context.historicalContext)
  ) {
    return undefined;
  }

  return value as unknown as DeepEquityEvidenceBundleV1;
}

export function unresolvedDeepEquityBundleSourceIds(
  bundle: DeepEquityEvidenceBundleV1,
  additionalKnownSourceIds: readonly string[] = [],
): readonly string[] {
  const knownSourceIds = new Set<string>([
    ...additionalKnownSourceIds,
    ...bundle.evidence.newsSources.map((source) => source.id),
    ...bundle.evidence.extendedSources.map((source) => source.id),
    ...bundle.governance.sourceLedger.sources.map((source) => source.id),
  ]);
  const referencedSourceIds = new Set<string>();
  const visited = new WeakSet<object>();

  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (!isRecord(value) || visited.has(value)) {
      return;
    }
    visited.add(value);
    for (const [key, item] of Object.entries(value)) {
      if (key === "sourceId" && typeof item === "string") {
        referencedSourceIds.add(item);
      } else if (
        (key === "sourceIds" || key === "coveredSourceIds") &&
        Array.isArray(item) &&
        item.every((sourceId) => typeof sourceId === "string")
      ) {
        for (const sourceId of item) {
          referencedSourceIds.add(sourceId as string);
        }
      }
      visit(item);
    }
  }

  visit(bundle.evidence);
  visit(bundle.derived);
  visit(bundle.governance);
  return [...referencedSourceIds]
    .filter((sourceId) => !knownSourceIds.has(sourceId))
    .toSorted((left, right) => left.localeCompare(right));
}

export function isDeepEquityReport(value: unknown): value is {
  readonly runId: string;
  readonly jobType: "equity";
  readonly assetClass: "equity";
  readonly symbol: string;
  readonly generatedAt: string;
  readonly extras: { readonly depth: "deep" };
} {
  return (
    isRecord(value) &&
    isNonEmptyString(value.runId) &&
    value.jobType === "equity" &&
    value.assetClass === "equity" &&
    isNonEmptyString(value.symbol) &&
    isNonEmptyString(value.generatedAt) &&
    isRecord(value.extras) &&
    value.extras.depth === "deep"
  );
}
