import type { Source, WebGatherDuplicateResultAudit } from "../domain/types";

export const WEB_GATHER_DUPLICATE_HEADLINE_REASON = "duplicate-headline";
// A candidate headline is a near-duplicate when token-set Jaccard or containment reaches this value. Deterministic string logic only; the threshold errs toward keeping so different angles on the same entity survive.
export const DUPLICATE_HEADLINE_SIMILARITY_THRESHOLD = 0.8;
// Titles with fewer significant tokens (hostname fallbacks, terse fragments) carry too little signal to dedupe safely, so they are always kept.
const MIN_COMPARABLE_TOKENS = 3;

const HEADLINE_STOPWORDS = new Set([
  "a",
  "about",
  "after",
  "amid",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "have",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "over",
  "that",
  "the",
  "to",
  "was",
  "will",
  "with",
]);

export interface WebHeadlineDedupeResult {
  readonly kept: readonly Source[];
  readonly rejected: readonly WebGatherDuplicateResultAudit[];
}

// Rejects gathered web results whose normalized title near-duplicates an already-accepted web source in the same run, so accepted-source slots are not burned on repeated coverage of one headline. Compares titles only (never domains); candidates whose sha256(url) id is already known pass through untouched because the downstream id dedupe owns same-URL collisions.
export function dedupeWebSourcesByHeadline(
  existingSources: readonly Source[],
  candidates: readonly Source[],
): WebHeadlineDedupeResult {
  const compared = existingSources
    .filter((source) => source.kind === "web")
    .map((source) => ({
      id: source.id,
      title: source.title,
      tokens: normalizedHeadlineTokens(source.title),
    }));
  const knownIds = new Set(existingSources.map((source) => source.id));
  const kept: Source[] = [];
  const rejected: WebGatherDuplicateResultAudit[] = [];
  for (const candidate of candidates) {
    if (knownIds.has(candidate.id)) {
      kept.push(candidate);
      continue;
    }
    const tokens = normalizedHeadlineTokens(candidate.title);
    const duplicateOf = compared.find(
      (entry) =>
        headlineSimilarity(tokens, entry.tokens) >= DUPLICATE_HEADLINE_SIMILARITY_THRESHOLD,
    );
    if (duplicateOf !== undefined) {
      rejected.push({
        reason: WEB_GATHER_DUPLICATE_HEADLINE_REASON,
        sourceId: candidate.id,
        title: candidate.title,
        duplicateOfSourceId: duplicateOf.id,
        duplicateOfTitle: duplicateOf.title,
      });
      continue;
    }
    kept.push(candidate);
    knownIds.add(candidate.id);
    compared.push({ id: candidate.id, title: candidate.title, tokens });
  }
  return { kept, rejected };
}

export function normalizedHeadlineTokens(title: string): ReadonlySet<string> {
  const tokens = title
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/u)
    .filter((token) => token.length > 1 && !HEADLINE_STOPWORDS.has(token));
  return new Set(tokens);
}

// Similarity is max(Jaccard, containment) over normalized token sets; 0 when either title is below the comparable-token floor.
export function headlineSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size < MIN_COMPARABLE_TOKENS || b.size < MIN_COMPARABLE_TOKENS) {
    return 0;
  }
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  const jaccard = intersection / union;
  const containment = intersection / Math.min(a.size, b.size);
  return Math.max(jaccard, containment);
}
