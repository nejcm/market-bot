import { DAY_MS } from "../config/shared";
import { isRecord, stringArrayValue } from "../guards";

export type SecFilingForm = "10-K" | "10-Q" | "8-K" | "20-F" | "40-F" | "6-K";

export interface SecFiling {
  readonly form: SecFilingForm;
  readonly filingDate: string;
  readonly reportDate?: string;
  readonly accessionNumber: string;
  readonly primaryDocument: string;
  // Current-report item codes (e.g. "2.02"). Absent when the submissions payload omits them,
  // Which is treated as unknown rather than empty.
  readonly items?: readonly string[];
}

const SEC_8K_LOOKBACK_DAYS = 120;
const SEC_8K_LIMIT = 2;
const SEC_6K_LIMIT = 2;

const FOREIGN_PRIVATE_ISSUER_ANNUAL_FORMS = ["20-F", "40-F"] as const;
const FOREIGN_PRIVATE_ISSUER_FORMS = [...FOREIGN_PRIVATE_ISSUER_ANNUAL_FORMS, "6-K"] as const;

function matchesSecForm(form: string, base: string): boolean {
  return form === base || form.startsWith(`${base}/`);
}

export function detectForeignPrivateIssuerForms(payload: unknown): readonly string[] {
  if (!isRecord(payload) || !isRecord(payload.filings) || !isRecord(payload.filings.recent)) {
    return [];
  }
  const forms = stringArrayValue(payload.filings.recent.form);
  return FOREIGN_PRIVATE_ISSUER_FORMS.filter((base) =>
    forms.some((form) => matchesSecForm(form, base)),
  );
}

function recentSecFilingRows(payload: unknown): readonly SecFiling[] {
  if (!isRecord(payload) || !isRecord(payload.filings) || !isRecord(payload.filings.recent)) {
    return [];
  }

  const { recent } = payload.filings;
  const { form: forms, filingDate: filingDates, accessionNumber: accessionNumbers } = recent;
  const primaryDocuments = recent.primaryDocument;
  if (
    !Array.isArray(forms) ||
    !Array.isArray(filingDates) ||
    !Array.isArray(accessionNumbers) ||
    !Array.isArray(primaryDocuments) ||
    forms.length !== filingDates.length ||
    forms.length !== accessionNumbers.length ||
    forms.length !== primaryDocuments.length
  ) {
    return [];
  }
  const reportDates =
    Array.isArray(recent.reportDate) && recent.reportDate.length === forms.length
      ? recent.reportDate
      : undefined;
  const itemCodes =
    Array.isArray(recent.items) && recent.items.length === forms.length ? recent.items : undefined;

  return forms.flatMap((f, index): SecFiling[] => {
    const foreignPrivateIssuerAnnualForm =
      typeof f === "string"
        ? FOREIGN_PRIVATE_ISSUER_ANNUAL_FORMS.find((base) => matchesSecForm(f, base))
        : undefined;
    if (
      f !== "10-K" &&
      f !== "10-Q" &&
      f !== "8-K" &&
      f !== "6-K" &&
      foreignPrivateIssuerAnnualForm === undefined
    ) {
      return [];
    }
    const filingDate = filingDates[index];
    const accessionNumber = accessionNumbers[index];
    const primaryDocument = primaryDocuments[index];
    if (
      typeof filingDate !== "string" ||
      filingDate.trim() === "" ||
      typeof accessionNumber !== "string" ||
      accessionNumber.trim() === "" ||
      typeof primaryDocument !== "string" ||
      primaryDocument.trim() === ""
    ) {
      return [];
    }
    const reportDate = reportDates?.[index];
    const itemCode = itemCodes?.[index];
    const items =
      typeof itemCode === "string" && itemCode.trim() !== ""
        ? itemCode
            .split(",")
            .map((code) => code.trim())
            .filter((code) => code !== "")
        : [];
    return [
      {
        form: foreignPrivateIssuerAnnualForm ?? f,
        filingDate,
        ...(typeof reportDate === "string" && reportDate.trim() !== "" ? { reportDate } : {}),
        accessionNumber,
        primaryDocument,
        ...(items.length > 0 ? { items } : {}),
      },
    ];
  });
}

export function selectLatestFilingByForm(
  payload: unknown,
  form: SecFiling["form"],
): SecFiling | undefined {
  return recentSecFilingRows(payload)
    .filter((filing) => filing.form === form)
    .toSorted((a, b) => b.filingDate.localeCompare(a.filingDate))[0];
}

function filingBasisDate(filing: SecFiling): string {
  return filing.reportDate ?? filing.filingDate;
}

export function selectCurrentQuarterlyFiling(
  payload: unknown,
  annual?: SecFiling,
): SecFiling | undefined {
  const latestQuarterly = selectLatestFilingByForm(payload, "10-Q");
  if (latestQuarterly === undefined || annual === undefined) {
    return latestQuarterly;
  }
  return filingBasisDate(latestQuarterly) > filingBasisDate(annual) ? latestQuarterly : undefined;
}

const EARNINGS_RELEASE_ITEM_CODE = "2.02";

export function byFilingRecency(left: SecFiling, right: SecFiling): number {
  return (
    right.filingDate.localeCompare(left.filingDate) ||
    right.accessionNumber.localeCompare(left.accessionNumber)
  );
}

export function selectRecentCurrentReports(
  payload: unknown,
  newestPeriodicFilingDate: string,
  fetchedAt: string,
): readonly SecFiling[] {
  const fetchedAtMs = Date.parse(fetchedAt);
  if (!Number.isFinite(fetchedAtMs)) {
    return [];
  }
  const recent = recentSecFilingRows(payload)
    .filter((filing) => filing.form === "8-K")
    .filter((filing) => {
      const filingDateMs = Date.parse(`${filing.filingDate}T00:00:00.000Z`);
      if (!Number.isFinite(filingDateMs)) {
        return false;
      }
      const ageDays = (fetchedAtMs - filingDateMs) / DAY_MS;
      return ageDays >= 0 && ageDays <= SEC_8K_LOOKBACK_DAYS;
    })
    .toSorted(byFilingRecency);

  // The earnings release is exempt from the periodic-filing floor. That floor exists so routine
  // 8-Ks predating the newest 10-K/10-Q are not re-read, but the Item 2.02 release normally lands
  // Days BEFORE the 10-Q and carries what the periodic filing does not (guidance, segment
  // Commentary, non-GAAP bridges). Filings without item codes are unknown, not empty, so the
  // Selection silently degrades to pure date ordering.
  const earningsRelease = recent.find(
    (filing) => filing.items?.includes(EARNINGS_RELEASE_ITEM_CODE) === true,
  );
  const dateSelected = recent.filter((filing) => filing.filingDate > newestPeriodicFilingDate);

  const selected: SecFiling[] = [];
  for (const filing of [
    ...(earningsRelease === undefined ? [] : [earningsRelease]),
    ...dateSelected,
  ]) {
    if (selected.length >= SEC_8K_LIMIT) {
      break;
    }
    if (!selected.some((chosen) => chosen.accessionNumber === filing.accessionNumber)) {
      selected.push(filing);
    }
  }
  return selected.toSorted(byFilingRecency);
}

export function selectRecentEarningsSixKs(
  payload: unknown,
  fetchedAt: string,
): readonly SecFiling[] {
  const fetchedAtMs = Date.parse(fetchedAt);
  if (!Number.isFinite(fetchedAtMs)) {
    return [];
  }
  return recentSecFilingRows(payload)
    .filter((filing) => filing.form === "6-K")
    .filter((filing) => {
      const filingDateMs = Date.parse(`${filing.filingDate}T00:00:00.000Z`);
      if (!Number.isFinite(filingDateMs)) {
        return false;
      }
      const ageDays = (fetchedAtMs - filingDateMs) / DAY_MS;
      return ageDays >= 0 && ageDays <= SEC_8K_LOOKBACK_DAYS;
    })
    .toSorted(
      (left, right) =>
        right.filingDate.localeCompare(left.filingDate) ||
        right.accessionNumber.localeCompare(left.accessionNumber),
    )
    .slice(0, SEC_6K_LIMIT);
}

export function filingUrl(cik: string, filing: SecFiling): string {
  const primaryDocument = encodeURIComponent(filing.primaryDocument);
  return `https://www.sec.gov/Archives/edgar/data/${String(Number(cik))}/${filing.accessionNumber.replaceAll("-", "")}/${primaryDocument}`;
}

export function secFilingKey(filing: SecFiling): string {
  if (filing.form === "10-K") {
    return "10k";
  }
  if (filing.form === "10-Q") {
    return "10q";
  }
  if (filing.form === "6-K") {
    return `6k-${filing.accessionNumber}`;
  }
  if (filing.form === "20-F" || filing.form === "40-F") {
    return filing.form.toLowerCase().replace("-", "");
  }
  return `8k-${filing.accessionNumber}`;
}

export function isEarningsRelease(filing: SecFiling): boolean {
  return filing.form === "8-K" && filing.items?.includes(EARNINGS_RELEASE_ITEM_CODE) === true;
}
