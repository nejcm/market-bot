import { describe, expect, test } from "bun:test";
import type { ExtendedEvidenceItem } from "../src/domain/evidence";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import {
  DA_CASH_FLOW_FACT_PREFIX,
  secDepreciationSiblingMetrics,
} from "../src/sources/sec-segment-facts";

type Column = readonly [start: string, end: string, value: number];
interface Filing {
  readonly accn: string;
  readonly form: "10-K" | "10-Q";
  readonly filed: string;
  readonly concepts: Readonly<Record<string, readonly Column[]>>;
}

const LTRX_FY2026: Filing = {
  accn: "0001683168-26-006754",
  form: "10-K",
  filed: "2026-09-10",
  concepts: {
    DepreciationDepletionAndAmortization: [
      ["2025-07-01", "2026-06-30", 1_602_000],
      ["2024-07-01", "2025-06-30", 2_084_000],
    ],
    AmortizationOfIntangibleAssets: [
      ["2025-07-01", "2026-06-30", 1_561_000],
      ["2024-07-01", "2025-06-30", 3_951_000],
    ],
  },
};
const GPN_Q1_2026: Filing = {
  accn: "0001123360-26-000072",
  form: "10-Q",
  filed: "2026-05-05",
  concepts: {
    DepreciationDepletionAndAmortization: [
      ["2026-01-01", "2026-03-31", 864_757_000],
      ["2025-01-01", "2025-03-31", 292_587_000],
    ],
    AmortizationOfIntangibleAssets: [
      ["2026-01-01", "2026-03-31", 747_157_000],
      ["2025-01-01", "2025-03-31", 329_269_000],
    ],
    Depreciation: [
      ["2026-01-01", "2026-03-31", 117_600_000],
      ["2025-01-01", "2025-03-31", 122_839_000],
    ],
  },
};
const AVNW_Q2_FY2026: Filing = {
  accn: "0001628280-26-005015",
  form: "10-Q",
  filed: "2026-02-04",
  concepts: {
    DepreciationDepletionAndAmortization: [
      ["2025-09-27", "2025-12-26", 900_000],
      ["2025-06-28", "2025-12-26", 1_393_000],
      ["2024-09-28", "2024-12-27", 1_500_000],
      ["2024-06-29", "2024-12-27", 2_790_000],
    ],
    AmortizationOfIntangibleAssets: [
      ["2025-09-27", "2025-12-26", 700_000],
      ["2025-06-28", "2025-12-26", 1_429_000],
      ["2024-06-29", "2024-12-27", 1_315_000],
    ],
  },
};
const RIOT_FY2018: Filing = {
  accn: "0001079973-19-000197",
  form: "10-K",
  filed: "2019-04-02",
  concepts: {
    DepreciationDepletionAndAmortization: [
      ["2018-01-01", "2018-12-31", 5_267_372],
      ["2017-01-01", "2017-12-31", 890_889],
    ],
    Depreciation: [
      ["2018-01-01", "2018-12-31", 5_200_000],
      ["2017-01-01", "2017-12-31", 900_000],
    ],
    AmortizationOfIntangibleAssets: [
      ["2018-01-01", "2018-12-31", 61_904],
      ["2017-01-01", "2017-12-31", 68_000],
    ],
  },
};

function derive(filings: readonly Filing[], parsed: readonly ExtendedEvidenceItem[] = []) {
  const concepts: Record<string, { units: { USD: Record<string, unknown>[] } }> = {};
  for (const filing of filings) {
    for (const [concept, columns] of Object.entries({
      ...filing.concepts,
      Revenues: filing.concepts.DepreciationDepletionAndAmortization!.map(
        ([start, end]) => [start, end, 1e9] as const,
      ),
    })) {
      concepts[concept] ??= { units: { USD: [] } };
      for (const [start, end, val] of columns) {
        concepts[concept].units.USD.push({
          start,
          end,
          val,
          accn: filing.accn,
          fy: Number(filing.filed.slice(0, 4)),
          fp: filing.form === "10-K" ? "FY" : "Q2",
          form: filing.form,
          filed: filing.filed,
        });
      }
    }
  }
  const statements = deriveFinancialStatements(
    { facts: { "us-gaap": concepts } },
    {
      symbol: "TEST",
      generatedAt: "2027-12-31T00:00:00.000Z",
      analysisAsOf: "2027-12-31T00:00:00.000Z",
      sourceId: "sec",
      secFilings: parsed,
    },
  );
  const series = statements.statements.cashFlowStatement.depreciationAndAmortization;
  return {
    value: (start: string, end: string) =>
      [...series.annual, ...series.interim].find(
        (fact) => fact.periodStart === start && fact.periodEnd === end,
      )?.value,
    note: (end: string) =>
      statements.omissionNotes.find(
        (note) => note.seriesKey === "depreciationAndAmortization" && note.periodKey?.includes(end),
      )?.message,
  };
}

function parsedDocument(
  accn: string,
  lines: Readonly<Record<string, 0 | 1>>,
): ExtendedEvidenceItem {
  return {
    metrics: {
      accessionNumber: accn,
      ...Object.fromEntries(
        Object.entries(lines).map(([key, value]) => [`${DA_CASH_FLOW_FACT_PREFIX}${key}`, value]),
      ),
    },
  } as unknown as ExtendedEvidenceItem;
}

const LTRX_FY2026_LINE = "DepreciationDepletionAndAmortization|2025-07-01|2026-06-30";
const CHKP_FY2022: Filing = {
  accn: "0001178913-25-000867",
  form: "10-K",
  filed: "2025-03-20",
  concepts: {
    DepreciationDepletionAndAmortization: [
      ["2024-01-01", "2024-12-31", 24_000_000],
      ["2023-01-01", "2023-12-31", 23_100_000],
      ["2022-01-01", "2022-12-31", 22_700_000],
    ],
    AmortizationOfIntangibleAssets: [
      ["2024-01-01", "2024-12-31", 59_600_000],
      ["2023-01-01", "2023-12-31", 24_300_000],
      ["2022-01-01", "2022-12-31", 13_500_000],
    ],
  },
};
const GPN_FY2025: Filing = {
  accn: "0001123360-26-000008",
  form: "10-K",
  filed: "2026-02-20",
  concepts: {
    DepreciationDepletionAndAmortization: [
      ["2025-01-01", "2025-12-31", 1_229_208_000],
      ["2024-01-01", "2024-12-31", 1_217_288_000],
    ],
    AmortizationOfIntangibleAssets: [
      ["2025-01-01", "2025-12-31", 996_540_000],
      ["2024-01-01", "2024-12-31", 1_369_328_000],
    ],
    Depreciation: [
      ["2025-01-01", "2025-12-31", 418_837_000],
      ["2024-01-01", "2024-12-31", 493_003_000],
    ],
  },
};
const ANET_Q3_2025: Filing = {
  accn: "0001596532-25-000286",
  form: "10-Q",
  filed: "2025-11-04",
  concepts: {
    DepreciationDepletionAndAmortization: [
      ["2025-01-01", "2025-09-30", 49_800_000],
      ["2024-01-01", "2024-09-30", 46_700_000],
    ],
    AmortizationOfIntangibleAssets: [["2025-01-01", "2025-09-30", 186_200_000]],
    Depreciation: [
      ["2025-01-01", "2025-09-30", 23_200_000],
      ["2024-01-01", "2024-09-30", 25_600_000],
    ],
  },
};

const strip = (filing: Filing, concept: string): Filing => ({
  ...filing,
  concepts: Object.fromEntries(Object.entries(filing.concepts).filter(([key]) => key !== concept)),
});

describe("combined D&A tagged as a sibling cash-flow line", () => {
  test("LTRX FY2026 is withheld from its own filing's FY2025 column without a parsed statement", () => {
    const result = derive([LTRX_FY2026]);
    expect(result.value("2025-07-01", "2026-06-30")).toBeUndefined();
    expect(result.note("2026-06-30")).toContain("no parsed cash-flow statement");
  });

  test("LTRX FY2026 is withheld from the parsed 10-K cash-flow statement", () => {
    const result = derive(
      [LTRX_FY2026],
      [parsedDocument(LTRX_FY2026.accn, { [LTRX_FY2026_LINE]: 1 })],
    );
    expect(result.value("2025-07-01", "2026-06-30")).toBeUndefined();
    expect(result.note("2026-06-30")).toContain("beside a separate AmortizationOfIntangibleAssets");
  });

  test("an unverified parse (split table, DDA not found) falls back and keeps LTRX withheld", () => {
    expect(
      derive([LTRX_FY2026], [parsedDocument(LTRX_FY2026.accn, {})]).value(
        "2025-07-01",
        "2026-06-30",
      ),
    ).toBeUndefined();
  });

  test("a sibling flag stays on its own filing and does not suppress a later corrected total", () => {
    const corrected: Filing = {
      accn: "0001683168-27-000001",
      form: "10-K",
      filed: "2027-09-10",
      concepts: { DepreciationDepletionAndAmortization: [["2025-07-01", "2026-06-30", 3_163_000]] },
    };
    expect(
      derive(
        [LTRX_FY2026, corrected],
        [parsedDocument(LTRX_FY2026.accn, { [LTRX_FY2026_LINE]: 1 })],
      ).value("2025-07-01", "2026-06-30"),
    ).toBe(3_163_000);
  });

  test("a later filing re-reporting FY2025 does not revive LTRX FY2026", () => {
    const later: Filing = {
      accn: "0001683168-27-000001",
      form: "10-K",
      filed: "2027-09-10",
      concepts: {
        DepreciationDepletionAndAmortization: [["2024-07-01", "2025-06-30", 2_084_000]],
        AmortizationOfIntangibleAssets: [["2024-07-01", "2025-06-30", 3_951_000]],
      },
    };
    expect(derive([LTRX_FY2026, later]).value("2025-07-01", "2026-06-30")).toBeUndefined();
  });

  test("a disproof in another filing does not reach the period's filing", () => {
    const current: Filing = {
      ...LTRX_FY2026,
      concepts: {
        DepreciationDepletionAndAmortization: [["2025-07-01", "2026-06-30", 1_602_000]],
        AmortizationOfIntangibleAssets: [["2025-07-01", "2026-06-30", 1_561_000]],
      },
    };
    const prior: Filing = {
      accn: "0001683168-25-006532",
      form: "10-K",
      filed: "2025-09-10",
      concepts: {
        DepreciationDepletionAndAmortization: [["2024-07-01", "2025-06-30", 2_084_000]],
        AmortizationOfIntangibleAssets: [["2024-07-01", "2025-06-30", 3_951_000]],
      },
    };
    expect(derive([current, prior]).value("2025-07-01", "2026-06-30")).toBe(1_602_000);
  });

  test("AVNW interim D&A is withheld across its 10-Q columns", () => {
    const result = derive([AVNW_Q2_FY2026]);
    expect(result.value("2025-09-27", "2025-12-26")).toBeUndefined();
    expect(result.note("2025-12-26")).toContain(AVNW_Q2_FY2026.accn);
  });

  test("CHKP FY2022 depreciation-only DDA 22.7M is withheld", () => {
    const result = derive([CHKP_FY2022]);
    expect(result.value("2022-01-01", "2022-12-31")).toBeUndefined();
    expect(result.note("2022-12-31")).toContain(CHKP_FY2022.accn);
  });

  test.each([
    {
      name: "GPN Q1 2026 10-Q",
      filing: GPN_Q1_2026,
      start: "2026-01-01",
      end: "2026-03-31",
      value: 864_757_000,
    },
    {
      name: "GPN FY2025 10-K",
      filing: GPN_FY2025,
      start: "2025-01-01",
      end: "2025-12-31",
      value: 1_229_208_000,
    },
    {
      name: "ANET 2024 9M 10-Q",
      filing: ANET_Q3_2025,
      start: "2024-01-01",
      end: "2024-09-30",
      value: 46_700_000,
    },
    {
      name: "RIOT FY2018 10-K",
      filing: RIOT_FY2018,
      start: "2018-01-01",
      end: "2018-12-31",
      value: 5_267_372,
    },
  ])(
    "$name is kept: DDA above same-column depreciation already carries amortization",
    ({ filing, start, end, value }) => {
      expect(derive([filing]).value(start, end)).toBe(value);
    },
  );

  test("GPN Q1 2026 without Depreciation is withheld by the fallback but kept by a verified 10-Q line", () => {
    const stripped = strip(GPN_Q1_2026, "Depreciation");
    expect(derive([stripped]).value("2026-01-01", "2026-03-31")).toBeUndefined();
    expect(
      derive(
        [stripped],
        [
          parsedDocument(GPN_Q1_2026.accn, {
            "DepreciationDepletionAndAmortization|2026-01-01|2026-03-31": 0,
          }),
        ],
      ).value("2026-01-01", "2026-03-31"),
    ).toBe(864_757_000);
  });
});

const context = (id: string, start: string, end: string) =>
  `<xbrli:context id="${id}"><xbrli:entity></xbrli:entity><xbrli:period><xbrli:startDate>${start}</xbrli:startDate><xbrli:endDate>${end}</xbrli:endDate></xbrli:period></xbrli:context>`;
const fact = (name: string, value: string) =>
  `<td><ix:nonFraction name="us-gaap:${name}" contextRef="c1" unitRef="usd">${value}</ix:nonFraction></td>`;
const CONTEXTS = context("c1", "2025-07-01", "2026-06-30");
const OCF = fact("NetCashProvidedByUsedInOperatingActivities", "9,877");

describe("secDepreciationSiblingMetrics", () => {
  test("flags DDA beside intangible amortization in the operating cash-flow table", () => {
    const html = `${CONTEXTS}<table>${fact("AmortizationOfIntangibleAssets", "1,561")}${fact("DepreciationDepletionAndAmortization", "1,602")}${OCF}</table>`;
    expect(secDepreciationSiblingMetrics(html, "2026-06-30")).toEqual({
      [`${DA_CASH_FLOW_FACT_PREFIX}${LTRX_FY2026_LINE}`]: 1,
    });
  });

  test("verifies a total line when amortization sits in a separate note table", () => {
    const html = `${CONTEXTS}<table>${fact("DepreciationDepletionAndAmortization", "3,163")}${OCF}</table><table>${fact("AmortizationOfIntangibleAssets", "1,561")}</table>`;
    expect(secDepreciationSiblingMetrics(html, "2026-06-30")).toEqual({
      [`${DA_CASH_FLOW_FACT_PREFIX}${LTRX_FY2026_LINE}`]: 0,
    });
  });

  test("verifies nothing when DDA sits outside the operating cash-flow table", () => {
    const html = `${CONTEXTS}<table>${fact("DepreciationDepletionAndAmortization", "1,602")}</table><table>${OCF}</table>`;
    expect(secDepreciationSiblingMetrics(html, "2026-06-30")).toEqual({});
  });
});
