import { isInstrumentCommand, type ResearchCommand } from "../../cli/args";
import type { Prediction, PredictionKind } from "../../domain/types";
import type { CollectedSources } from "../../sources/types";

// A run may advertise `iv` forecast candidates only when it carries citeable options-IV
// Evidence — an extended-evidence item with at least one sourceId. Source gaps (e.g. a missing
// `tradier-options` credential) are non-citeable data gaps and must not advertise IV candidates
// The validator would reject for want of a real sourceId. Shared by the diversity guidance, the
// DSL instruction, and the supported-kinds list so the prompt advertises one consistent surface.
export function hasCiteableOptionsIvEvidence(collectedSources: CollectedSources): boolean {
  return (
    collectedSources.extendedEvidence?.items.some(
      (item) => item.category === "options-iv" && item.sourceIds.length > 0,
    ) === true
  );
}

// `volatility` forecasts measure against ^VIX, so the prompt should advertise the kind only when
// ^VIX is an allowed prediction subject for the run; otherwise the subject gate rejects the
// Candidate the prompt just nudged (the burned ^VIX candidate in the 2026-07-05 review).
export function isVixAllowedSubject(predictionSubjects: readonly string[]): boolean {
  return predictionSubjects.includes("^VIX");
}

export interface PredictionCoverage {
  readonly coveredKinds: readonly PredictionKind[];
  readonly uncoveredSupportedKinds: readonly PredictionKind[];
  readonly coveredExactHorizons: readonly number[];
}

export function buildPredictionCoverage(
  predictions: readonly Prediction[],
  supportedKinds: readonly PredictionKind[],
): PredictionCoverage {
  const coveredKindSet = new Set(predictions.map((prediction) => prediction.kind));
  return {
    coveredKinds: supportedKinds.filter((kind) => coveredKindSet.has(kind)),
    uncoveredSupportedKinds: supportedKinds.filter((kind) => !coveredKindSet.has(kind)),
    coveredExactHorizons: [
      ...new Set(predictions.map((prediction) => prediction.horizonTradingDays)),
    ].toSorted((left, right) => left - right),
  };
}

export function supportedPredictionKinds(
  command: ResearchCommand,
  collectedSources: CollectedSources,
  predictionSubjects: readonly string[],
): readonly PredictionKind[] {
  return [
    "direction",
    "relative",
    ...(command.assetClass === "equity" && isVixAllowedSubject(predictionSubjects)
      ? (["volatility"] as const)
      : []),
    ...(command.assetClass === "equity" && hasCiteableOptionsIvEvidence(collectedSources)
      ? (["iv"] as const)
      : []),
    "range",
    "macro",
    ...(command.depth === "deep" ? (["conditional"] as const) : []),
    ...(isInstrumentCommand(command) && collectedSources.earningsSetup !== undefined
      ? (["earnings-direction", "earnings-move"] as const)
      : []),
  ];
}

export function predictionCoverageGuidance(
  predictions: readonly Prediction[],
  supportedKinds: readonly PredictionKind[],
): string {
  const coverage = buildPredictionCoverage(predictions, supportedKinds);
  const coveredKinds = coverage.coveredKinds.length > 0 ? coverage.coveredKinds.join(", ") : "none";
  const uncoveredKinds =
    coverage.uncoveredSupportedKinds.length > 0
      ? coverage.uncoveredSupportedKinds.join(", ")
      : "none";
  const coveredHorizons =
    coverage.coveredExactHorizons.length > 0
      ? coverage.coveredExactHorizons.map((horizon) => `${String(horizon)}d`).join(", ")
      : "none";
  return ` Prediction coverage: covered kinds: ${coveredKinds}; supported kinds not yet represented: ${uncoveredKinds}; covered exact horizons: ${coveredHorizons}. Seek an uncovered supported kind where evidence supports it. Use a different exact horizon only when evidence supports that horizon.`;
}
