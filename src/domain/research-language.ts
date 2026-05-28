export const TRADE_ACTION_PATTERN =
  /\b(buy|sell|hold|go long|go short|short this|accumulate|reduce exposure|increase exposure|rebalance|take profit|stop loss|position size|position sizing|execute|execution instruction|portfolio change|allocation change)\b/iu;

export function violatesResearchOnly(text: string): { match: string } | null {
  const m = TRADE_ACTION_PATTERN.exec(text);
  return m !== null ? { match: m[0] } : null;
}
