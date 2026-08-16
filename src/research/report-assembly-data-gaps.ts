import type { ResearchCommand } from "../cli/args";
import type { Prediction, SourceGap } from "../domain/types";
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

function sourceGapNeedles(gap: SourceGap): readonly string[] {
  return [gap.source, gap.provider, ...sourceGapAliasNeedles(gap)]
    .filter((value): value is string => value !== undefined && value.trim() !== "")
    .map((value) => normalizeGapNeedle(value))
    .filter((value) => value.length >= 4);
}

function sourceGapAliasNeedles(gap: SourceGap): readonly string[] {
  const source = gap.source.toLowerCase();
  return [
    ...(source.includes("tradier") ? ["options iv", "options evidence"] : []),
    ...(source.includes("supplemental-market") ? ["supplemental market"] : []),
  ];
}

function mentionsSourceGap(modelGap: string, deterministicGap: SourceGap): boolean {
  const normalized = normalizeGapNeedle(modelGap);
  return sourceGapNeedles(deterministicGap).some((needle) => normalized.includes(needle));
}

export function withoutModelProviderGapDuplicates(
  modelGaps: readonly string[],
  sourceGaps: readonly SourceGap[],
): readonly string[] {
  const deterministicGaps = dedupeSourceGaps(sourceGaps);
  return modelGaps.filter(
    (modelGap) => !deterministicGaps.some((gap) => mentionsSourceGap(modelGap, gap)),
  );
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
