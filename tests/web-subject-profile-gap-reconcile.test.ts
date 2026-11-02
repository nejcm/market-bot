import { describe, expect, test } from "bun:test";
import { projectExtendedEvidenceReportExtras } from "../src/research/extended-evidence-projections";
import type { MetricSection } from "../src/sources/extended-evidence/metric-engine";
import type {
  WebSubjectProfileArtifact,
  WebSubjectProfileOpenGap,
} from "../src/web-evidence/contract";
import { collectedSources } from "./support/fixtures";

const answer = { answer: "Sells devices.", sourceIds: ["web-1"] };

function artifact(openGaps: readonly WebSubjectProfileOpenGap[]): WebSubjectProfileArtifact {
  return {
    version: 3,
    generatedAt: "2026-05-01T00:00:00.000Z",
    subjectKind: "company",
    subjectId: "ORCL",
    symbol: "ORCL",
    subjectSummary: answer,
    questions: {},
    recentMaterialEvents: [],
    factLedger: [{ claim: "Sells devices.", sourceIds: ["web-1"] }],
    openGaps,
    sourceIds: ["web-1"],
  } as unknown as WebSubjectProfileArtifact;
}

function section(
  id: string,
  title: string,
  metrics: readonly {
    id: string;
    status: string;
    periodEnd?: string;
    periodMonths?: number;
    value?: number;
  }[],
): MetricSection {
  return {
    id,
    title,
    metrics: metrics.map((metric) => ({
      ...metric,
      label: metric.id,
      unit: "percent",
      basis: "",
      inputs: [],
      sourceIds: [],
    })),
  } as unknown as MetricSection;
}

function reconciled(
  gaps: readonly WebSubjectProfileOpenGap[],
  metricSections?: readonly MetricSection[],
) {
  const extras = projectExtendedEvidenceReportExtras({
    modelExtras: {},
    collectedSources: collectedSources({
      webSubjectProfile: artifact(gaps),
      ...(metricSections !== undefined ? { metricSections } : {}),
    }),
  });
  return (extras.webSubjectProfile as { reconciledGaps?: unknown }).reconciledGaps;
}

const segments = section("segment-results", "Segment results per ASC 280", [
  { id: "cloud-q-revenue", status: "value", periodEnd: "2026-08-31", periodMonths: 3, value: 100 },
  { id: "cloud-q-operating-income", status: "value", periodEnd: "2026-08-31", periodMonths: 3 },
]);
const capitalReturn = section("capital-return", "Capital Return", [
  { id: "dividendsLatestFy", status: "value", periodEnd: "2026-05-31" },
  { id: "dpsCagr5y", status: "value", periodEnd: "2026-05-31" },
]);
const business = section("business", "Business", [
  { id: "revenue", status: "value", periodEnd: "2026-08-31", periodMonths: 3, value: 100.5 },
  { id: "revenue", status: "value", periodEnd: "2026-08-31", periodMonths: 6, value: 210 },
  { id: "fyRevenue", status: "value", periodEnd: "2026-05-31", periodMonths: 12 },
]);
const segmentGap = { text: "No segment results.", topic: "segment-results" } as const;

describe("Web Subject Profile gap reconciliation", () => {
  test("reconciles segment and dividend gaps whose coverage is proven", () => {
    expect(
      reconciled(
        [
          { text: "No regional split.", topic: "geographic-revenue" },
          segmentGap,
          { text: "No dividend history.", topic: "dividend-history" },
          { text: "No analyst estimates.", topic: "analyst-estimates" },
          { text: "Legacy gap.", topic: "other" },
        ],
        [segments, capitalReturn, business],
      ),
    ).toEqual([
      { text: "No segment results.", topic: "segment-results", metricId: "cloud-q-revenue" },
      { text: "No dividend history.", topic: "dividend-history", metricId: "dpsCagr5y" },
    ]);
  });

  test("never reconciles geographic gaps, whose member overlap code cannot prove", () => {
    const shares = section("geographic-revenue", "Revenue by geography", [
      {
        id: "americas-share",
        status: "value",
        periodEnd: "2026-08-31",
        periodMonths: 3,
        value: 0.6,
      },
      { id: "us-share", status: "value", periodEnd: "2026-08-31", periodMonths: 3, value: 0.4 },
    ]);
    expect(
      reconciled([{ text: "No regional split.", topic: "geographic-revenue" }], [shares, business]),
    ).toBeUndefined();
  });

  test("reconciles a YTD segment group at the same period end as the quarter", () => {
    const ytd = section("segment-results", "Segments", [
      { id: "a-q-revenue", status: "value", periodEnd: "2026-08-31", periodMonths: 3, value: 50 },
      { id: "a-q-operating-income", status: "value", periodEnd: "2026-08-31", periodMonths: 3 },
      {
        id: "a-ytd-revenue",
        status: "value",
        periodEnd: "2026-08-31",
        periodMonths: 6,
        value: 120,
      },
      { id: "a-ytd-operating-income", status: "value", periodEnd: "2026-08-31", periodMonths: 6 },
      { id: "b-ytd-revenue", status: "value", periodEnd: "2026-08-31", periodMonths: 6, value: 90 },
      { id: "b-ytd-operating-income", status: "value", periodEnd: "2026-08-31", periodMonths: 6 },
    ]);
    expect(reconciled([segmentGap], [ytd, business])).toEqual([
      { text: "No segment results.", topic: "segment-results", metricId: "a-ytd-revenue" },
    ]);
  });

  test("keeps a segment gap when a newest-period row has no duration", () => {
    const undated = section("segment-results", "Segments", [
      {
        id: "cloud-q-revenue",
        status: "value",
        periodEnd: "2026-08-31",
        periodMonths: 3,
        value: 100,
      },
      { id: "cloud-q-operating-income", status: "value", periodEnd: "2026-08-31", periodMonths: 3 },
      { id: "other-revenue", status: "missing", periodEnd: "2026-08-31" },
    ]);
    expect(reconciled([segmentGap], [undated, business])).toBeUndefined();
  });

  test("keeps a segment gap when tagged segments do not sum to total revenue", () => {
    const partial = section("segment-results", "Segments", [
      { id: "cloud-revenue", status: "value", periodEnd: "2026-08-31", periodMonths: 3, value: 60 },
      { id: "cloud-operating-income", status: "value", periodEnd: "2026-08-31", periodMonths: 3 },
    ]);
    expect(reconciled([segmentGap], [partial, business])).toBeUndefined();
    expect(reconciled([segmentGap], [partial])).toBeUndefined();
  });

  test("keeps a segment gap when only an older period is covered", () => {
    const fy = section("segment-results", "Segments", [
      { id: "c-revenue", status: "value", periodEnd: "2026-05-31", periodMonths: 12, value: 400 },
      { id: "c-operating-income", status: "value", periodEnd: "2026-05-31", periodMonths: 12 },
    ]);
    expect(reconciled([segmentGap], [fy, business])).toBeUndefined();
  });

  test("keeps a segment gap whose rows lack operating income", () => {
    const revenueOnly = section("segment-results", "Segments", [
      {
        id: "cloud-revenue",
        status: "value",
        periodEnd: "2026-08-31",
        periodMonths: 3,
        value: 100,
      },
    ]);
    expect(reconciled([segmentGap], [revenueOnly, business])).toBeUndefined();
  });

  test("keeps a dividend-history gap whose CAGR ends before the latest fiscal year", () => {
    const stale = section("capital-return", "Capital Return", [
      { id: "dpsCagr5y", status: "value", periodEnd: "2025-05-31" },
    ]);
    expect(
      reconciled([{ text: "No dividend history.", topic: "dividend-history" }], [stale, business]),
    ).toBeUndefined();
  });

  test("keeps a dividend-history gap backed only by one fiscal year of dividends", () => {
    const oneYear = section("capital-return", "Capital Return", [
      { id: "dividendsLatestFy", status: "value", periodEnd: "2026-05-31" },
      { id: "dpsCagr5y", status: "missing" },
    ]);
    expect(
      reconciled(
        [{ text: "No dividend history.", topic: "dividend-history" }],
        [oneYear, business],
      ),
    ).toBeUndefined();
  });

  test("keeps every gap when this run has no Metric Sections", () => {
    expect(reconciled([segmentGap])).toBeUndefined();
  });

  test("projects an unvalidated legacy sidecar's string gaps as text, never reconciled", () => {
    const extras = projectExtendedEvidenceReportExtras({
      modelExtras: {},
      collectedSources: collectedSources({
        webSubjectProfile: artifact(["No segment results."] as never),
        metricSections: [segments, business],
      }),
    });
    expect(extras.webSubjectProfile).toMatchObject({ openGaps: ["No segment results."] });
    expect(extras.webSubjectProfile).not.toHaveProperty("reconciledGaps");
  });

  test("declares an unreadable gap entry instead of dropping it", () => {
    const extras = projectExtendedEvidenceReportExtras({
      modelExtras: {},
      collectedSources: collectedSources({
        webSubjectProfile: artifact([{ topic: "other" }, "Kept."] as never),
      }),
    });
    expect(extras.webSubjectProfile).toMatchObject({
      openGaps: ["Web Subject Profile: 1 open-gap entry was unreadable and is not shown.", "Kept."],
    });
  });
});
