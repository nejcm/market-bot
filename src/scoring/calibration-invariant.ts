/**
 * The zero-resolution invariant for Calibration summaries: with no resolved
 * Predictions there is no hit rate and no Brier score, so neither field is
 * Published, and neither is the legacy skill score derived from them. A Brier
 * Score of 0 describes a perfect forecaster, which is the opposite of what an
 * Empty corpus knows.
 *
 * `buildCalibrationSummary` enforces this when writing, but summaries already on
 * Disk were written before it existed and still carry the zeros. Every disk
 * Boundary therefore normalizes on read rather than trusting the stored file:
 * `parseCalibrationContext` for the prompt path, `readCalibrationSummary` for
 * The Research Console, and `calibrationHeadline` for the Console view model.
 */

/** Rendered wherever an unmeasured headline metric would otherwise print. */
export const NO_RESOLVED_METRIC_TEXT = "not yet measured (no resolved Predictions)";

/**
 * Headline metrics that cannot exist without a resolved Prediction. The legacy
 * `brierSkillScore` is derived from the Brier score, so it is unfounded for the
 * Same reason.
 */
const UNMEASURED_METRIC_KEYS = ["hitRate", "brierScore", "brierSkillScore"] as const;

/**
 * Markdown headline prefixes whose values the invariant governs, including the
 * Legacy always-0.5 skill line that current summaries no longer emit. Replacing
 * The whole remainder of the line also removes its "1 = perfect" legend, which
 * Is the part that misleads. These prefixes are a frozen historical format:
 * `tests/research-console-artifacts.test.ts` pins them against a stored fixture.
 */
const MARKDOWN_METRIC_PREFIXES = [
  "Overall Brier score: ",
  "Overall hit rate: ",
  "Brier skill vs always-0.5 baseline: ",
] as const;

// Values a Calibration summary bounds to [0, 1]: stated probabilities, hit
// Rates, and the binary Brier score, whose squared error over outcomes in
// {0, 1} cannot leave that interval. Shared so a reader cannot render 1.500 as
// A Brier score while another boundary rejects it. Brier SKILL is not in this
// Class — it is bounded to [-3, 1] and keeps its own guard.
export function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= 1;
}

// A Calibration count is a non-negative integer. Anything else — non-numeric,
// Negative, fractional, non-finite — is not a smaller count but "this summary
// Does not say", so every read boundary takes its unknown path rather than
// Rendering the value as fact. Shared so the boundaries cannot disagree about
// What a valid count is.
export function isCalibrationCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

// A count that the producer only ever emits for a populated group: a bin total,
// A slice sample size, a distinct-Run count. Zero is impossible rather than
// Small, because those keys exist only where at least one resolved pair does,
// So >= 0 would admit an empty bin or metric that the producer cannot write.
export function isPositiveCalibrationCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

// True only when the summary states a resolved count of exactly 0. A missing or
// Malformed count is not evidence of an empty corpus, so it never triggers
// Normalization: this strips values known to be unfounded, never merely absent.
export function hasNoResolvedPredictions(resolvedCount: unknown): boolean {
  return resolvedCount === 0;
}

// Drops headline metrics from a stored summary record that declares zero
// Resolved Predictions. Any other record passes through by identity.
export function withoutUnmeasuredMetrics(
  summary: Record<string, unknown>,
): Record<string, unknown> {
  if (!hasNoResolvedPredictions(summary.resolvedCount)) {
    return summary;
  }
  return Object.fromEntries(
    Object.entries(summary).filter(
      ([key]) => !UNMEASURED_METRIC_KEYS.includes(key as (typeof UNMEASURED_METRIC_KEYS)[number]),
    ),
  );
}

// Rewrites the headline metric lines of a stored `summary.md` that declares zero
// Resolved Predictions, so a stale rendering cannot serve `0.0000` and `0.0%`
// Beside a normalized JSON summary. Every other line is preserved verbatim.
export function withoutUnmeasuredMarkdownMetrics(markdown: string, resolvedCount: unknown): string {
  if (!hasNoResolvedPredictions(resolvedCount)) {
    return markdown;
  }
  return markdown
    .split("\n")
    .map((line) => {
      const prefix = MARKDOWN_METRIC_PREFIXES.find((candidate) => line.startsWith(candidate));
      return prefix === undefined ? line : `${prefix}${NO_RESOLVED_METRIC_TEXT}`;
    })
    .join("\n");
}
