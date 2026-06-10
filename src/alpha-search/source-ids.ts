export function socialMomentumReportSourceId(input: {
  readonly symbol: string;
  readonly socialRank: number;
  readonly sourceIds: readonly string[];
}): string {
  const baseId = input.sourceIds[0] ?? `apewisdom-${input.symbol}`;
  return `${baseId}@rank-${String(input.socialRank)}`;
}
