import type { InstrumentStalenessInput } from "../types";

// Staleness classification for watchlist rows.
// All date math is UTC calendar days; earnings dates compare as YYYY-MM-DD.
export type RunFreshness =
  | { readonly state: "fresh" }
  | { readonly state: "stale"; readonly reason: "age"; readonly since: string }
  | { readonly state: "stale"; readonly reason: "earnings"; readonly since: string }
  | { readonly state: "stale"; readonly reason: "unknown-date" }
  | { readonly state: "never-run" };

const EARNINGS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function utcDay(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

export function classifyRunFreshness(
  latestRun: { readonly generatedAt: string | null } | undefined,
  earningsDates: readonly string[],
  now: Date,
  staleAfterDays: number,
): RunFreshness {
  if (latestRun === undefined) {
    return { state: "never-run" };
  }
  const { generatedAt } = latestRun;
  // A missing or unparseable run date cannot be aged; declare it instead of
  // Letting the row look fresh forever.
  if (generatedAt === null) {
    return { state: "stale", reason: "unknown-date" };
  }
  const runDay = generatedAt.slice(0, 10);
  if (!EARNINGS_DATE_PATTERN.test(runDay) || Number.isNaN(utcDay(runDay))) {
    return { state: "stale", reason: "unknown-date" };
  }
  const today = now.toISOString().slice(0, 10);
  const passed = earningsDates
    .filter(
      // Dates before the run date cannot be evidence of that run; the
      // Collector guarantees the invariant, the filter makes it local.
      (date) => EARNINGS_DATE_PATTERN.test(date) && date >= runDay && date < today,
    )
    .toSorted()[0];
  if (passed !== undefined) {
    return { state: "stale", reason: "earnings", since: passed };
  }
  const ageDays = Math.floor((utcDay(today) - utcDay(runDay)) / 86_400_000);
  if (ageDays > staleAfterDays) {
    return { state: "stale", reason: "age", since: generatedAt };
  }
  return { state: "fresh" };
}

export function instrumentFreshness(
  input: InstrumentStalenessInput,
  now: Date,
  staleAfterDays: number,
): RunFreshness | undefined {
  if (input.state === "never-run") {
    return { state: "never-run" };
  }
  if (input.state !== "available") {
    return undefined;
  }
  return classifyRunFreshness(
    { generatedAt: input.latestRunAt ?? null },
    input.earningsDates,
    now,
    staleAfterDays,
  );
}
