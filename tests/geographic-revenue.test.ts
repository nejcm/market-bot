import { describe, expect, test } from "bun:test";
import type { ExtendedEvidenceItem } from "../src/domain/evidence";
import { geographicRevenueSection } from "../src/sources/extended-evidence/geographic-revenue";
import { secGeographyFactMetrics } from "../src/sources/sec-segment-facts";

const REVENUE = "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax";
const UNITS = `<xbrli:unit id="U_USD"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>`;

function context(id: string, member: string | undefined, start: string, end: string) {
  const segment =
    member === undefined
      ? ""
      : `<xbrli:segment><xbrldi:explicitMember dimension="srt:StatementGeographicalAxis">${member}</xbrldi:explicitMember></xbrli:segment>`;
  return `<xbrli:context id="${id}"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0000851310</xbrli:identifier>${segment}</xbrli:entity><xbrli:period><xbrli:startDate>${start}</xbrli:startDate><xbrli:endDate>${end}</xbrli:endDate></xbrli:period></xbrli:context>`;
}

function fact(contextRef: string, text: string, name = REVENUE) {
  return `<ix:nonFraction contextRef="${contextRef}" name="${name}" unitRef="U_USD" scale="3" decimals="-3" format="ixt:num-dot-decimal">${text}</ix:nonFraction>`;
}

// Harmonic Inc. 10-Q for the six months ended 2026-07-03, accession 0001193125-26-353891.
const HLIT_10Q = [
  UNITS,
  context("total", undefined, "2026-01-01", "2026-07-03"),
  context("americas", "srt:AmericasMember", "2026-01-01", "2026-07-03"),
  context("emea", "us-gaap:EMEAMember", "2026-01-01", "2026-07-03"),
  context("apac", "srt:AsiaPacificMember", "2026-01-01", "2026-07-03"),
  fact("total", "255,157"),
  fact("americas", "227,033"),
  fact("emea", "18,880"),
  fact("apac", "9,244"),
].join("");

function filingItem(metrics: Record<string, number | string>): ExtendedEvidenceItem {
  return {
    category: "sec-edgar",
    title: "HLIT SEC 10-Q",
    summary: "10-Q filed 2026-08-17 for period 2026-07-03.",
    sourceIds: ["extended-sec-edgar-hlit-10q"],
    observedAt: "2026-10-26T19:20:17.444Z",
    metrics: {
      form: "10-Q",
      filingDate: "2026-08-17",
      reportDate: "2026-07-03",
      accessionNumber: "0001193125-26-353891",
      ...metrics,
    },
  };
}

// Harmonic Inc. 10-K for fiscal 2025, accession 0001193125-26-067506 (MD&A net revenue by geography).
const HLIT_10K = [
  UNITS,
  context("fy25", undefined, "2025-01-01", "2025-12-31"),
  context("fy24", undefined, "2024-01-01", "2024-12-31"),
  context("fy23", undefined, "2023-01-01", "2023-12-31"),
  context("am25", "srt:AmericasMember", "2025-01-01", "2025-12-31"),
  context("em25", "us-gaap:EMEAMember", "2025-01-01", "2025-12-31"),
  context("ap25", "srt:AsiaPacificMember", "2025-01-01", "2025-12-31"),
  context("am24", "srt:AmericasMember", "2024-01-01", "2024-12-31"),
  context("am23", "srt:AmericasMember", "2023-01-01", "2023-12-31"),
  fact("fy25", "360,523"),
  fact("fy24", "488,200"),
  fact("fy23", "388,482"),
  fact("am25", "320,570"),
  fact("em25", "33,894"),
  fact("ap25", "6,059"),
  fact("am24", "449,346"),
  fact("am23", "335,154"),
].join("");

function hlit10K(
  metrics: Record<string, number | string> = secGeographyFactMetrics(HLIT_10K, "2025-12-31"),
): ExtendedEvidenceItem {
  const item = filingItem(metrics);
  return {
    ...item,
    sourceIds: ["extended-sec-edgar-hlit-10k"],
    metrics: {
      ...item.metrics,
      form: "10-K",
      filingDate: "2026-02-24",
      reportDate: "2025-12-31",
      accessionNumber: "0001193125-26-067506",
    },
  };
}

function share(html: string, member: string) {
  return geographicRevenueSection("hlit", [
    filingItem(secGeographyFactMetrics(html, "2026-07-03")),
  ])?.section?.metrics.find(({ id }) => id === `${member}-2026-01-01-2026-07-03-share`);
}

describe("geographic revenue section", () => {
  test("computes HLIT H1 2026 regional shares from the 10-Q's tagged revenue", () => {
    const americas = share(HLIT_10Q, "srt_AmericasMember");
    expect(americas).toMatchObject({
      status: "value",
      periodEnd: "2026-07-03",
      periodMonths: 6,
      sourceIds: ["extended-sec-edgar-hlit-10q"],
    });
    expect(americas?.status === "value" ? americas.value : undefined).toBeCloseTo(0.8898, 4);
    const emea = share(HLIT_10Q, "us-gaap_EMEAMember");
    expect(emea?.status === "value" ? emea.value : undefined).toBeCloseTo(0.074, 4);
    const apac = share(HLIT_10Q, "srt_AsiaPacificMember");
    expect(apac?.status === "value" ? apac.value : undefined).toBeCloseTo(0.0362, 4);
  });

  test("declares the share missing when total revenue is not tagged for the period", () => {
    const html = HLIT_10Q.replace(fact("total", "255,157"), "");
    expect(share(html, "srt_AmericasMember")).toMatchObject({
      status: "missing",
      reason: "total revenue is not tagged with the region's concept for this period",
    });
  });

  test("does not divide across revenue concepts", () => {
    const html = HLIT_10Q.replace(
      fact("total", "255,157"),
      fact("total", "260,000", "us-gaap:Revenues"),
    );
    expect(share(html, "srt_AmericasMember")).toMatchObject({ status: "missing" });
  });

  test("pairs a contract-revenue region with the contract-revenue total when both totals are tagged", () => {
    const html = HLIT_10Q + fact("total", "260,000", "us-gaap:Revenues");
    const americas = share(html, "srt_AmericasMember");
    expect(americas?.label).toBe("Americas share of revenue from contracts with customers");
    expect(americas?.status === "value" ? americas.value : undefined).toBeCloseTo(0.8898, 4);
  });

  test("declares the share missing when facts are in more than one currency", () => {
    const html = `<xbrli:unit id="U_EUR"><xbrli:measure>iso4217:EUR</xbrli:measure></xbrli:unit>${HLIT_10Q.replace(
      fact("apac", "9,244"),
      fact("apac", "9,244").replace("U_USD", "U_EUR"),
    )}`;
    expect(share(html, "srt_AmericasMember")).toMatchObject({ status: "missing" });
  });

  test("marks the share not meaningful when total revenue is zero", () => {
    const html = HLIT_10Q.replace(fact("total", "255,157"), fact("total", "0"));
    expect(share(html, "srt_AmericasMember")).toMatchObject({ status: "not-meaningful" });
  });

  test("shares overlapping US/Non-US and regional members against one consolidated total", () => {
    const html = [
      HLIT_10Q,
      context("us", "country:US", "2026-01-01", "2026-07-03"),
      context("nonus", "us-gaap:NonUsMember", "2026-01-01", "2026-07-03"),
      fact("us", "210,579"),
      fact("nonus", "44,578"),
    ].join("");
    const nonUs = share(html, "us-gaap_NonUsMember");
    expect(nonUs?.label).toBe("Non-US share of revenue");
    expect(nonUs?.status === "value" ? nonUs.value : undefined).toBeCloseTo(0.1747, 4);
    expect(share(html, "country_US")?.label).toBe("United States share of revenue");
    expect(share(html, "srt_AmericasMember")).toMatchObject({ status: "value" });
  });

  test("keeps a newest 10-K's fiscal year and its prior-year comparative only", () => {
    const metrics = geographicRevenueSection("hlit", [hlit10K()])?.section?.metrics;
    expect(metrics?.map(({ id }) => id)).toEqual([
      "srt_AmericasMember-2025-01-01-2025-12-31-revenue",
      "srt_AmericasMember-2025-01-01-2025-12-31-share",
      "us-gaap_EMEAMember-2025-01-01-2025-12-31-revenue",
      "us-gaap_EMEAMember-2025-01-01-2025-12-31-share",
      "srt_AsiaPacificMember-2025-01-01-2025-12-31-revenue",
      "srt_AsiaPacificMember-2025-01-01-2025-12-31-share",
      "srt_AmericasMember-2024-01-01-2024-12-31-revenue",
      "srt_AmericasMember-2024-01-01-2024-12-31-share",
    ]);
    expect(metrics?.[0]?.inputs[0]?.periodType).toBe("annual");
  });

  test("adds the older 10-K's fiscal years beside a newer 10-Q's year-to-date rows", () => {
    const result = geographicRevenueSection("hlit", [
      filingItem(secGeographyFactMetrics(HLIT_10Q, "2026-07-03")),
      hlit10K(),
    ]);
    const value = (id: string) => {
      const metric = result?.section?.metrics.find((row) => row.id === id);
      return metric?.status === "value" ? metric.value : undefined;
    };
    expect(value("srt_AmericasMember-2026-01-01-2026-07-03-share")).toBeCloseTo(0.8898, 4);
    expect(value("srt_AmericasMember-2025-01-01-2025-12-31-share")).toBeCloseTo(0.8892, 4);
    expect(value("us-gaap_EMEAMember-2025-01-01-2025-12-31-share")).toBeCloseTo(0.094, 4);
    expect(value("srt_AsiaPacificMember-2025-01-01-2025-12-31-share")).toBeCloseTo(0.0168, 4);
    expect(
      result?.section?.metrics.find(
        ({ id }) => id === "srt_AmericasMember-2025-01-01-2025-12-31-share",
      )?.basis,
    ).toContain("10-K filed 2026-02-24, accession 0001193125-26-067506");
    expect(result?.sourceGaps).toEqual([]);
  });

  test("declares a gap for an older 10-K without geography facts", () => {
    const result = geographicRevenueSection("hlit", [
      filingItem(secGeographyFactMetrics(HLIT_10Q, "2026-07-03")),
      hlit10K({}),
    ]);
    expect(result?.section?.metrics.some(({ id }) => id.includes("2025-12-31"))).toBe(false);
    expect(result?.sourceGaps.map(({ message }) => message)).toEqual([
      "No revenue facts by geography were read from the SEC 10-K for HLIT (filed 2026-02-24); geographic revenue shares are not computed",
    ]);
  });

  test("selects the latest period when no context ends on the report date", () => {
    const metrics = geographicRevenueSection("hlit", [
      { ...hlit10K(), metrics: { ...hlit10K().metrics, reportDate: "2026-01-02" } },
    ])?.section?.metrics;
    expect(metrics?.[0]?.id).toBe("srt_AmericasMember-2025-01-01-2025-12-31-revenue");
  });

  test("declares a gap for a periodic filing without geography facts", () => {
    const result = geographicRevenueSection("hlit", [filingItem({})]);
    expect(result?.section).toBeUndefined();
    expect(result?.sourceGaps.map(({ source }) => source)).toEqual(["geographic-revenue"]);
  });

  test("is undefined when no periodic filing was collected", () => {
    expect(geographicRevenueSection("hlit", [])).toBeUndefined();
  });

  test("reads no geography metrics from a filing with only a consolidated total", () => {
    expect(
      secGeographyFactMetrics(
        UNITS + context("total", undefined, "2026-01-01", "2026-07-03") + fact("total", "255,157"),
        "2026-07-03",
      ),
    ).toEqual({});
  });
});
