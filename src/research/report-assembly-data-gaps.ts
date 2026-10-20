import type { ResearchCommand } from "../cli/args";
import type { Prediction } from "../domain/prediction";
import type { SourceGap, SourceGapCause } from "../domain/sources";
import { dedupeSourceGaps } from "../domain/source-gaps";
import { withoutPredictionShortfallProtocolGaps } from "../report/prediction-shortfall";
import type { CollectedSources } from "../sources/types";
import { EQUITY_MARKET_OVERVIEW_MOVER_UNIVERSE_GAP, type DataGapEntry } from "./deterministic-gaps";
import { commandResearchSubjectIdentity } from "./research-subject-identity";

function dataGapKey(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim().toLowerCase();
}

export function reportDataGapEntry(text: string): DataGapEntry {
  return { text };
}

export function uniqueDataGapEntries(entries: readonly DataGapEntry[]): readonly DataGapEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = dataGapKey(entry.text);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dataGapTier(entry: DataGapEntry): number {
  if (entry.impact === "core-cap") {
    return 0;
  }
  if (entry.impact === "extended-evidence-cap") {
    return 1;
  }
  if (entry.impact === "no-cap") {
    return 3;
  }
  return 2;
}

export function orderedDataGapEntries(entries: readonly DataGapEntry[]): readonly DataGapEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .toSorted(
      (left, right) =>
        dataGapTier(left.entry) - dataGapTier(right.entry) || left.index - right.index,
    )
    .map(({ entry }) => entry);
}

function hasMarketSnapshotFor(
  collectedSources: CollectedSources,
  symbol: string | undefined,
): boolean {
  if (symbol === undefined) {
    return false;
  }
  const target = symbol.toUpperCase();
  return collectedSources.marketSnapshots.some(
    (snapshot) => snapshot.symbol.toUpperCase() === target,
  );
}

export function researchPredictionGate(input: {
  readonly command: ResearchCommand;
  readonly predictions: readonly Prediction[];
  readonly collectedSources: CollectedSources;
}): { readonly predictions: readonly Prediction[]; readonly gaps: readonly string[] } {
  if (input.command.jobType !== "research") {
    return { predictions: input.predictions, gaps: [] };
  }
  const identity = commandResearchSubjectIdentity(input.command);
  const proxy = identity.predictionProxySymbol;
  if (proxy === undefined) {
    // Resolved subject with no proxy (e.g. ai-infrastructure): always emit an explicit gap.
    // So the absence of predictions is disclosed, not implicit (Phase 2.4).
    // Use registry resolution as the discriminator — identity.subjectKey is caller-provided
    // And not proof that the subject actually matched a registry entry.
    const { resolvedSubject } = input.collectedSources;
    if (resolvedSubject?.subjectKey !== undefined) {
      return {
        predictions: [],
        gaps: [
          `researchProxyForecastGate: subject ${resolvedSubject.subjectKey} has no listed prediction proxy; predictions cannot be emitted`,
        ],
      };
    }
    // Unresolved subject: only emit gap if there were predictions to drop.
    return {
      predictions: [],
      gaps:
        input.predictions.length === 0
          ? []
          : [
              "researchProxyForecastGate: dropped predictions because no listed prediction proxy was resolved",
            ],
    };
  }
  if (!hasMarketSnapshotFor(input.collectedSources, proxy)) {
    return {
      predictions: [],
      gaps: [
        `researchProxyForecastGate: dropped predictions because no market snapshot matched proxy ${proxy}`,
      ],
    };
  }
  const predictions = input.predictions.filter(
    (prediction) => prediction.subject.toUpperCase() === proxy,
  );
  return {
    predictions,
    gaps:
      predictions.length === input.predictions.length
        ? []
        : [`researchProxyForecastGate: dropped non-proxy predictions; allowed subject is ${proxy}`],
  };
}

function normalizeGapNeedle(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, " ")
    .trim();
}

// Provider gaps that can anchor a restatement drop; the declared gap's access-failure token below
// Is still required.
const PROVIDER_AVAILABILITY_CAUSES: ReadonlySet<SourceGapCause> = new Set([
  "missing-credential",
  "unsupported-coverage",
  "provider-data-missing",
  "fetch-failed",
]);

// An explicit access failure in the declared gap's own message; bare "key"/"token"/"plan" are too
// Generic and would match unrelated prose.
const ACCESS_FAILURE_PATTERN =
  /(?:http|status):?\s*(?:401|403|429)\b|api key|credential|entitlement|subscription|quota|not set|not configured/iu;

// The access-failure wording a model sentence may use, per the anchored provider template.
const PROVIDER_ACCESS_PREDICATE =
  "unavailable|not configured|not set|returned (?:http )?(?:401|403|429)|requires (?:an )?(?:api key|credential|entitlement|subscription)";

// The sentence must begin with the declared provider and end in the access failure; the middle may
// Name the endpoint's own subject plus endpoint/data/api, and only "for <subject>" may follow.
function providerAccessPattern(gap: SourceGap): RegExp | undefined {
  const provider = gap.provider?.trim();
  if (provider === undefined || provider === "") {
    return undefined;
  }
  const subject = [
    ...endpointGapSubjects(gap).map((item) => gapSubjectPattern(item)),
    "endpoint",
    "data",
    "api",
  ].join("|");
  return new RegExp(
    `^${escapeGapPattern(provider)}(?:\\s+(?:${subject})){0,4}(?:\\s+(?:is|are|was))?` +
      `\\s+(?:${PROVIDER_ACCESS_PREDICATE})(?:\\s+for\\s+(?:${subject})(?:\\s+evidence)?)?\\.?$`,
    "iu",
  );
}

// A model sentence that names a provider whose declared gap is an access failure restates that gap.
function isProviderAccessRestatement(
  sentence: string,
  providerGaps: readonly SourceGap[],
): boolean {
  return providerGaps.some((gap) => {
    if (!ACCESS_FAILURE_PATTERN.test(gap.message)) {
      return false;
    }
    return providerAccessPattern(gap)?.test(sentence.trim()) ?? false;
  });
}

const GAP_PREDICATE = "not supplied|unavailable|missing|not provided|not available";
const GAP_RUN_SUFFIX = "in this run|for this run";
const GAP_DETERMINERS = "the|a|an";
const GAP_SUBJECT_JOIN = String.raw`(?:,\s*(?:and\s+)?|\s+and\s+)`;

function escapeGapPattern(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

function gapSubjectPattern(subject: string): string {
  const words = subject.split(" ");
  return words
    .map((word, index) => escapeGapPattern(word) + (index === words.length - 1 ? "s?" : ""))
    .join(String.raw`\s+`);
}

// Subjects come from the specific endpoint a Source Gap covers, so a finnhub-events dividend gap
// Cannot drop an estimates restatement. Endpoints with no known subject set drop nothing.
function endpointGapSubjects(gap: SourceGap): readonly string[] {
  const source = gap.source.toLowerCase();
  const message = gap.message.toLowerCase();
  if (source.startsWith("finnhub-events")) {
    if (message.includes("dividend")) {
      return ["dividend", "dividend history"];
    }
    if (message.includes("split")) {
      return ["split", "split history"];
    }
    return [];
  }
  if (source.startsWith("finnhub-eps-estimate")) {
    return ["eps estimate", "consensus eps estimate", "earnings per share estimate"];
  }
  if (source.startsWith("finnhub-revenue-estimate")) {
    return ["revenue estimate", "revenue consensus"];
  }
  if (source.startsWith("finnhub-ebitda-estimate")) {
    return ["ebitda estimate", "ebitda consensus"];
  }
  if (source.startsWith("finnhub-analyst-range")) {
    return ["external analyst range", "external price distribution", "analyst price distribution"];
  }
  if (source.startsWith("finnhub-institutional-ownership")) {
    return ["institutional ownership", "institutional holding"];
  }
  if (source.startsWith("finnhub-insider-transactions")) {
    return ["insider transaction", "insider activity"];
  }
  if (source.includes("tradier")) {
    // A per-tenor gap leaves other tenors available, so it cannot cover a broad IV-absent claim.
    return message.includes("for expiration")
      ? []
      : ["options iv", "options iv evidence", "options evidence", "implied volatility"];
  }
  if (source.startsWith("earnings-setup-implied-move")) {
    return ["implied move", "earnings move"];
  }
  if (source.includes("supplemental-market")) {
    return ["supplemental market", "supplemental market snapshot"];
  }
  return [];
}

function endpointGapPattern(subjects: readonly string[]): RegExp {
  const subject = subjects.map((item) => gapSubjectPattern(item)).join("|");
  return new RegExp(
    `^(?:(?:${GAP_DETERMINERS})\\s+)?(?:${subject})(?:${GAP_SUBJECT_JOIN}(?:${subject}))*` +
      `\\s+(?:is|are)\\s+(?:${GAP_PREDICATE})(?:\\s+(?:${GAP_RUN_SUFFIX}))?\\.?$`,
    "iu",
  );
}

function isCoveredSentence(sentence: string, providerGaps: readonly SourceGap[]): boolean {
  return providerGaps.some((gap) => {
    const subjects = endpointGapSubjects(gap);
    return subjects.length > 0 && endpointGapPattern(subjects).test(sentence);
  });
}

export function withoutModelProviderGapDuplicates(
  modelGaps: readonly string[],
  sourceGaps: readonly SourceGap[],
): readonly string[] {
  const providerGaps = dedupeSourceGaps(sourceGaps).filter(
    (gap) => gap.cause !== undefined && PROVIDER_AVAILABILITY_CAUSES.has(gap.cause),
  );
  if (providerGaps.length === 0) {
    return modelGaps;
  }
  return modelGaps.filter((modelGap) => {
    const sentences = modelGap
      .split(/[.;]+/u)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence !== "");
    // A mixed gap survives unless every sentence is a declared-gap restatement.
    return (
      sentences.length === 0 ||
      !sentences.every(
        (sentence) =>
          isCoveredSentence(sentence, providerGaps) ||
          isProviderAccessRestatement(sentence, providerGaps),
      )
    );
  });
}

function gapTokens(value: string): Set<string> {
  return new Set(
    normalizeGapNeedle(value)
      .split(" ")
      .filter((token) => token.length >= 3),
  );
}

function isMoverUniverseRestatement(modelGap: string, deterministicGap: string): boolean {
  const model = normalizeGapNeedle(modelGap);
  if (deterministicGap !== EQUITY_MARKET_OVERVIEW_MOVER_UNIVERSE_GAP) {
    return false;
  }
  return (
    model.includes("mover universe") &&
    model.includes("yahoo") &&
    model.includes("day gainers") &&
    model.includes("day losers") &&
    model.includes("most active") &&
    model.includes("trailing horizon")
  );
}

/*
 * True when the model gap restates a deterministic gap — most of its meaningful
 * tokens are already covered by the deterministic phrasing. Punctuation and
 * inserted clauses (e.g. "— a single-day multi-screener set,") would otherwise
 * defeat the exact-text dedupe in uniqueDataGaps.
 */
function restatesDeterministicGap(modelGap: string, deterministicGap: string): boolean {
  if (isMoverUniverseRestatement(modelGap, deterministicGap)) {
    return true;
  }
  const modelTokens = gapTokens(modelGap);
  if (modelTokens.size === 0) {
    return false;
  }
  const deterministicTokens = gapTokens(deterministicGap);
  let shared = 0;
  for (const token of modelTokens) {
    if (deterministicTokens.has(token)) {
      shared += 1;
    }
  }
  return shared / modelTokens.size >= 0.8;
}

export function withoutDeterministicGapRestatements(
  modelGaps: readonly string[],
  deterministicGapTexts: readonly string[],
): readonly string[] {
  return modelGaps.filter(
    (modelGap) => !deterministicGapTexts.some((text) => restatesDeterministicGap(modelGap, text)),
  );
}

export function withoutModelPredictionCountGaps(modelGaps: readonly string[]): readonly string[] {
  return withoutPredictionShortfallProtocolGaps(modelGaps).filter((gap) => {
    const normalized = gap.toLowerCase();
    return !(
      /\bpredictions?\b/u.test(normalized) &&
      /\b(?:count|emit|emits|emitted|emitting|fewer|more|shortfall|target)\b/u.test(normalized)
    );
  });
}
