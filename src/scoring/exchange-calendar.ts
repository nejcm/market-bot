// US equity exchange (NYSE/Nasdaq) trading calendar.
// Forecast horizons are counted in trading days, not raw weekdays.
// The resolver previously treated every weekday as a session, over-counting across holidays.
// That let the close-window due-date check fire before the Nth real session printed.
// It also pointed point-forecast (`macro`/`iv`) target dates at a closed market.
// This module supplies the missing closure set so a trading day is an open weekday.
// Closures derive deterministically from the published NYSE holiday rules: no year tables, no dependency.
// All date math is UTC to match the YYYY-MM-DD instants used elsewhere in scoring.

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function shiftDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

// Nth occurrence (1-based) of a weekday (0=Sun..6=Sat) within a month.
function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): Date {
  const first = utcDate(year, month, 1);
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return utcDate(year, month, 1 + offset + (n - 1) * 7);
}

// Last occurrence of a weekday within a month.
function lastWeekdayOfMonth(year: number, month: number, weekday: number): Date {
  const last = new Date(Date.UTC(year, month, 0));
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return utcDate(year, month, last.getUTCDate() - offset);
}

// Anonymous Gregorian computus (Meeus/Jones/Butcher) for Easter Sunday.
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utcDate(year, month, day);
}

// Saturday holidays observe the prior Friday; Sunday holidays observe the next Monday.
function observedFixed(date: Date): Date {
  const dow = date.getUTCDay();
  if (dow === 6) {
    return shiftDays(date, -1);
  }
  if (dow === 0) {
    return shiftDays(date, 1);
  }
  return date;
}

// New Year's Day. The NYSE keeps the prior Friday open when Jan 1 lands on a Saturday.
function newYearsClosures(year: number): readonly Date[] {
  const jan1 = utcDate(year, 1, 1);
  const dow = jan1.getUTCDay();
  if (dow === 0) {
    return [utcDate(year, 1, 2)];
  }
  if (dow === 6) {
    return [];
  }
  return [jan1];
}

function exchangeHolidaysForYear(year: number): ReadonlySet<string> {
  const mlkDay = nthWeekdayOfMonth(year, 1, 1, 3);
  const washingtonsBirthday = nthWeekdayOfMonth(year, 2, 1, 3);
  const goodFriday = shiftDays(easterSunday(year), -2);
  const memorialDay = lastWeekdayOfMonth(year, 5, 1);
  // Juneteenth became a federal holiday in 2021 and a market closure from 2022.
  const juneteenth = year >= 2022 ? [observedFixed(utcDate(year, 6, 19))] : [];
  const independenceDay = observedFixed(utcDate(year, 7, 4));
  const laborDay = nthWeekdayOfMonth(year, 9, 1, 1);
  const thanksgiving = nthWeekdayOfMonth(year, 11, 4, 4);
  const christmas = observedFixed(utcDate(year, 12, 25));

  const closures: readonly Date[] = [
    ...newYearsClosures(year),
    mlkDay,
    washingtonsBirthday,
    goodFriday,
    memorialDay,
    ...juneteenth,
    independenceDay,
    laborDay,
    thanksgiving,
    christmas,
  ];
  return new Set(closures.map((date) => ymd(date)));
}

const holidayCacheByYear = new Map<number, ReadonlySet<string>>();

function holidaysFor(year: number): ReadonlySet<string> {
  const cached = holidayCacheByYear.get(year);
  if (cached !== undefined) {
    return cached;
  }
  const computed = exchangeHolidaysForYear(year);
  holidayCacheByYear.set(year, computed);
  return computed;
}

// True only for full-day closures, not early-close (half) sessions.
// A half session (e.g. the day after Thanksgiving) still prints a daily close.
// The resolver therefore treats those days as trading days.
export function isExchangeHoliday(date: Date): boolean {
  return holidaysFor(date.getUTCFullYear()).has(ymd(date));
}

export function isExchangeTradingDay(date: Date): boolean {
  const dow = date.getUTCDay();
  return dow !== 0 && dow !== 6 && !isExchangeHoliday(date);
}

// Advance from an ISO instant by N exchange trading days (open weekdays).
// Shared by close-window scoring and alpha validation so both count real sessions.
// All date math is UTC, so results stay deterministic across time zones.
export function resolutionDate(generatedAt: string, horizonTradingDays: number): Date {
  let count = 0;
  let cursor = new Date(generatedAt);
  while (count < horizonTradingDays) {
    cursor = shiftDays(cursor, 1);
    if (isExchangeTradingDay(cursor)) {
      count += 1;
    }
  }
  return cursor;
}
