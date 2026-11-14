import { DAY_MS, daysBetween } from "../../config/shared";
import { isRecord, readString } from "../../guards";
import { financialStatementPeriodKey } from "./financial-statement-selection";

export interface StatementFiscalPeriod {
  readonly periodEnd: string;
  readonly form: string;
  readonly fiscalPeriod: string;
}

// Calendar-year labels fit calendar filers and BNS-style Oct-31 years.
// Jan-31 retailers may call 2018-01-31 FY2017 while this yields 2018; that still beats the reported fy frame.
export function calendarYearFromPeriodEnd(periodEnd: string): number | undefined {
  const year = Number.parseInt(periodEnd.slice(0, 4), 10);
  return Number.isFinite(year) ? year : undefined;
}

export function statementFiscalPeriodKey(period: StatementFiscalPeriod): string {
  const year = calendarYearFromPeriodEnd(period.periodEnd);
  return period.form === "10-K"
    ? `${period.periodEnd}|${period.form}|${String(year ?? "")}`
    : `${period.periodEnd}|${period.form}|${String(year ?? "")}|${period.fiscalPeriod}`;
}

const GROSS_DEBT_CALIBRATION_TOLERANCE = 0.05;

// A fresher principal-only instant withholds debt when principal matched net at net's period end and no current debt is tagged there.
export function grossPrincipalWithholdsDebt(
  net: { readonly periodEnd: string; readonly value: number },
  latestGrossPeriodEnd: string,
  grossAtNetPeriodEnd: number | undefined,
  currentDebtAtGross: readonly number[],
): boolean {
  return (
    latestGrossPeriodEnd > net.periodEnd &&
    currentDebtAtGross.every((value) => value === 0) &&
    grossAtNetPeriodEnd !== undefined &&
    Math.abs(grossAtNetPeriodEnd - net.value) <=
      GROSS_DEBT_CALIBRATION_TOLERANCE * Math.abs(net.value)
  );
}

interface SecFactRow {
  readonly accn: string;
  readonly start?: string;
  readonly end: string;
  readonly filed: string;
  readonly form?: string;
  readonly val: unknown;
}

const MIN_FILING_PERIOD_DAYS = 80;
const CALENDAR_POSITION_DAYS = 7;
const filingPeriodEndsByRoot = new WeakMap<Record<string, unknown>, ReadonlyMap<string, string>>();

function secFactRow(value: unknown): SecFactRow | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const accn = readString(value, "accn");
  const end = readString(value, "end");
  const filed = readString(value, "filed");
  const start = readString(value, "start");
  const form = readString(value, "form");
  return accn === undefined || end === undefined || filed === undefined
    ? undefined
    : {
        accn,
        end,
        filed,
        val: value.val,
        ...(start === undefined ? {} : { start }),
        ...(form === undefined ? {} : { form }),
      };
}

function taxonomyRows(root: Record<string, unknown>): readonly SecFactRow[] {
  return Object.values(root).flatMap((fact) =>
    isRecord(fact) && isRecord(fact.units)
      ? Object.values(fact.units).flatMap((values) =>
          (Array.isArray(values) ? values : []).flatMap((value) => secFactRow(value) ?? []),
        )
      : [],
  );
}

// A filing's own period end: its latest pre-filing date tagged with both a balance-sheet instant and an 80+ day duration.
function filingPeriodEnds(root: Record<string, unknown>): ReadonlyMap<string, string> {
  const cached = filingPeriodEndsByRoot.get(root);
  if (cached !== undefined) {
    return cached;
  }
  const instants = new Map<string, Set<string>>();
  const durations = new Map<string, Set<string>>();
  for (const row of taxonomyRows(root)) {
    const length = row.start === undefined ? undefined : daysBetween(row.start, row.end);
    const target = row.start === undefined ? instants : durations;
    if (row.end < row.filed && (length === undefined || length >= MIN_FILING_PERIOD_DAYS)) {
      target.set(row.accn, (target.get(row.accn) ?? new Set()).add(row.end));
    }
  }
  const ends = new Map<string, string>();
  for (const [accn, dates] of instants) {
    const end = [...dates]
      .filter((date) => durations.get(accn)?.has(date) === true)
      .toSorted()
      .at(-1);
    if (end !== undefined) {
      ends.set(accn, end);
    }
  }
  filingPeriodEndsByRoot.set(root, ends);
  return ends;
}

// The period end itself or a prior-year comparative; the slack absorbs 52/53-week fiscal years.
function sameCalendarPosition(end: string, periodEnd: string): boolean {
  const [, month, day] = periodEnd.split("-").map(Number);
  const year = Number(end.slice(0, 4));
  return [year - 1, year, year + 1].some(
    (candidate) =>
      Math.abs(Date.parse(end) - Date.UTC(candidate, month! - 1, day)) <=
      CALENDAR_POSITION_DAYS * DAY_MS,
  );
}

function rowPeriodKey(row: SecFactRow): string {
  return financialStatementPeriodKey({
    ...(row.start === undefined ? {} : { periodStart: row.start }),
    periodEnd: row.end,
  });
}

export interface UnprovenRestatement {
  readonly accessionNumber: string;
  readonly form: string;
  readonly filedAt: string;
  readonly periodEnd: string;
  readonly spans: readonly string[];
  readonly supersededAt?: string;
}

// Duration rows (of one concept and unit) whose filing never tags the concept at its own period end
// Yet would supersede an earlier filing's value: a shifted context, not a proven restatement.
export function unprovenRestatements(
  root: Record<string, unknown>,
  values: readonly unknown[],
): ReadonlyMap<unknown, UnprovenRestatement> {
  const periodEnds = filingPeriodEnds(root);
  const rows = values.flatMap((value) => {
    const row = secFactRow(value);
    return row === undefined ? [] : [{ value, row }];
  });
  const offPeriod = new Set(
    [...new Set(rows.map(({ row }) => row.accn))].filter((accn) => {
      const periodEnd = periodEnds.get(accn);
      return (
        periodEnd !== undefined &&
        !rows.some(
          ({ row }) =>
            row.accn === accn &&
            row.start !== undefined &&
            sameCalendarPosition(row.end, periodEnd),
        )
      );
    }),
  );
  const unproven = new Map<unknown, UnprovenRestatement>();
  for (const { value, row } of rows) {
    const peers =
      row.start !== undefined && offPeriod.has(row.accn)
        ? rows
            .map(({ row: peer }) => peer)
            .filter((peer) => peer.accn !== row.accn && rowPeriodKey(peer) === rowPeriodKey(row))
        : [];
    if (peers.some((earlier) => earlier.filed < row.filed && earlier.val !== row.val)) {
      const supersededAt = peers
        .map((later) => later.filed)
        .filter((filed) => filed > row.filed)
        .toSorted()[0];
      unproven.set(value, {
        ...(supersededAt === undefined ? {} : { supersededAt }),
        accessionNumber: row.accn,
        form: row.form ?? "filing",
        filedAt: row.filed,
        periodEnd: periodEnds.get(row.accn)!,
        spans: [
          ...new Set(
            rows
              .filter(({ row: peer }) => peer.accn === row.accn && peer.start !== undefined)
              .map(({ row: peer }) => `${peer.start!}..${peer.end}`),
          ),
        ].toSorted(),
      });
    }
  }
  return unproven;
}
