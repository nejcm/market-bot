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

const MIN_STATEMENT_DURATION_DAYS = 80;
const CALENDAR_POSITION_DAYS = 7;
const statementDatesByRoot = new WeakMap<
  Record<string, unknown>,
  ReadonlyMap<string, readonly string[]>
>();
const unprovenByRows = new WeakMap<readonly unknown[], ReadonlyMap<unknown, UnprovenRestatement>>();

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

function conceptRows(fact: unknown): readonly SecFactRow[] {
  return isRecord(fact) && isRecord(fact.units)
    ? Object.values(fact.units).flatMap((values) =>
        (Array.isArray(values) ? values : []).flatMap((value) => secFactRow(value) ?? []),
      )
    : [];
}

// A filing's statement dates: each pre-filing date with both an Assets instant and an 80+ day duration.
function filingStatementDates(
  root: Record<string, unknown>,
): ReadonlyMap<string, readonly string[]> {
  const cached = statementDatesByRoot.get(root);
  if (cached !== undefined) {
    return cached;
  }
  const durationEnds = new Set<string>();
  for (const row of Object.values(root).flatMap((fact) => conceptRows(fact))) {
    const length = row.start === undefined ? undefined : daysBetween(row.start, row.end);
    if (length !== undefined && length >= MIN_STATEMENT_DURATION_DAYS && row.end < row.filed) {
      durationEnds.add(`${row.accn}|${row.end}`);
    }
  }
  const dates = new Map<string, string[]>();
  for (const row of conceptRows(root.Assets)) {
    const accnDates = dates.get(row.accn) ?? [];
    if (
      row.start === undefined &&
      durationEnds.has(`${row.accn}|${row.end}`) &&
      !accnDates.includes(row.end)
    ) {
      dates.set(row.accn, [...accnDates, row.end].toSorted());
    }
  }
  statementDatesByRoot.set(root, dates);
  return dates;
}

// The date itself or a comparative in another year; the slack absorbs 52/53-week fiscal years.
function sameCalendarPosition(end: string, statementDate: string): boolean {
  const [, month, day] = statementDate.split("-").map(Number);
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

function findUnprovenRestatements(
  root: Record<string, unknown>,
  values: readonly unknown[],
): ReadonlyMap<unknown, UnprovenRestatement> {
  const statementDates = filingStatementDates(root);
  const rows = values.flatMap((value) => {
    const row = secFactRow(value);
    return row === undefined ? [] : [{ value, row }];
  });
  const aligned = new Set(
    rows
      .filter(
        ({ row }) =>
          row.start !== undefined &&
          (statementDates.get(row.accn) ?? []).some((date) => sameCalendarPosition(row.end, date)),
      )
      .map(({ row }) => row.accn),
  );
  const offPeriod = (accn: string) => statementDates.has(accn) && !aligned.has(accn);
  const unproven = new Map<unknown, UnprovenRestatement>();
  for (const { value, row } of rows) {
    if (row.start === undefined || !offPeriod(row.accn)) {
      continue;
    }
    const peers = rows
      .map(({ row: peer }) => peer)
      .filter((peer) => peer.accn !== row.accn && rowPeriodKey(peer) === rowPeriodKey(row));
    const standingFiled = peers
      .map((peer) => peer.filed)
      .filter((filed) => filed < row.filed)
      .toSorted()
      .at(-1);
    const standing = peers.filter((peer) => peer.filed === standingFiled);
    if (standing.length === 0 || standing.some((peer) => peer.val === row.val)) {
      continue;
    }
    const [supersededAt] = peers
      .map((peer) => peer.filed)
      .filter((filed) => filed > row.filed)
      .toSorted();
    unproven.set(value, {
      ...(supersededAt === undefined ? {} : { supersededAt }),
      accessionNumber: row.accn,
      form: row.form ?? "filing",
      filedAt: row.filed,
      periodEnd: statementDates.get(row.accn)!.at(-1)!,
      spans: [
        ...new Set(
          rows
            .filter(({ row: peer }) => peer.accn === row.accn && peer.start !== undefined)
            .map(({ row: peer }) => `${peer.start!}..${peer.end}`),
        ),
      ].toSorted(),
    });
  }
  return unproven;
}

// Off-period rows that would replace the standing value: a shifted context, not a proven restatement.
export function unprovenRestatements(
  root: Record<string, unknown>,
  values: readonly unknown[],
): ReadonlyMap<unknown, UnprovenRestatement> {
  const cached = unprovenByRows.get(values);
  if (cached !== undefined) {
    return cached;
  }
  const unproven = findUnprovenRestatements(root, values);
  unprovenByRows.set(values, unproven);
  return unproven;
}
