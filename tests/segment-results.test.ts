import { describe, expect, test } from "bun:test";
import type { ExtendedEvidenceItem } from "../src/domain/evidence";
import { segmentResultsSection } from "../src/sources/extended-evidence/segment-results";
import { secSegmentFactMetrics } from "../src/sources/sec-segment-facts";

const AXIS = "us-gaap:StatementBusinessSegmentsAxis";
const OPERATING = `<xbrldi:explicitMember dimension="srt:ConsolidationItemsAxis">us-gaap:OperatingSegmentsMember</xbrldi:explicitMember>`;

function context(id: string, member: string, start: string, end: string, extra = OPERATING) {
  return `<xbrli:context id="${id}"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0000002488</xbrli:identifier><xbrli:segment>${extra}<xbrldi:explicitMember dimension="${AXIS}">${member}</xbrldi:explicitMember></xbrli:segment></xbrli:entity><xbrli:period><xbrli:startDate>${start}</xbrli:startDate><xbrli:endDate>${end}</xbrli:endDate></xbrli:period></xbrli:context>`;
}

function fact(name: string, contextRef: string, text: string, attrs = "", unitRef = "usd") {
  return `<ix:nonFraction unitRef="${unitRef}" contextRef="${contextRef}" decimals="-6" name="${name}" format="ixt:num-dot-decimal" scale="6"${attrs}>${text}</ix:nonFraction>`;
}

const REVENUE = "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax";
const OI = "us-gaap:OperatingIncomeLoss";
const UNITS = `<xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit><xbrli:unit id="eur"><xbrli:measure>iso4217:EUR</xbrli:measure></xbrli:unit>`;

// Excerpt of AMD 10-Q for the quarter ended 2026-06-27, accession 0000002488-26-000123
// (contexts c-63 and the prior-year c-64, facts f-* as filed).
const AMD_10Q = [
  UNITS,
  context("c-63", "amd:DataCenterMember", "2026-03-29", "2026-06-27"),
  context("c-64", "amd:DataCenterMember", "2025-03-30", "2025-06-28"),
  context(
    "c-90",
    "amd:AllOtherMember",
    "2026-03-29",
    "2026-06-27",
    `<xbrldi:explicitMember dimension="srt:ConsolidationItemsAxis">us-gaap:SegmentReconcilingItemsMember</xbrldi:explicitMember>`,
  ),
  fact(REVENUE, "c-63", "6,718"),
  fact(OI, "c-63", "2,103"),
  fact(OI, "c-63", "2,103"),
  fact(REVENUE, "c-64", "3,240"),
  `<ix:nonFraction unitRef="usd" contextRef="c-64" decimals="-6" sign="-" name="${OI}" scale="6">155</ix:nonFraction>`,
  `<ix:nonFraction unitRef="usd" contextRef="c-90" decimals="-6" sign="-" name="${OI}" scale="6">1,500</ix:nonFraction>`,
].join("");

function filingItem(metrics: Record<string, number | string>): ExtendedEvidenceItem {
  return {
    category: "sec-edgar",
    title: "AMD SEC 10-Q",
    summary: "10-Q filed 2026-08-05 for period 2026-06-27.",
    sourceIds: ["extended-sec-edgar-amd-10q"],
    observedAt: "2026-10-25T09:35:03.509Z",
    metrics: {
      form: "10-Q",
      filingDate: "2026-08-05",
      reportDate: "2026-06-27",
      accessionNumber: "0000002488-26-000123",
      ...metrics,
    },
  };
}

function metric(item: ExtendedEvidenceItem, id: string) {
  return segmentResultsSection("amd", [item])?.section?.metrics.find(
    (row) => row.id === `amd_DataCenterMember-2026-03-29-2026-06-27-${id}`,
  );
}

function byId<T extends { id: string }>(rows: readonly T[] | undefined, id: string) {
  return rows?.find((entry) => entry.id === id);
}

describe("SEC segment facts", () => {
  test("reads AMD Data Center Q2 FY2026 segment revenue and operating income", () => {
    const facts = secSegmentFactMetrics(AMD_10Q, "2026-06-27");
    expect(facts).toEqual({
      "segment|amd:DataCenterMember|revenue|2026-03-29|2026-06-27": 6_718_000_000,
      "segment|amd:DataCenterMember|revenue|2026-03-29|2026-06-27|concept": REVENUE,
      "segment|amd:DataCenterMember|operatingIncome|2026-03-29|2026-06-27": 2_103_000_000,
      "segment|amd:DataCenterMember|operatingIncome|2026-03-29|2026-06-27|concept": OI,
      "segment|amd:DataCenterMember|revenue|2025-03-30|2025-06-28": 3_240_000_000,
      "segment|amd:DataCenterMember|revenue|2025-03-30|2025-06-28|concept": REVENUE,
      "segment|amd:DataCenterMember|operatingIncome|2025-03-30|2025-06-28": -155_000_000,
      "segment|amd:DataCenterMember|operatingIncome|2025-03-30|2025-06-28|concept": OI,
      segmentUnit: "iso4217:USD",
    });
    const margin = metric(filingItem(facts), "margin");
    expect(margin?.status).toBe("value");
    expect(margin?.value).toBeCloseTo(2103 / 6718, 10);
    expect(margin?.periodEnd).toBe("2026-06-27");
    expect(margin?.periodMonths).toBe(3);
    expect(margin?.label).toBe("Data Center segment operating margin");
    expect(margin?.basis).toContain("ASC 280, not GAAP consolidated");
    expect(margin?.basis).toContain("accession 0000002488-26-000123");
    expect(margin?.basis).toContain(`revenue tagged as ${REVENUE}`);
    expect(margin?.sourceIds).toEqual(["extended-sec-edgar-amd-10q"]);
    expect(margin?.inputs.map((row) => [row.periodStart, row.periodEnd, row.currency])).toEqual([
      ["2026-03-29", "2026-06-27", "USD"],
      ["2026-03-29", "2026-06-27", "USD"],
    ]);
    expect(metric(filingItem(facts), "revenue")).toMatchObject({
      status: "value",
      value: 6_718_000_000,
      currency: "USD",
    });
  });

  test("keeps negative signs and drops conflicting duplicate facts", () => {
    const html = [
      UNITS,
      context("c-1", "amd:EmbeddedMember", "2026-03-29", "2026-06-27"),
      `<ix:nonFraction unitRef="usd" contextRef="c-1" name="${OI}" scale="6" sign="-">12</ix:nonFraction>`,
      fact(REVENUE, "c-1", "800"),
      fact(REVENUE, "c-1", "801"),
    ].join("");
    expect(secSegmentFactMetrics(html, "2026-06-27")).toEqual({
      "segment|amd:EmbeddedMember|operatingIncome|2026-03-29|2026-06-27": -12_000_000,
      "segment|amd:EmbeddedMember|operatingIncome|2026-03-29|2026-06-27|concept": OI,
      segmentUnit: "iso4217:USD",
    });
  });

  test("a filing without segment facts declares a Source Gap", () => {
    expect(secSegmentFactMetrics("<html>no facts</html>", "2026-06-27")).toEqual({});
    const result = segmentResultsSection("amd", [filingItem({})]);
    expect(result?.section).toBeUndefined();
    expect(result?.sourceGaps.map(({ source, message }) => [source, message])).toEqual([
      [
        "segment-results",
        "No ASC 280 segment revenue or operating income facts were read from the SEC 10-Q for AMD (filed 2026-08-05); segment margins are not computed",
      ],
    ]);
  });

  test("no periodic filing leaves the section undefined", () => {
    expect(segmentResultsSection("amd", [])).toBeUndefined();
  });

  test("mixed units withhold every row with a gap", () => {
    const html = [
      UNITS,
      context("c-1", "amd:DataCenterMember", "2026-03-29", "2026-06-27"),
      fact(REVENUE, "c-1", "6,718"),
      fact(OI, "c-1", "2,103", "", "eur"),
    ].join("");
    const item = filingItem(secSegmentFactMetrics(html, "2026-06-27"));
    const result = segmentResultsSection("amd", [item]);
    expect(result?.section?.metrics.map(({ status }) => status)).toEqual([
      "missing",
      "missing",
      "missing",
    ]);
    expect(metric(item, "margin")?.reason).toBe("segment facts are not in one currency (mixed)");
    expect(metric(item, "margin")?.inputs).toHaveLength(2);
    expect(result?.sourceGaps.map(({ source }) => source)).toEqual(["segment-results"]);
  });

  test("zero segment revenue is not meaningful and a missing measure keeps its row", () => {
    const html = [
      UNITS,
      context("c-1", "amd:DataCenterMember", "2026-03-29", "2026-06-27"),
      context("c-2", "amd:EmbeddedMember", "2026-03-29", "2026-06-27"),
      `<ix:nonFraction unitRef="usd" contextRef="c-1" name="${REVENUE}" format="ixt:fixed-zero" scale="6">—</ix:nonFraction>`,
      fact(OI, "c-1", "5"),
      fact(REVENUE, "c-2", "900"),
    ].join("");
    const item = filingItem(secSegmentFactMetrics(html, "2026-06-27"));
    expect(metric(item, "margin")).toMatchObject({
      status: "not-meaningful",
      reason: "segment revenue is zero or negative",
    });
    const embedded = segmentResultsSection("amd", [item])?.section?.metrics.find(
      ({ id }) => id === "amd_EmbeddedMember-2026-03-29-2026-06-27-margin",
    );
    expect(embedded).toMatchObject({
      status: "missing",
      sourceIds: ["extended-sec-edgar-amd-10q"],
    });
  });

  test("a nil self-closing fact never takes the next fact's text", () => {
    const html = [
      UNITS,
      context("c-1", "amd:DataCenterMember", "2026-03-29", "2026-06-27"),
      `<ix:nonFraction unitRef="usd" contextRef="c-1" name="${REVENUE}" scale="6" xsi:nil="true"/>`,
      fact(OI, "c-1", "2,103"),
    ].join("");
    const facts = secSegmentFactMetrics(html, "2026-06-27");
    expect(facts).not.toHaveProperty("segment|amd:DataCenterMember|revenue|2026-03-29|2026-06-27");
    expect(facts["segment|amd:DataCenterMember|operatingIncome|2026-03-29|2026-06-27"]).toBe(
      2_103_000_000,
    );
  });

  test("excludes other dimensions and non-segment members", () => {
    const html = [
      UNITS,
      context(
        "c-1",
        "amd:DataCenterMember",
        "2026-03-29",
        "2026-06-27",
        `${OPERATING}<xbrldi:explicitMember dimension="srt:ProductOrServiceAxis">amd:GpuMember</xbrldi:explicitMember>`,
      ),
      context("c-2", "us-gaap:AllOtherSegmentsMember", "2026-03-29", "2026-06-27"),
      fact(REVENUE, "c-1", "100"),
      fact(REVENUE, "c-2", "200"),
    ].join("");
    expect(secSegmentFactMetrics(html, "2026-06-27")).toEqual({});
  });

  test("reads comma-decimal formats and skips unknown formats", () => {
    const html = [
      UNITS,
      context("c-1", "amd:DataCenterMember", "2026-03-29", "2026-06-27"),
      `<ix:nonFraction unitRef="usd" contextRef="c-1" name="${REVENUE}" format="ixt:num-comma-decimal" scale="6">6.718,5</ix:nonFraction>`,
      `<ix:nonFraction unitRef="usd" contextRef="c-1" name="${OI}" format="ixt-sec:numwordsen" scale="6">two</ix:nonFraction>`,
    ].join("");
    expect(secSegmentFactMetrics(html, "2026-06-27")).toEqual({
      "segment|amd:DataCenterMember|revenue|2026-03-29|2026-06-27": 6_718_500_000,
      "segment|amd:DataCenterMember|revenue|2026-03-29|2026-06-27|concept": REVENUE,
      segmentUnit: "iso4217:USD",
    });
  });

  test("projects every periodic filing, not only the newest", () => {
    const annual = secSegmentFactMetrics(
      [
        UNITS,
        context("c-1", "amd:DataCenterMember", "2024-12-29", "2025-12-27"),
        fact(REVENUE, "c-1", "16,635"),
        fact(OI, "c-1", "3,598"),
      ].join(""),
      "2025-12-27",
    );
    const tenK: ExtendedEvidenceItem = {
      ...filingItem(annual),
      sourceIds: ["extended-sec-edgar-amd-10k"],
      metrics: {
        ...annual,
        form: "10-K",
        filingDate: "2026-02-04",
        reportDate: "2025-12-27",
        accessionNumber: "0000002488-26-000018",
      },
    };
    const tenQ = filingItem(secSegmentFactMetrics(AMD_10Q, "2026-06-27"));
    const metrics = segmentResultsSection("amd", [tenK, tenQ])?.section?.metrics ?? [];
    expect(
      metrics.find(({ id }) => id === "amd_DataCenterMember-2024-12-29-2025-12-27-margin"),
    ).toMatchObject({
      status: "value",
      periodMonths: 12,
      sourceIds: ["extended-sec-edgar-amd-10k"],
    });
    expect(metric(tenQ, "margin")?.sourceIds).toEqual(["extended-sec-edgar-amd-10q"]);
    expect(
      metrics.some(({ id }) => id === "amd_DataCenterMember-2026-03-29-2026-06-27-margin"),
    ).toBe(true);
  });

  // AMD 10-K FY2025 (0000002488-26-000018) tags amd:DatacenterMember; 10-Q Q2 2026 tags amd:DataCenterMember.
  test("a renamed member QName keeps separate rows and declares the gap", () => {
    const annual = secSegmentFactMetrics(
      [
        UNITS,
        context("c-1", "amd:DatacenterMember", "2024-12-29", "2025-12-27"),
        fact(REVENUE, "c-1", "16,635"),
        fact(OI, "c-1", "3,603"),
      ].join(""),
      "2025-12-27",
    );
    const tenK: ExtendedEvidenceItem = {
      ...filingItem(annual),
      metrics: { ...annual, form: "10-K", filingDate: "2026-02-04", reportDate: "2025-12-27" },
    };
    const tenQ = filingItem(secSegmentFactMetrics(AMD_10Q, "2026-06-27"));
    const result = segmentResultsSection("amd", [tenK, tenQ]);
    expect(
      result?.section?.metrics.map(({ label }) => label).filter((l) => l.endsWith(" revenue")),
    ).toEqual([
      "Data Center segment revenue",
      "Data Center segment revenue",
      "Datacenter segment revenue",
    ]);
    expect(result?.sourceGaps).toMatchObject([
      {
        message:
          "Segment members amd:DataCenterMember (10-Q filed 2026-08-05) and amd:DatacenterMember (10-K filed 2026-02-04) share a label; segment continuity across these QNames is unverified, so rows remain separate",
        cause: "suppressed-by-design",
        triage: "diagnostic",
      },
    ]);
    expect(segmentResultsSection("amd", [tenQ])?.sourceGaps).toEqual([]);
    const conflicting = secSegmentFactMetrics(
      [
        UNITS,
        context("c-9", "amd:DataCenterSegmentMember", "2026-03-29", "2026-06-27"),
        fact(REVENUE, "c-9", "1"),
      ].join(""),
      "2026-06-27",
    );
    const third = { ...tenQ, metrics: { ...tenQ.metrics, ...conflicting } };
    expect(
      segmentResultsSection("amd", [tenK, third])
        ?.sourceGaps.filter(({ cause }) => cause === "suppressed-by-design")
        .map(({ message }) => message.split(" share")[0]),
    ).toEqual([
      "Segment members amd:DataCenterMember (10-Q filed 2026-08-05) and amd:DatacenterMember (10-K filed 2026-02-04)",
      "Segment members amd:DataCenterSegmentMember (10-Q filed 2026-08-05) and amd:DatacenterMember (10-K filed 2026-02-04)",
    ]);
  });

  test("a 20-F declares the gap without ASC 280 wording", () => {
    const result = segmentResultsSection("nbis", [
      { ...filingItem({}), metrics: { form: "20-F", filingDate: "2026-04-30" } },
    ]);
    expect(result?.sourceGaps[0]?.message).toBe(
      "Segment facts are read only from 10-K/10-Q inline XBRL, so the SEC 20-F for NBIS (filed 2026-04-30) yields no segment revenue, operating income or margins",
    );
  });

  test("members sharing a label keep separate rows", () => {
    const html = [
      UNITS,
      context("c-1", "amd:DataCenterMember", "2026-03-29", "2026-06-27"),
      context("c-2", "amd:DataCenterSegmentMember", "2026-03-29", "2026-06-27"),
      fact(REVENUE, "c-1", "100"),
      fact(REVENUE, "c-2", "200"),
    ].join("");
    const metrics =
      segmentResultsSection("amd", [filingItem(secSegmentFactMetrics(html, "2026-06-27"))])?.section
        ?.metrics ?? [];
    expect(metrics.filter(({ id }) => id.endsWith("-revenue")).map(({ value }) => value)).toEqual([
      100_000_000, 200_000_000,
    ]);
    expect(metrics[0]?.basis).toContain("for member amd:DataCenterMember");
    expect(
      segmentResultsSection("amd", [
        filingItem(secSegmentFactMetrics(html, "2026-06-27")),
      ])?.sourceGaps.filter(({ cause }) => cause === "suppressed-by-design"),
    ).toEqual([]);
  });

  test("non-Latin labels group by their letters", () => {
    const html = [
      UNITS,
      context("c-1", "x:北Member", "2026-03-29", "2026-06-27"),
      context("c-2", "x:南Member", "2025-03-30", "2025-06-28"),
      context("c-3", "x:北SegmentMember", "2025-03-30", "2025-06-28"),
      fact(REVENUE, "c-1", "100"),
      fact(REVENUE, "c-2", "200"),
      fact(REVENUE, "c-3", "300"),
    ].join("");
    expect(
      segmentResultsSection("amd", [filingItem(secSegmentFactMetrics(html, "2026-06-27"))])
        ?.sourceGaps.filter(({ cause }) => cause === "suppressed-by-design")
        .map(({ message }) => message.split(" share")[0]),
    ).toEqual([
      "Segment members x:北Member (10-Q filed 2026-08-05) and x:北SegmentMember (10-Q filed 2026-08-05)",
    ]);
  });

  test("accepts any ixt namespace version prefix", () => {
    const html = [
      UNITS,
      context("c-1", "amd:DataCenterMember", "2026-03-29", "2026-06-27"),
      `<ix:nonFraction unitRef="usd" contextRef="c-1" name="${REVENUE}" format="ixt4:num-dot-decimal" scale="6">6,718</ix:nonFraction>`,
    ].join("");
    expect(
      secSegmentFactMetrics(html, "2026-06-27")[
        "segment|amd:DataCenterMember|revenue|2026-03-29|2026-06-27"
      ],
    ).toBe(6_718_000_000);
  });

  describe("prior-year comparatives", () => {
    const tenKItem = (metrics: Record<string, number | string>): ExtendedEvidenceItem => ({
      ...filingItem(metrics),
      sourceIds: ["extended-sec-edgar-amd-10k"],
      metrics: {
        ...metrics,
        form: "10-K",
        filingDate: "2026-02-04",
        reportDate: "2025-12-27",
        accessionNumber: "0000002488-26-000018",
      },
    });

    test("pins AMD Data Center Q2 2025 comparative and the YoY margin change from one 10-Q", () => {
      const item = filingItem(secSegmentFactMetrics(AMD_10Q, "2026-06-27"));
      const metrics = segmentResultsSection("amd", [item])?.section?.metrics;
      const prior = "amd_DataCenterMember-2025-03-30-2025-06-28";
      expect(byId(metrics, `${prior}-revenue`)).toMatchObject({ value: 3_240_000_000 });
      expect(byId(metrics, `${prior}-operating-income`)).toMatchObject({ value: -155_000_000 });
      expect(byId(metrics, `${prior}-margin`)?.basis).toContain("accession 0000002488-26-000123");
      const change = metric(item, "margin-yoy-change");
      expect(change?.status).toBe("value");
      expect(change?.value).toBeCloseTo((2103 / 6718 + 155 / 3240) * 100, 10);
      expect(change?.value).toBeCloseTo(36.09, 2);
      expect(change?.label).toContain("percentage points");
      expect(change?.basis).toContain(
        "2025-03-30 to 2025-06-28, both from 10-Q filed 2026-08-05, accession 0000002488-26-000123",
      );
      expect(byId(metrics, `${prior}-margin-yoy-change`)).toBeUndefined();
    });

    test("never compares different period lengths", () => {
      const html = [
        UNITS,
        context("c-1", "amd:DataCenterMember", "2026-03-29", "2026-06-27"),
        context("c-2", "amd:DataCenterMember", "2024-12-29", "2025-06-28"),
        fact(REVENUE, "c-1", "6,718"),
        fact(OI, "c-1", "2,103"),
        fact(REVENUE, "c-2", "6,914"),
        fact(OI, "c-2", "777"),
      ].join("");
      const ids =
        segmentResultsSection("amd", [
          filingItem(secSegmentFactMetrics(html, "2026-06-27")),
        ])?.section?.metrics.map(({ id }) => id) ?? [];
      expect(ids.some((id) => id.endsWith("-margin-yoy-change"))).toBe(false);
    });

    test("a comparative without a margin keeps the change row as missing", () => {
      const html = [
        UNITS,
        context("c-1", "amd:DataCenterMember", "2026-03-29", "2026-06-27"),
        context("c-2", "amd:DataCenterMember", "2025-03-30", "2025-06-28"),
        fact(REVENUE, "c-1", "6,718"),
        fact(OI, "c-1", "2,103"),
        fact(REVENUE, "c-2", "3,240"),
      ].join("");
      const item = filingItem(secSegmentFactMetrics(html, "2026-06-27"));
      expect(metric(item, "margin-yoy-change")).toMatchObject({ status: "missing" });
    });

    test("ignores periods after the report date", () => {
      const html = [
        UNITS,
        context("c-1", "amd:DataCenterMember", "2026-06-28", "2026-09-26"),
        fact(REVENUE, "c-1", "7,000"),
      ].join("");
      expect(secSegmentFactMetrics(html, "2026-06-27")).toEqual({});
    });

    test("a period restated in a newer filing keeps only the newest filing's rows", () => {
      const fy = (revenue: string) =>
        [
          UNITS,
          context("c-1", "amd:DataCenterMember", "2024-12-29", "2025-12-27"),
          fact(REVENUE, "c-1", revenue),
          fact(OI, "c-1", "3,603"),
        ].join("");
      const older = tenKItem(secSegmentFactMetrics(fy("16,635"), "2025-12-27"));
      const newer: ExtendedEvidenceItem = {
        ...tenKItem(secSegmentFactMetrics(fy("16,700"), "2026-12-26")),
        sourceIds: ["extended-sec-edgar-amd-10k-2027"],
      };
      newer.metrics!.reportDate = "2026-12-26";
      newer.metrics!.accessionNumber = "0000002488-27-000010";
      const metrics = segmentResultsSection("amd", [older, newer])?.section?.metrics ?? [];
      const ids = metrics.map(({ id }) => id);
      expect(new Set(ids).size).toBe(ids.length);
      const revenue = byId(metrics, "amd_DataCenterMember-2024-12-29-2025-12-27-revenue");
      expect(revenue).toMatchObject({
        value: 16_700_000_000,
        sourceIds: ["extended-sec-edgar-amd-10k-2027"],
      });
      expect((revenue as { basis: string } | undefined)?.basis).toContain(
        "accession 0000002488-27-000010",
      );
    });

    test("a zero-revenue comparative makes the change row not meaningful", () => {
      const html = [
        UNITS,
        context("c-1", "amd:DataCenterMember", "2026-03-29", "2026-06-27"),
        context("c-2", "amd:DataCenterMember", "2025-03-30", "2025-06-28"),
        fact(REVENUE, "c-1", "6,718"),
        fact(OI, "c-1", "2,103"),
        `<ix:nonFraction unitRef="usd" contextRef="c-2" name="${REVENUE}" format="ixt:fixed-zero" scale="6">—</ix:nonFraction>`,
        fact(OI, "c-2", "5"),
      ].join("");
      const item = filingItem(secSegmentFactMetrics(html, "2026-06-27"));
      expect(metric(item, "margin-yoy-change")).toMatchObject({
        status: "not-meaningful",
        reason: "segment revenue is zero or negative in this period or its prior-year comparative",
      });
    });

    test("pairs a 53-week fiscal year with the 52-week year before it", () => {
      const html = [
        UNITS,
        context("c-1", "amd:DataCenterMember", "2023-12-31", "2025-01-04"),
        context("c-2", "amd:DataCenterMember", "2023-01-01", "2023-12-30"),
        fact(REVENUE, "c-1", "1,000"),
        fact(OI, "c-1", "300"),
        fact(REVENUE, "c-2", "1,000"),
        fact(OI, "c-2", "200"),
      ].join("");
      const item = tenKItem(secSegmentFactMetrics(html, "2025-01-04"));
      item.metrics!.reportDate = "2025-01-04";
      const change = byId(
        segmentResultsSection("amd", [item])?.section?.metrics,
        "amd_DataCenterMember-2023-12-31-2025-01-04-margin-yoy-change",
      );
      expect(change?.value).toBeCloseTo(10, 10);
    });

    test("a change row is suppressed when a newer 10-Q won its prior-year leg", () => {
      const quarter = (id: string, start: string, end: string, revenue: string, oi: string) => [
        context(id, "amd:DataCenterMember", start, end),
        fact(REVENUE, id, revenue),
        `<ix:nonFraction unitRef="usd" contextRef="${id}" name="${OI}" scale="6" sign="-">${oi}</ix:nonFraction>`,
      ];
      const older = filingItem(
        secSegmentFactMetrics(
          [
            UNITS,
            ...quarter("c-1", "2025-03-30", "2025-06-28", "3,000", "300"),
            ...quarter("c-2", "2024-03-31", "2024-06-29", "2,800", "100"),
          ].join(""),
          "2025-06-28",
        ),
      );
      older.metrics!.reportDate = "2025-06-28";
      older.metrics!.filingDate = "2025-08-06";
      older.metrics!.accessionNumber = "0000002488-25-000100";
      const newer = filingItem(
        secSegmentFactMetrics(
          [
            UNITS,
            ...quarter("c-3", "2025-12-28", "2026-03-28", "5,000", "1"),
            ...quarter("c-4", "2025-03-30", "2025-06-28", "3,240", "155"),
          ].join(""),
          "2026-03-28",
        ),
      );
      newer.metrics!.reportDate = "2026-03-28";
      const metrics = segmentResultsSection("amd", [older, newer])?.section?.metrics;
      const q2 = "amd_DataCenterMember-2025-03-30-2025-06-28";
      expect(byId(metrics, `${q2}-revenue`)?.value).toBe(3_240_000_000);
      expect(byId(metrics, `${q2}-margin-yoy-change`)).toBeUndefined();
      expect(byId(metrics, "amd_DataCenterMember-2024-03-31-2024-06-29-margin")?.basis).toContain(
        "accession 0000002488-25-000100",
      );
    });
  });
});
