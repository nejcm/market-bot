import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import {
  collectFinancialStatementInvariants,
  assertFinancialStatementInvariants,
} from "./support/run-fixtures/financial-invariants";
import {
  inferFilingForm,
  newestCachedEntry,
  normalizeCik,
  packetStartsInBoilerplate,
  sweepSecCache,
  writeSweepReport,
} from "../scripts/sec-cache-sweep";

const results =
  "Revenue was $10 million, net income was $2 million, operating income was $3 million, and earnings per share were $1.20.";

function point(value: number, end: string) {
  return {
    val: value,
    form: "10-K",
    fy: 2025,
    fp: "FY",
    filed: "2026-02-01",
    end,
    accn: "test-accession",
  };
}

describe("SEC cache sweep", () => {
  test("normalizes numeric and padded CIKs and rejects invalid identifiers", () => {
    expect(normalizeCik(320_193)).toBe("0000320193");
    expect(normalizeCik("0000320193")).toBe("0000320193");
    for (const invalid of [undefined, {}, "", "abc", -1, 1.5, 0, "12345678901"]) {
      expect(normalizeCik(invalid)).toBeUndefined();
    }
  });

  test("pairs the same date, then nearest earlier date, never a future date", () => {
    const entries = [
      { path: "earlier", cachedDate: "2026-10-08", fetchedAt: "2026-10-08T12:00:00Z" },
      { path: "same", cachedDate: "2026-10-09", fetchedAt: "2026-10-09T12:00:00Z" },
      { path: "same-newer", cachedDate: "2026-10-09", fetchedAt: "2026-10-09T13:00:00Z" },
      { path: "future", cachedDate: "2026-10-10", fetchedAt: "2026-10-10T12:00:00Z" },
    ];
    expect(newestCachedEntry(entries, "2026-10-09")?.path).toBe("same-newer");
    expect(newestCachedEntry([entries[0]!, entries[3]!], "2026-10-09")?.path).toBe("earlier");
    expect(newestCachedEntry(entries, "2026-10-07")).toBeUndefined();
    expect(newestCachedEntry([], "2026-10-09")).toBeUndefined();
    expect(
      newestCachedEntry([entries[1]!, { ...entries[1]!, path: "a" }], "2026-10-09")?.path,
    ).toBe("a");
  });

  test("infers cover forms with whitespace and amendments, and counts unknown covers", () => {
    for (const form of ["10-K", "10-Q", "20-F", "40-F", "8-K", "6-K"] as const) {
      expect(inferFilingForm(`UNITED STATES SECURITIES AND EXCHANGE COMMISSION FORM ${form}`)).toBe(
        form,
      );
    }
    expect(inferFilingForm("Form 10 - q/A Quarterly report")).toBe("10-Q");
    expect(inferFilingForm("Exhibit 99.1 Earnings release")).toBe("unknown");
    expect(inferFilingForm("FORM 10-Known")).toBe("unknown");
    expect(inferFilingForm(`${" ".repeat(12_000)}FORM 10-K`)).toBe("unknown");
  });

  test("flags the specified boilerplate heuristic without scanning past 500 chars", () => {
    expect(packetStartsInBoilerplate(`Forward-looking statements. ${results}`)).toBe(true);
    expect(packetStartsInBoilerplate(`Safe harbor statement. ${results}`)).toBe(true);
    expect(packetStartsInBoilerplate("Results of operations are furnished as Exhibit 99.1.")).toBe(
      true,
    );
    expect(packetStartsInBoilerplate(results)).toBe(false);
    expect(
      packetStartsInBoilerplate(`${results}${" ".repeat(500)}Forward-looking statements.`),
    ).toBe(false);
  });

  test("sweeps synthetic cache copies without persisting payloads or financial values", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "sec-sweep-"));
    const write = (id: string, adapter: string, cachedDate: string, payload: unknown) =>
      Bun.write(
        join(cacheDir, cachedDate, `${id}.json`),
        JSON.stringify({ adapter, cachedDate, fetchedAt: `${cachedDate}T12:00:00Z`, payload }),
      );
    try {
      await write("old", "sec-companyfacts", "2026-10-08", {
        cik: 1,
        entityName: "Old",
        facts: {},
      });
      await write("new", "sec-companyfacts", "2026-10-09", {
        cik: "0000000001",
        entityName: "Current",
        facts: {
          "us-gaap": {
            Revenues: {
              units: { USD: [{ ...point(100, "2025-12-31"), form: "20-F", start: "2025-01-01" }] },
            },
          },
        },
      });
      await write("submission", "sec-submissions", "2026-10-08", {
        cik: "0000000001",
        tickers: ["TEST"],
        filings: { recent: { form: ["6-K"], filingDate: ["2026-10-08"] } },
      });
      await write("future", "sec-submissions", "2026-10-10", { cik: 1, tickers: ["FUTURE"] });
      await write("unpaired", "sec-companyfacts", "2026-10-09", {
        cik: 2,
        entityName: "Unpaired",
        facts: {},
      });
      await write("text", "sec-filing-text", "2026-10-09", `<p>FORM 8-K ${results}</p>`);
      await write("duplicate", "sec-filing-text", "2026-10-08", `<p>FORM 8-K ${results}</p>`);
      await write("unknown", "sec-filing-text", "2026-10-09", "Exhibit 99.1");
      await write("empty", "sec-filing-text", "2026-10-09", "FORM 10-K");
      await write("ignored", "other", "2026-10-09", { secret: "never emitted" });
      await Bun.write(join(cacheDir, "2026-10-09", "malformed.json"), "broken JSON");
      await Bun.write(join(cacheDir, "2026-10-09", "scalar.json"), "42");
      await Bun.write(join(cacheDir, "2026-10-09", "no-adapter.json"), "{}");
      const report = await sweepSecCache(cacheDir);
      expect(report.summary.copies).toEqual({ companyfacts: 3, submissions: 2, filingText: 4 });
      expect(report.summary.cikCount).toBe(2);
      expect(report.companies[0]).toMatchObject({
        cik: "0000000001",
        entityName: "Current",
        submissionsDate: "2026-10-08",
        taxonomy: "us-gaap",
        reportingCurrency: "USD",
        invariantViolations: [],
        foreignPrivateIssuer: true,
      });
      expect(report.companies[1]?.gapReasons).toContain("missing-submissions");
      expect(report.summary.filingCount).toBe(3);
      expect(report.summary.unknownFormCount).toBe(1);
      expect(report.summary.emptyPacketCount).toBe(1);
      expect(report.filings.find((filing) => filing.form === "8-K")).toMatchObject({
        cachedDate: "2026-10-09",
        startsInBoilerplate: null,
      });
      expect(report.summary.skippedInvalidCacheCount).toBe(2);
      expect(report.companies[0]?.series.dividendsPaid).toMatchObject({
        status: "missing",
        gapReasons: [],
      });
      expect(report.companies[0]?.gapReasons).toContain("untagged-6-k");
      expect(report.summary.topGapReasons.some((item) => item.reason === "missing-series")).toBe(
        false,
      );
      expect(report.summary.disagreementsByIssuerType.fpi.cikCount).toBe(1);
      expect(report.summary.disagreementsByIssuerType.fpi.disagreeingCikCount).toBe(1);
      expect(report.summary.disagreementsByIssuerType.fpi.paths.length).toBeGreaterThan(0);
      expect(report.summary.disagreementsByIssuerType.unknown.cikCount).toBe(1);
      expect(report.summary.seriesCoverage.revenue).toEqual({
        present: 1,
        gap: 0,
        missing: 1,
        coveragePercent: 50,
      });
      expect(report.summary.topGapReasons).toContainEqual({
        reason: "no-standard-taxonomy",
        count: 1,
      });
      const text = JSON.stringify(report);
      expect(text).not.toContain("$10 million");
      expect(text).not.toContain("never emitted");
      expect(text).not.toContain("canonical");
      expect(text).not.toContain(cacheDir);
      const timestamp = "2026-10-09T12:00:00.123Z";
      const path = await writeSweepReport(report, cacheDir, timestamp);
      const before = await Bun.file(path).text();
      await expect(writeSweepReport(report, cacheDir, timestamp)).rejects.toMatchObject({
        code: "EEXIST",
      });
      expect(await Bun.file(path).text()).toBe(before);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  test("collects simultaneous invariants with period counts and latest failure", () => {
    const artifact = deriveFinancialStatements(
      {
        facts: {
          "us-gaap": {
            Assets: { units: { USD: [point(100, "2024-12-31"), point(100, "2025-12-31")] } },
            Liabilities: { units: { USD: [point(40, "2024-12-31"), point(40, "2025-12-31")] } },
            StockholdersEquity: {
              units: { USD: [point(60, "2024-12-31"), point(60, "2025-12-31")] },
            },
            Revenues: { units: { USD: [{ ...point(100, "2025-12-31"), start: "2025-01-01" }] } },
          },
        },
      },
      { symbol: "TEST", generatedAt: "2026-10-09", analysisAsOf: "2026-10-09", sourceId: "test" },
    );
    const assets = artifact.statements.balanceSheet.totalAssets;
    if (assets.annual.length < 2) {
      throw new Error("Synthetic companyfacts did not produce two balance-sheet periods");
    }
    const { revenue } = artifact.statements.incomeStatement;
    const injected = {
      ...artifact,
      statements: {
        ...artifact.statements,
        balanceSheet: {
          ...artifact.statements.balanceSheet,
          totalAssets: {
            ...assets,
            annual: assets.annual.map((fact) => ({ ...fact, value: fact.value + 20 })),
          },
        },
        incomeStatement: {
          ...artifact.statements.incomeStatement,
          revenue: {
            ...revenue,
            annual: revenue.annual.map((fact) => ({
              ...fact,
              periodKey: "invalid",
              extractionMethod: "derived-sec-companyfacts" as const,
            })),
          },
        },
      },
      validationNotes: [],
    };
    expect(() => assertFinancialStatementInvariants(injected)).toThrow(/\[A2\]/u);
    const checks = collectFinancialStatementInvariants(injected);
    expect(checks.find((check) => check.code === "A6")).toMatchObject({
      assertedPeriodCount: 2,
      failingPeriodCount: 2,
      latestFailingPeriodEnd: "2025-12-31",
    });
    expect(checks.find((check) => check.code === "A2")?.failingCount).toBeGreaterThan(0);
    expect(checks.find((check) => check.code === "A8")?.failingCount).toBeGreaterThan(0);
    expect(checks.find((check) => check.code === "A7")?.assertedCount).toBeGreaterThan(0);
    expect(checks.find((check) => check.code === "A7")?.failingCount).toBeGreaterThan(0);
  });
});
