export function socialMomentumBaseSourceId(input: {
  readonly symbol: string;
  readonly sourceIds: readonly string[];
}): string {
  return (
    input.sourceIds.find((sourceId) => sourceId.startsWith("apewisdom-")) ??
    `apewisdom-${input.symbol}`
  );
}

export function socialMomentumReportSourceId(input: {
  readonly symbol: string;
  readonly socialRank: number;
  readonly sourceIds: readonly string[];
}): string {
  const baseId = socialMomentumBaseSourceId(input);
  return `${baseId}@rank-${String(input.socialRank)}`;
}
