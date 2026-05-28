export const TRADE_ACTION_PATTERN =
  /\b(buy|sell|hold|go long|go short|short this|accumulate|reduce exposure|increase exposure|trim exposure|add exposure|rebalance|take profit|stop loss|position size|position sizing|open (?:a |the )?position|take (?:a |the )?position|add shares|trim shares|scale in|scale out|set (?:an? )?entry|entry point|exit at|exit point|execute|execution instruction|portfolio change|allocation change)\b/iu;

export const READER_DIRECTED_ADVICE_PATTERN =
  /\b(?:investors|traders|readers|you)\s+(?:should|could|may want to|might want to|need to|must)\b|\b(?:should|must|need to)\s+(?:buy|sell|hold|open|trim|add|exit|enter|reduce|increase|rebalance)\b/iu;

export function violatesResearchOnly(text: string): { match: string } | null {
  const m = TRADE_ACTION_PATTERN.exec(text) ?? READER_DIRECTED_ADVICE_PATTERN.exec(text);
  return m !== null ? { match: m[0] } : null;
}
