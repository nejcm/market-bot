// Single source of truth for financial-lens percent conventions, shared by the
// Server-side summary formatter and the client tile renderer so the two cannot drift.

// Ratio form: value is a ratio (0.42 → 42%).
export function formatRatioPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

// Whole-percent form: value already in percent (12 → 12%).
export function formatWholePercent(value: number): string {
  return `${value.toFixed(1)}%`;
}
