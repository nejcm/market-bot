const GAP_EVIDENCE_NOUN = String.raw`(?:evidence|data|disclosure|filing|coverage|sources?|estimates?|guidance|breakdown|transcript|feed|lane|series)`;

const GAP_SHAPED_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\b(?:no|without)\s+(?:\w+\s+){0,3}${GAP_EVIDENCE_NOUN}\b`, "iu"),
  new RegExp(
    String.raw`\b${GAP_EVIDENCE_NOUN}\b[^.]{0,40}\b(?:was|were|is|are)\s+(?:not\s+(?:available|collected|retrieved|provided|disclosed|covered)|unavailable|missing|absent|undisclosed)\b`,
    "iu",
  ),
  /\b(?:could not|cannot|was not able to|were not able to)\s+(?:be\s+)?(?:collected|retrieved|fetched|obtained|verified|accessed)\b/iu,
  /\bnot\s+(?:collected|retrieved|available|provided|disclosed|covered)\s+(?:for|in)\s+this\s+run\b/iu,
];

export function isGapShapedClaim(text: string): boolean {
  return GAP_SHAPED_PATTERNS.some((pattern) => pattern.test(text));
}
