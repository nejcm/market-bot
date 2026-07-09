/**
 * Deterministic catalyst date extraction.
 *
 * The model writes dated catalysts (PDUFA dates, readouts, deal closes) in prose.
 * This pure parser recovers an ISO `YYYY-MM-DD` date from the forms it actually
 * emits — ISO, month-name day-year, and calendar-quarter — so the Theme Catalyst
 * Calendar can render them as dated items. Undated or unparseable text yields
 * undefined; the calendar keeps such items without a date. No external deps.
 */

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

// Quarter → the quarter-end month (calendar quarters).
const QUARTER_END_MONTH: Readonly<Record<string, number>> = { "1": 3, "2": 6, "3": 9, "4": 12 };

const ISO_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/u;
const MONTH_NAME_RE = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/u;
const QUARTER_RE = /\bQ([1-4])\s+(\d{4})\b/u;

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function toIso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Extracts an ISO `YYYY-MM-DD` date from catalyst prose, or undefined when none
// Is present or parseable. ISO dates win, then explicit month-name dates, then
// Calendar quarters (mapped to the quarter-end date).
export function extractCatalystDate(text: string): string | undefined {
  const iso = ISO_RE.exec(text);
  if (iso !== null) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    if (isRealDate(year, month, day)) {
      return toIso(year, month, day);
    }
  }

  const named = MONTH_NAME_RE.exec(text);
  if (named !== null && named[1] !== undefined) {
    const month = MONTHS[named[1].toLowerCase()];
    if (month !== undefined) {
      const day = Number(named[2]);
      const year = Number(named[3]);
      if (isRealDate(year, month, day)) {
        return toIso(year, month, day);
      }
    }
  }

  const quarter = QUARTER_RE.exec(text);
  if (quarter !== null && quarter[1] !== undefined) {
    const month = QUARTER_END_MONTH[quarter[1]];
    if (month !== undefined) {
      const year = Number(quarter[2]);
      const day = month === 3 || month === 12 ? 31 : 30;
      return toIso(year, month, day);
    }
  }

  return undefined;
}
