import { isInstrumentCommand, type ResearchCommand } from "../../cli/args";
import type { PredictionKind } from "../../domain/prediction";
import type { EventGridEvent } from "../event-grid";
import type { CollectedSources } from "../../sources/types";
import { hasConfirmedEarningsDate } from "../../forecast/earnings-eligibility";
import { FRED_SERIES } from "../../sources/fred";

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

// `macro` forecasts take a FRED series as subject; equity runs allow only their symbol.
export function isFredAllowedSubject(predictionSubjects: readonly string[]): boolean {
  return predictionSubjects.some((subject) => FRED_SERIES.includes(subject));
}

// `excludedKinds` withdraws kinds a specific path cannot support from every surface the prompt
// Advertises — coverage notes, DSL, diversity and mix guidance all read this list. Empty by
// Default, so every existing caller's output is unchanged.
export function supportedPredictionKinds(
  command: ResearchCommand,
  collectedSources: CollectedSources,
  predictionSubjects: readonly string[],
  excludedKinds: readonly PredictionKind[] = [],
): readonly PredictionKind[] {
  const kinds: readonly PredictionKind[] = [
    "direction",
    "relative",
    ...(command.assetClass === "equity" && isVixAllowedSubject(predictionSubjects)
      ? (["volatility"] as const)
      : []),
    ...(command.assetClass === "equity" && hasCiteableOptionsIvEvidence(collectedSources)
      ? (["iv"] as const)
      : []),
    "range",
    ...(isFredAllowedSubject(predictionSubjects) ? (["macro"] as const) : []),
    ...(command.depth === "deep" ? (["conditional"] as const) : []),
    ...(isInstrumentCommand(command) && hasConfirmedEarningsDate(collectedSources.earningsSetup)
      ? (["earnings-direction", "earnings-move"] as const)
      : []),
  ];
  return excludedKinds.length === 0 ? kinds : kinds.filter((kind) => !excludedKinds.includes(kind));
}

export function predictionCoverageGuidance(
  gridEvents: readonly EventGridEvent[],
  supportedKinds: readonly PredictionKind[],
): string {
  const horizonsByShape = new Map<string, number[]>();
  for (const event of gridEvents) {
    const shape =
      event.kind === "range" ? `${event.subject} ±1σ range band` : `${event.kind} ${event.subject}`;
    horizonsByShape.set(shape, [...(horizonsByShape.get(shape) ?? []), event.horizonTradingDays]);
  }
  const coveredShapes =
    horizonsByShape.size > 0
      ? [...horizonsByShape]
          .map(
            ([shape, horizons]) =>
              `${shape} at ${horizons.map((horizon) => `${String(horizon)}d`).join(", ")}`,
          )
          .join("; ")
      : "none";
  const gridKinds = new Set<PredictionKind>(gridEvents.map((event) => event.kind));
  const uncoveredKinds = supportedKinds.filter((kind) => !gridKinds.has(kind));
  const restatement =
    gridEvents.length > 0
      ? " A prediction restating a covered event is folded into the grid and does not count toward the target; do not carry forward a prior run's prediction that does. A range at a covered horizon is a new forecast only with different, evidence-supported bounds."
      : "";
  return ` Prediction coverage: events the Event Grid already covers: ${coveredShapes}; supported kinds it leaves uncovered: ${uncoveredKinds.length > 0 ? uncoveredKinds.join(", ") : "none"}.${restatement} Seek an uncovered supported kind, or a covered kind at another horizon or benchmark, where evidence supports it. Use a different exact horizon only when evidence supports that horizon.`;
}
