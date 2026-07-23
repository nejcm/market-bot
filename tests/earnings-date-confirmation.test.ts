import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Source } from "../src/domain/types";
import { applyEarningsForecastPolicy } from "../src/forecast/earnings-eligibility";
import { validateResearchReport } from "../src/report/schema";
import {
  applyOfficialEarningsDateConfirmation,
  assessOfficialExchangeDisclosureUrl,
  confirmEarningsDateFromOfficialSources,
  retainedEvidenceSpanForEarningsDate,
} from "../src/sources/extended-evidence/earnings-date-confirmation";
import type { EarningsSetupCollected, RawSourceSnapshot } from "../src/sources/types";
import { collectedSources, prediction, researchReport } from "./support/fixtures";

interface ConfirmationFixture {
  readonly analysisAsOf: string;
  readonly setup: EarningsSetupCollected;
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly sources: readonly Source[];
}

async function fixture(name: string): Promise<ConfirmationFixture> {
  const path = join(import.meta.dir, "fixtures", "earnings-date-certainty", `${name}.json`);
  return JSON.parse(await readFile(path, "utf8")) as ConfirmationFixture;
}

function secSource(form: "8-K" | "6-K", summary: string): Source {
  return {
    id: `sec-${form.toLowerCase()}`,
    title: `AAPL SEC ${form}`,
    url: `https://www.sec.gov/Archives/edgar/data/320193/example-${form.toLowerCase()}.htm`,
    fetchedAt: "2026-07-18T09:00:00.000Z",
    kind: "extended-evidence",
    assetClass: "equity",
    symbol: "AAPL",
    provider: "sec-edgar",
    summary,
    identity: {
      aliases: [{ provider: "sec-edgar", idKind: "ticker", value: "AAPL" }],
    },
  };
}

function exchangeSource(
  url = "https://www.nasdaq.com/press-release/apple-announces-date-for-third-quarter-results-2026-07-18",
): Source {
  return {
    id: "nasdaq-aapl-earnings",
    title: "Apple earnings date",
    url,
    fetchedAt: "2026-07-18T09:00:00.000Z",
    kind: "web",
    assetClass: "equity",
    symbol: "AAPL",
    provider: "exa",
    summary: "Apple Inc. will release its quarterly financial results on July 30, 2026.",
    identity: {
      aliases: [{ provider: "nasdaq", idKind: "ticker", value: "AAPL" }],
    },
  };
}

describe("official earnings-date confirmation", () => {
  test("confirms an exact future date from the issuer IR host and retains the evidence span", async () => {
    const input = await fixture("issuer-confirmed");
    const result = confirmEarningsDateFromOfficialSources(input);

    expect(result?.event.eventDateStatus).toBe("issuer-confirmed");
    expect(result?.event.dateStatus).toBeUndefined();
    expect(result?.event.dateConfirmation).toMatchObject({
      sourceId: "web-aapl-ir-earnings",
      sourceType: "issuer-ir-event",
      issuerIdentity: { symbol: "AAPL", matchedBy: "official-host" },
    });
    expect(result?.event.dateConfirmation?.evidenceSpan).toContain("July 30, 2026");
    expect(result?.event.sourceIds).toContain("web-aapl-ir-earnings");
    const gated = applyEarningsForecastPolicy({
      setup: result,
      predictions: [
        prediction({
          id: "confirmed-earnings-direction",
          kind: "earnings-direction",
          subject: "AAPL",
          measurableAs: "earningsReturn(AAPL, 2026-07-30, +1) > 0",
          horizonTradingDays: 1,
        }),
      ],
      policy: "confirmed-only",
    });
    expect(gated.predictions[0]?.eventDateStatus).toBe("issuer-confirmed");
    expect(gated.telemetry).toMatchObject({
      grammarEligible: true,
      eligiblePredictionCount: 1,
      suppressedPredictionCount: 0,
    });
  });

  test("applies confirmation to the collected-source bundle after official web gathering", async () => {
    const input = await fixture("issuer-confirmed");
    const result = applyOfficialEarningsDateConfirmation({
      collectedSources: collectedSources({
        rawSnapshots: input.rawSnapshots,
        extendedSources: input.sources,
        earningsSetup: input.setup,
      }),
      analysisAsOf: input.analysisAsOf,
    });

    expect(result.earningsSetup?.event.eventDateStatus).toBe("issuer-confirmed");
  });

  test.each(["8-K", "6-K"] as const)(
    "confirms an explicit future earnings date from SEC %s text",
    async (form) => {
      const input = await fixture("provider-estimated");
      const result = confirmEarningsDateFromOfficialSources({
        ...input,
        sources: [
          secSource(
            form,
            "Apple Inc. will release its quarterly financial results on July 30, 2026.",
          ),
        ],
      });

      expect(result?.event.eventDateStatus).toBe("issuer-confirmed");
      expect(result?.event.dateConfirmation?.sourceType).toBe(
        form === "8-K" ? "sec-8-k" : "sec-6-k",
      );
      expect(result?.event.dateConfirmation?.issuerIdentity.matchedBy).toBe("sec-ticker-alias");
    },
  );

  test("does not treat Item 2.02 past results as an upcoming-date source", async () => {
    const input = await fixture("provider-estimated");
    const result = confirmEarningsDateFromOfficialSources({
      ...input,
      sources: [
        secSource(
          "8-K",
          "Item 2.02. On July 30, 2026, Apple Inc. issued a release announcing financial results for the quarter ended June 30, 2026.",
        ),
      ],
    });

    expect(result?.event.eventDateStatus).toBe("provider-estimated");
    expect(result?.event.dateConfirmation).toBeUndefined();
  });

  test("does not promote Finnhub agreement or another non-official host", async () => {
    const input = await fixture("provider-estimated");
    const result = confirmEarningsDateFromOfficialSources(input);

    expect(result?.event.eventDateStatus).toBe("provider-estimated");
    expect(result?.event.dateConfirmation).toBeUndefined();
  });

  test("allows exchange confirmation only from a direct official exchange host", async () => {
    const input = await fixture("provider-estimated");
    const issuer = await fixture("issuer-confirmed");
    const officialExchangeSource = exchangeSource();
    const result = confirmEarningsDateFromOfficialSources({
      ...input,
      rawSnapshots: issuer.rawSnapshots,
      sources: [officialExchangeSource],
    });

    expect(result?.event.eventDateStatus).toBe("exchange-confirmed");
    expect(result?.event.dateConfirmation).toMatchObject({
      sourceId: "nasdaq-aapl-earnings",
      sourceType: "official-exchange",
      issuerIdentity: { symbol: "AAPL", matchedBy: "source-ticker-alias" },
    });
    expect(() =>
      validateResearchReport(
        researchReport({
          jobType: "equity",
          symbol: "AAPL",
          sources: [
            officialExchangeSource,
            {
              id: "extended-finnhub-events-aapl",
              title: "AAPL provider earnings estimate",
              fetchedAt: input.analysisAsOf,
              kind: "extended-evidence",
            },
          ],
          extras: { earningsSetup: result },
        }),
      ),
    ).not.toThrow();
  });

  test("rejects an exchange lookalike host", async () => {
    const input = await fixture("provider-estimated");
    const issuer = await fixture("issuer-confirmed");
    const result = confirmEarningsDateFromOfficialSources({
      ...input,
      rawSnapshots: issuer.rawSnapshots,
      sources: [
        exchangeSource(
          "https://events.nasdaq.example.com/press-release/apple-announces-results-date",
        ),
      ],
    });

    expect(result?.event.eventDateStatus).toBe("provider-estimated");
  });

  test.each([
    "https://www.nasdaq.com/market-activity/stocks/aapl/earnings",
    "https://www.nasdaq.com/earnings-calendar",
    "https://www.nasdaq.com/market-activity/stocks/aapl/quote",
    "https://www.londonstockexchange.com/stock/AAPL/apple-inc/company-page",
  ])("rejects exchange market-data or lookup URL %s", async (url) => {
    const input = await fixture("provider-estimated");
    const issuer = await fixture("issuer-confirmed");
    const result = confirmEarningsDateFromOfficialSources({
      ...input,
      rawSnapshots: issuer.rawSnapshots,
      sources: [exchangeSource(url)],
    });

    expect(result?.event.eventDateStatus).toBe("provider-estimated");
    expect(assessOfficialExchangeDisclosureUrl(url)).toEqual({
      eligible: false,
      reason: "exchange-market-data-path",
    });
  });

  test("requires issuer-name or symbol-context corroboration on exchange disclosures", async () => {
    const input = await fixture("provider-estimated");
    const source = {
      ...exchangeSource(),
      title: "ALL earnings date",
      symbol: "ALL",
      summary: "ALL will release quarterly financial results on July 30, 2026.",
    };
    const result = confirmEarningsDateFromOfficialSources({
      ...input,
      setup: { ...input.setup, event: { ...input.setup.event, symbol: "ALL" } },
      rawSnapshots: [],
      instrumentIdentity: { displayName: "Allstate" },
      sources: [source],
    });

    expect(result?.event.eventDateStatus).toBe("provider-estimated");
  });

  test("requires the exact date and future announcement language in one retained span", () => {
    expect(
      retainedEvidenceSpanForEarningsDate(
        "Apple reported quarterly results on July 30, 2026.",
        "2026-07-30",
      ),
    ).toBeUndefined();
    expect(
      retainedEvidenceSpanForEarningsDate(
        "Apple will report quarterly results on July 31, 2026.",
        "2026-07-30",
      ),
    ).toBeUndefined();
  });

  test("validates complete persisted confirmation provenance", async () => {
    const input = await fixture("issuer-confirmed");
    const setup = confirmEarningsDateFromOfficialSources(input);

    expect(() =>
      validateResearchReport(
        researchReport({
          jobType: "equity",
          symbol: "AAPL",
          sources: [
            ...input.sources,
            {
              id: "extended-finnhub-events-aapl",
              title: "AAPL provider earnings estimate",
              fetchedAt: input.analysisAsOf,
              kind: "extended-evidence",
            },
          ],
          extras: { earningsSetup: setup },
        }),
      ),
    ).not.toThrow();
  });
});
