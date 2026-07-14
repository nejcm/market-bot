import type { ResearchCommand } from "../../cli/args";
import type {
  Source,
  WebSourceSynthesisAdvisory,
  WebSourceSynthesisInput,
} from "../../domain/types";
import { subjectKindForCommand } from "../../sources/extended-evidence/web-subject-profile";
import type { CollectedSources } from "../../sources/types";
import { hasFreshWebEvidence, isFreshWebSource } from "./steering";

// Per-web-source record of the final-synthesis inputs, persisted to trace.json (item: review
// Attribution). Mirrors the projectWebSources final-synthesis projection and the
// BuildFreshWebSteering gate exactly, so the trace states what the model actually saw: whether
// The source was projected into evidence.webSources, which text field was model-visible, whether
// The reused profile digest already pre-cited it, and which steering blocks applied to it.
export function buildWebSourceSynthesisInputs(
  command: ResearchCommand,
  collectedSources: CollectedSources,
): readonly WebSourceSynthesisInput[] | undefined {
  const webSources = collectedSources.extendedSources.filter((source) => source.kind === "web");
  if (webSources.length === 0) {
    return undefined;
  }
  const includedInContext = subjectKindForCommand(command) !== undefined;
  const profileCoveredIds = new Set(collectedSources.webSubjectProfile?.sourceIds);
  const freshWebSteeringActive = includedInContext && hasFreshWebEvidence(collectedSources);
  const profileAttached = collectedSources.webSubjectProfile !== undefined;
  return webSources.map((source) => {
    const fresh = isFreshWebSource(source, profileCoveredIds);
    const modelVisibleText = webSourceModelVisibleText(source, includedInContext && fresh);
    const profileCovered = profileCoveredIds.has(source.id);
    const advisories: WebSourceSynthesisAdvisory[] = [];
    if (freshWebSteeringActive && modelVisibleText !== "none") {
      advisories.push("fresh-web-preference");
    }
    if (includedInContext && profileAttached && profileCovered) {
      advisories.push("web-subject-profile-low-trust");
    }
    return { sourceId: source.id, includedInContext, modelVisibleText, profileCovered, advisories };
  });
}

// Which text field the final-synthesis projection surfaces for a fresh web source: summary first,
// Snippet as the fallback (mirrors the includeSummary/includeSnippet gates in projectWebSources).
function webSourceModelVisibleText(
  source: Source,
  textIncluded: boolean,
): WebSourceSynthesisInput["modelVisibleText"] {
  if (!textIncluded) {
    return "none";
  }
  if (source.summary !== undefined) {
    return "summary";
  }
  return source.snippet !== undefined ? "snippet" : "none";
}
