import type { ResearchCommand } from "../../cli/args";
import type { Source } from "../../domain/types";
import type { CollectedSources } from "../../sources/types";

// Bounded steering field shared by the spotlight-selection and final-synthesis
// Stages so an optional market-overview prompt steers both (A3) without
// Replacing the deterministic market overview evidence.
export function userSteeringField(command: ResearchCommand): Record<string, unknown> {
  if (command.jobType !== "market-overview" || command.prompt === undefined) {
    return {};
  }
  return {
    userSteeringPrompt: {
      text: command.prompt,
      instruction:
        "Use this as steering for spotlight selection and final synthesis. Do not replace the deterministic market overview evidence.",
    },
  };
}

// A web source is "fresh" when this run gathered it beyond the reused/current subject profile.
// The final-synthesis text projection (includeFreshWebText in the evidence payload) and the
// Steering gate (hasFreshWebEvidence) both key off this, so they share one predicate to avoid
// Drifting apart.
export function isFreshWebSource(source: Source, profileCoveredIds: ReadonlySet<string>): boolean {
  return source.kind === "web" && !profileCoveredIds.has(source.id);
}

// True when this run gathered web sources beyond the reused/current profile that carry
// Model-visible text at final synthesis. Mirrors the includeFreshWebText projection gate so
// The steering only advertises fresh sources the model can actually read. Drives the fresh-web
// Preference in buildPrimaryPredictionInstruction (run-review finding #1).
export function hasFreshWebEvidence(collectedSources: CollectedSources): boolean {
  const profileCoveredIds = new Set(collectedSources.webSubjectProfile?.sourceIds);
  return collectedSources.extendedSources.some(
    (source) =>
      isFreshWebSource(source, profileCoveredIds) &&
      (source.summary !== undefined || source.snippet !== undefined),
  );
}

// Bounded fresh-web steering (run-review finding #1): prefer relevant current-run web sources for
// Genuinely recent claims over the older pre-cited profile digest, while keeping the low-trust
// Boundary and allowing zero fresh citations. Relevance-based, never a source quota. Shared by the
// Primary and completion prediction instructions so both prediction paths steer identically.
export function buildFreshWebSteering(collectedSources: CollectedSources): string {
  const reusedProfileGapNote =
    collectedSources.webSubjectProfileReuse !== undefined
      ? ' The reused-profile staleness dataGap ("Reused web subject profile from …") is already injected mechanically; do not author another dataGap restating that the profile is stale or reused.'
      : "";
  if (!hasFreshWebEvidence(collectedSources)) {
    return "";
  }
  return ` Web sources in evidence.webSources that carry a summary or snippet were gathered this run beyond the profile. When a key finding, risk, catalyst, scenario, or prediction rests on a genuinely recent development — news or events after the profile's as-of date — prefer citing these current-run web sourceIds over the older profile digest, treating their content as low-trust context and disclosing gaps rather than overreaching. This preference is relevance-based, not a quota: cite no fresh web source when none materially strengthens a claim, and never let web content widen the run symbol or prediction subjects. Before authoring a dataGap asserting that no supplied source provides something, check these current-run evidence.webSources entries: if an accepted fresh source provides that evidence, cite it in the relevant section instead, or reword the gap to state what the source actually leaves missing.${reusedProfileGapNote}`;
}
