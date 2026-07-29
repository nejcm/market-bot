const GAP_PATTERN_ONE_NOUN = String.raw`(?:evidence|disclosure|filing|sources?|estimates?|breakdown|transcript|feed|lane|series)`;
const GAP_DATA_NOUN = String.raw`data(?!\s+(?:center|centre|point|set)\b)`;
const GAP_EVIDENCE_NOUN = String.raw`(?:${GAP_PATTERN_ONE_NOUN}|data|coverage|guidance)`;

const GAP_SHAPED_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\b(?:no|without)\s+(?:\w+\s+){0,3}${GAP_PATTERN_ONE_NOUN}\b`, "iu"),
  new RegExp(String.raw`\b(?:no|without)\s+(?:\w+\s+){0,3}${GAP_DATA_NOUN}\b`, "iu"),
  new RegExp(
    String.raw`\b${GAP_EVIDENCE_NOUN}\b[^.]{0,40}\b(?:was|were|is|are)\s+(?:not\s+(?:available|collected|retrieved|provided|disclosed|covered)|unavailable|missing|absent|undisclosed)\b(?!\s+until\b)`,
    "iu",
  ),
  /\b(?:could not|cannot|was not able to|were not able to)\s+(?:be\s+)?(?:collected|retrieved|fetched|obtained|verified|accessed)\b/iu,
  /\bnot\s+(?:collected|retrieved|available|provided|disclosed|covered)\s+(?:for|in)\s+this\s+run\b/iu,
];

export function isGapShapedClaim(text: string): boolean {
  return GAP_SHAPED_PATTERNS.some((pattern) => pattern.test(text));
}
