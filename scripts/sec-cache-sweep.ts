import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isRecord } from "../src/guards";
import { financialStatementSeries } from "../src/sources/extended-evidence/financial-statement-selection";
import {
  detectForeignPrivateIssuerForms,
  type SecFilingForm,
} from "../src/sources/sec-filing-selection";
import {
  hasSubstantiveResultsContent,
  normalizeFilingText,
  secFilingSectionPacket,
  type SectionMiss,
} from "../src/sources/sec-filing-text";
import { runOfflineFinancialStatementCorpus } from "../tests/support/offline-financial-statements-corpus";
import {
  collectFinancialStatementInvariants,
  type FinancialInvariantResult,
} from "../tests/support/run-fixtures/financial-invariants";

interface CachedEntry {
  readonly path: string;
  readonly cachedDate: string;
  readonly fetchedAt: string;
}

interface CompanySweep {
  readonly cik: string;
  readonly entityName: string;
  readonly cachedDate: string;
  readonly submissionsDate: string | null;
  readonly foreignPrivateIssuer: boolean | null;
  readonly taxonomy: string | null;
  readonly reportingCurrency: string | null;
  readonly series: Readonly<
    Record<
      string,
      {
        readonly status: "present" | "gap" | "missing";
        readonly annualCount: number;
        readonly interimCount: number;
        readonly ttmCount: number;
        readonly gapReasons: readonly string[];
      }
    >
  >;
  readonly gapReasons: readonly string[];
  readonly invariantViolations: readonly string[];
  readonly invariants: readonly FinancialInvariantResult[];
  readonly disagreements: readonly string[];
}

interface FilingSweep {
  readonly contentHash: string;
  readonly cachedDate: string;
  readonly form: SecFilingForm | "unknown";
  readonly sectionCount: number;
  readonly misses: readonly SectionMiss[];
  readonly packetLength: number;
  readonly startsInBoilerplate: boolean | null;
}

interface ReasonCount {
  readonly reason: string;
  readonly count: number;
}

interface SecSweepReport {
  readonly companies: readonly CompanySweep[];
  readonly filings: readonly FilingSweep[];
  readonly summary: {
    readonly copies: {
      readonly companyfacts: number;
      readonly submissions: number;
      readonly filingText: number;
    };
    readonly cikCount: number;
    readonly filingCount: number;
    readonly unknownFormCount: number;
    readonly emptyPacketCount: number;
    readonly boilerplateCount: number;
    readonly skippedInvalidCacheCount: number;
    readonly seriesCoverage: Readonly<
      Record<
        string,
        {
          readonly present: number;
          readonly gap: number;
          readonly missing: number;
          readonly coveragePercent: number;
        }
      >
    >;
    readonly topGapReasons: readonly ReasonCount[];
    readonly disagreements: readonly ReasonCount[];
    readonly disagreementsByIssuerType: Readonly<
      Record<
        "fpi" | "domestic" | "unknown",
        {
          readonly cikCount: number;
          readonly disagreeingCikCount: number;
          readonly paths: readonly ReasonCount[];
        }
      >
    >;
    readonly invariantViolations: readonly ReasonCount[];
    readonly sectionMisses: readonly ReasonCount[];
    readonly flaggedCiks: readonly string[];
  };
}

export function normalizeCik(value: unknown): string | undefined {
  const digits = typeof value === "number" || typeof value === "string" ? String(value) : "";
  return /^\d{1,10}$/u.test(digits) && Number(digits) > 0 ? digits.padStart(10, "0") : undefined;
}

export function newestCachedEntry(
  entries: readonly CachedEntry[],
  asOf?: string,
): CachedEntry | undefined {
  return entries
    .filter((entry) => asOf === undefined || entry.cachedDate <= asOf)
    .toSorted(
      (a, b) =>
        b.cachedDate.localeCompare(a.cachedDate) ||
        b.fetchedAt.localeCompare(a.fetchedAt) ||
        a.path.localeCompare(b.path),
    )[0];
}

export function inferFilingForm(normalized: string): SecFilingForm | "unknown" {
  const cover = normalized.slice(0, 12_000);
  const match =
    /\bFORM\s+(10\s*-\s*K|10\s*-\s*Q|20\s*-\s*F|40\s*-\s*F|8\s*-\s*K|6\s*-\s*K)\b/iu.exec(cover);
  return match === null
    ? "unknown"
    : (match[1]!.replaceAll(/\s/gu, "").toUpperCase() as SecFilingForm);
}

export function packetStartsInBoilerplate(packet: string): boolean {
  return (
    /safe[\s-]+harbo[u]?r|forward[\s-]+looking/iu.test(packet.slice(0, 500)) ||
    !hasSubstantiveResultsContent(packet)
  );
}

function rankedCounts(groups: readonly (readonly string[])[]): readonly ReasonCount[] {
  const counts = new Map<string, number>();
  for (const group of groups) {
    for (const reason of new Set(group)) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([reason, count]) => ({ reason, count }))
    .toSorted((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

async function readCache(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = await Bun.file(path).json();
    return isRecord(value) ? value : undefined;
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    return undefined;
  }
}

export async function sweepSecCache(cacheDir: string): Promise<SecSweepReport> {
  const companies = new Map<string, CachedEntry>();
  const submissions = new Map<string, CachedEntry[]>();
  const filingsByHash = new Map<string, FilingSweep>();
  let skippedInvalidCacheCount = 0;
  const copies = { companyfacts: 0, submissions: 0, filingText: 0 };
  for await (const relative of new Bun.Glob("*/*.json").scan(cacheDir)) {
    const path = join(cacheDir, relative);
    const entry = await readCache(path);
    if (entry === undefined) {
      skippedInvalidCacheCount += 1;
      continue;
    }
    if (
      typeof entry.adapter !== "string" ||
      !["sec-companyfacts", "sec-submissions", "sec-filing-text"].includes(entry.adapter)
    ) {
      continue;
    }
    if (
      typeof entry.cachedDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(entry.cachedDate) ||
      typeof entry.fetchedAt !== "string"
    ) {
      throw new Error(`Invalid SEC cache dates: ${path}`);
    }
    if (entry.adapter === "sec-filing-text") {
      copies.filingText += 1;
      if (typeof entry.payload !== "string") {
        throw new TypeError(`Invalid SEC filing text: ${path}`);
      }
      const contentHash = createHash("sha256").update(entry.payload).digest("hex");
      const previous = filingsByHash.get(contentHash);
      if (previous !== undefined) {
        if (entry.cachedDate > previous.cachedDate) {
          filingsByHash.set(contentHash, { ...previous, cachedDate: entry.cachedDate });
        }
        continue;
      }
      const normalized = normalizeFilingText(entry.payload);
      const form = inferFilingForm(normalized);
      const packet = form === "unknown" ? undefined : secFilingSectionPacket(normalized, form);
      filingsByHash.set(contentHash, {
        contentHash,
        cachedDate: entry.cachedDate,
        form,
        sectionCount: packet?.sectionCount ?? 0,
        misses: packet?.misses ?? [],
        packetLength: packet?.packet?.length ?? 0,
        startsInBoilerplate:
          (form !== "10-K" && form !== "10-Q") || packet?.packet === undefined
            ? null
            : packetStartsInBoilerplate(packet.packet),
      });
      continue;
    }
    const cik = isRecord(entry.payload) ? normalizeCik(entry.payload.cik) : undefined;
    if (cik === undefined) {
      throw new Error(`Invalid SEC cache CIK: ${path}`);
    }
    const descriptor = { path, cachedDate: entry.cachedDate, fetchedAt: entry.fetchedAt };
    if (entry.adapter === "sec-companyfacts") {
      copies.companyfacts += 1;
      const previous = companies.get(cik);
      companies.set(
        cik,
        newestCachedEntry(previous === undefined ? [descriptor] : [previous, descriptor])!,
      );
    } else {
      copies.submissions += 1;
      const entries = submissions.get(cik) ?? [];
      entries.push(descriptor);
      submissions.set(cik, entries);
    }
  }
  const companyResults: CompanySweep[] = [];
  for (const [cik, entry] of [...companies].toSorted(([a], [b]) => a.localeCompare(b))) {
    // oxlint-disable-next-line no-await-in-loop -- Sequential reads bound companyfacts memory.
    const companyEntry = await readCache(entry.path);
    if (companyEntry === undefined) {
      throw new Error(`Selected SEC cache entry became invalid: ${entry.path}`);
    }
    const companyFacts = companyEntry.payload;
    const submissionEntry = newestCachedEntry(submissions.get(cik) ?? [], entry.cachedDate);
    // oxlint-disable-next-line no-await-in-loop -- Sequential reads bound companyfacts memory.
    const pairedSubmission = submissionEntry && (await readCache(submissionEntry.path));
    const submissionPayload = pairedSubmission?.payload;
    const foreignPrivateIssuer =
      submissionPayload === undefined
        ? null
        : detectForeignPrivateIssuerForms(submissionPayload).length > 0;
    const entityName =
      isRecord(companyFacts) && typeof companyFacts.entityName === "string"
        ? companyFacts.entityName
        : "unknown";
    const symbol =
      isRecord(submissionPayload) &&
      Array.isArray(submissionPayload.tickers) &&
      typeof submissionPayload.tickers[0] === "string"
        ? submissionPayload.tickers[0]
        : cik;
    const execution = runOfflineFinancialStatementCorpus({
      fixture: cik,
      symbol,
      analysisAsOf: entry.cachedDate,
      sourceId: `sweep-sec-companyfacts-${cik}`,
      provenance: { companyFacts: entry.path, submissions: submissionEntry?.path ?? "" },
      companyFacts,
      submissions: submissionPayload,
    });
    const { artifact } = execution;
    const invariants = collectFinancialStatementInvariants(artifact);
    const invariantViolations = invariants
      .filter((result) => result.failingCount > 0)
      .map((result) => result.code);
    const structuredGaps = artifact.structuredFinancialGaps.map((gap) => gap.code);
    const series = Object.fromEntries(
      financialStatementSeries(artifact).map((item) => {
        const present = item.annual.length + item.interim.length > 0;
        const gapReasons = present
          ? []
          : [
              ...new Set(
                [...artifact.validationNotes, ...artifact.omissionNotes]
                  .filter((note) => note.seriesKey === item.key)
                  .map((note) => note.code),
              ),
            ];
        let status: "present" | "gap" | "missing" = "missing";
        if (present) {
          status = "present";
        } else if (gapReasons.length > 0) {
          status = "gap";
        }
        return [
          item.key,
          {
            status,
            annualCount: item.annual.length,
            interimCount: item.interim.length,
            ttmCount: item.ttm === undefined ? 0 : 1,
            gapReasons,
          },
        ];
      }),
    );
    companyResults.push({
      cik,
      entityName,
      cachedDate: entry.cachedDate,
      submissionsDate: submissionEntry?.cachedDate ?? null,
      foreignPrivateIssuer,
      taxonomy: artifact.taxonomy ?? null,
      reportingCurrency: artifact.reportingCurrency ?? null,
      series,
      gapReasons: [
        ...new Set([
          ...structuredGaps,
          ...(submissionEntry === undefined ? ["missing-submissions"] : []),
          ...Object.values(series).flatMap((item) => item.gapReasons),
        ]),
      ],
      invariantViolations,
      invariants,
      disagreements: execution.differences.map((difference) => difference.path),
    });
  }
  const seriesKeys = [
    ...new Set(companyResults.flatMap((company) => Object.keys(company.series))),
  ].toSorted();
  const filings = [...filingsByHash.values()];
  const issuerGroups = {
    fpi: companyResults.filter((company) => company.foreignPrivateIssuer === true),
    domestic: companyResults.filter((company) => company.foreignPrivateIssuer === false),
    unknown: companyResults.filter((company) => company.foreignPrivateIssuer === null),
  };
  const disagreementCounts = (group: readonly CompanySweep[]) => ({
    cikCount: group.length,
    disagreeingCikCount: group.filter((company) => company.disagreements.length > 0).length,
    paths: rankedCounts(group.map((company) => company.disagreements)),
  });
  return {
    companies: companyResults,
    filings: filings.toSorted((a, b) => a.contentHash.localeCompare(b.contentHash)),
    summary: {
      copies,
      cikCount: companyResults.length,
      filingCount: filings.length,
      unknownFormCount: filings.filter((filing) => filing.form === "unknown").length,
      emptyPacketCount: filings.filter(
        (filing) => filing.form !== "unknown" && filing.packetLength === 0,
      ).length,
      boilerplateCount: filings.filter((filing) => filing.startsInBoilerplate === true).length,
      skippedInvalidCacheCount,
      seriesCoverage: Object.fromEntries(
        seriesKeys.map((key) => {
          const statuses = companyResults.map(
            (company) => company.series[key]?.status ?? "missing",
          );
          const present = statuses.filter((status) => status === "present").length;
          return [
            key,
            {
              present,
              gap: statuses.filter((status) => status === "gap").length,
              missing: statuses.filter((status) => status === "missing").length,
              coveragePercent:
                companyResults.length === 0 ? 0 : (100 * present) / companyResults.length,
            },
          ];
        }),
      ),
      topGapReasons: rankedCounts(companyResults.map((company) => company.gapReasons)),
      disagreements: rankedCounts(companyResults.map((company) => company.disagreements)),
      disagreementsByIssuerType: {
        fpi: disagreementCounts(issuerGroups.fpi),
        domestic: disagreementCounts(issuerGroups.domestic),
        unknown: disagreementCounts(issuerGroups.unknown),
      },
      invariantViolations: rankedCounts(
        companyResults.map((company) => company.invariantViolations),
      ),
      sectionMisses: rankedCounts(
        filings.map((filing) =>
          filing.misses.map((miss) => `${filing.form}.${miss.label}.${miss.reason}`),
        ),
      ),
      flaggedCiks: companyResults
        .filter(
          (company) => company.disagreements.length > 0 || company.invariantViolations.length > 0,
        )
        .map((company) => company.cik),
    },
  };
}

function printSummary(report: SecSweepReport, path: string): void {
  const { summary } = report;
  process.stdout.write(
    `SEC sweep: ${summary.cikCount} CIKs, ${summary.filingCount} unique filings\nCache copies: ${summary.copies.companyfacts} companyfacts, ${summary.copies.submissions} submissions, ${summary.copies.filingText} filing texts\nFilings: ${summary.unknownFormCount} unknown forms, ${summary.emptyPacketCount} empty packets, ${summary.boilerplateCount} boilerplate flags\nSeries coverage (present/gap/missing):\n`,
  );
  for (const [key, coverage] of Object.entries(summary.seriesCoverage)) {
    process.stdout.write(
      `  ${key}: ${coverage.coveragePercent.toFixed(1)}% (${coverage.present}/${coverage.gap}/${coverage.missing})\n`,
    );
  }
  for (const [label, counts] of [
    ["Gap reasons (CIKs)", summary.topGapReasons],
    ["Disagreements (CIKs)", summary.disagreements],
    ["Invariant violations (CIKs)", summary.invariantViolations],
    ["Section misses (filings)", summary.sectionMisses],
  ] as const) {
    process.stdout.write(`${label}: ${counts.length === 0 ? "none" : ""}\n`);
    for (const item of counts.slice(0, 10)) {
      process.stdout.write(`  ${item.reason}: ${item.count}\n`);
    }
  }
  for (const [issuerType, counts] of Object.entries(summary.disagreementsByIssuerType)) {
    process.stdout.write(
      `Disagreeing ${issuerType} CIKs: ${counts.disagreeingCikCount}/${counts.cikCount}\n`,
    );
  }
  process.stdout.write(`Skipped invalid cache entries: ${summary.skippedInvalidCacheCount}\n`);
  process.stdout.write(
    `Flagged CIKs (${summary.flaggedCiks.length}): ${summary.flaggedCiks.join(", ") || "none"}\nJSON: ${path}\n`,
  );
}

export async function writeSweepReport(
  report: SecSweepReport,
  outDir: string,
  timestamp: string,
): Promise<string> {
  const path = join(outDir, `sec-${timestamp.replaceAll(":", "-")}.json`);
  await mkdir(outDir, { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return path;
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "cache-dir": { type: "string", default: "data/cache" },
      "out-dir": { type: "string", default: "data/sweeps" },
    },
    strict: true,
    allowPositionals: false,
  });
  const cacheDir = resolve(values["cache-dir"]!);
  const outDir = resolve(values["out-dir"]!);
  if (outDir === cacheDir || outDir.startsWith(`${cacheDir}/`)) {
    throw new Error("Sweep output must be outside the cache directory");
  }
  const report = await sweepSecCache(cacheDir);
  const path = await writeSweepReport(report, outDir, new Date().toISOString());
  printSummary(report, path);
}
