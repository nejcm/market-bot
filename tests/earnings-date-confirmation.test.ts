import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Source } from "../src/domain/sources";
import { applyEarningsForecastPolicy } from "../src/forecast/earnings-eligibility";
import { renderEarningsSetup } from "../src/report/markdown-profile-sections";
import { validateResearchReport } from "../src/report/schema";
import { projectExtendedEvidenceReportExtras } from "../src/research/extended-evidence-projections";
import {
  applyEarningsDateConflict,
  applyOfficialEarningsDateConfirmation,
  assessOfficialExchangeDisclosureUrl,
  confirmEarningsDateFromOfficialSources,
  findEarningsDateConflict,
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
    expect(result?.event.confirmedBy).toEqual({
      sourceId: "web-aapl-ir-earnings",
      sourceType: "issuer-ir-event",
    });
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

  test("retains the future-announcement verb for AP-style dotted months", () => {
    const amdSnippet =
      "SANTA CLARA, Calif., Oct. 6, 2026 -- AMD (NASDAQ: AMD) will report fiscal third quarter 2026 financial results on Tuesday, Nov. 3, 2026, after the market close.";

    expect(retainedEvidenceSpanForEarningsDate(amdSnippet, "2026-11-03")).toBe(
      "6, 2026 -- AMD (NASDAQ: AMD) will report fiscal third quarter 2026 financial results on Tuesday, Nov. 3, 2026, after the market close.",
    );
    expect(retainedEvidenceSpanForEarningsDate(amdSnippet, "2026-11-04")).toBeUndefined();
    expect(
      retainedEvidenceSpanForEarningsDate(
        "AMD reported fiscal third quarter 2026 financial results on Nov. 3, 2026.",
        "2026-11-03",
      ),
    ).toBeUndefined();
    expect(retainedEvidenceSpanForEarningsDate("", "2026-11-03")).toBeUndefined();
  });

  test("confirms a dotted-month date from the issuer host only while it is upcoming", async () => {
    const input = await fixture("issuer-confirmed");
    const [source] = input.sources;
    if (source === undefined) {
      throw new Error("expected an issuer source");
    }
    const dotted = {
      ...source,
      summary:
        "Apple Inc. will release its quarterly financial results on Thursday, Jul. 30, 2026.",
    };

    expect(
      confirmEarningsDateFromOfficialSources({ ...input, sources: [dotted] })?.event
        .dateConfirmation?.evidenceSpan,
    ).toContain("Jul. 30, 2026");
    expect(
      confirmEarningsDateFromOfficialSources({
        ...input,
        analysisAsOf: "2026-07-31T12:00:00.000Z",
        sources: [dotted],
      })?.event.eventDateStatus,
    ).toBe("provider-estimated");
    const { summary: _summary, ...withoutText } = dotted;
    expect(
      confirmEarningsDateFromOfficialSources({ ...input, sources: [withoutText] })?.event
        .eventDateStatus,
    ).toBe("provider-estimated");
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

  test("rejects a confirmed event without matching confirmedBy provenance", async () => {
    const input = await fixture("issuer-confirmed");
    const setup = confirmEarningsDateFromOfficialSources(input);
    if (setup === undefined) {
      throw new Error("expected a confirmed setup");
    }
    const { confirmedBy: _confirmedBy, ...event } = setup.event;

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
          extras: { earningsSetup: { ...setup, event } },
        }),
      ),
    ).toThrow("Confirmed Earnings Setup requires matching confirmedBy provenance");
  });

  test("accepts accurate negations with a conflicting date recorded", async () => {
    const input = await fixture("provider-estimated");

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
          catalysts: [
            {
              text: "Neither earnings date is issuer-confirmed.",
              sourceIds: ["finnhub-agreement"],
            },
          ],
          extras: {
            earningsSetup: {
              ...input.setup,
              event: {
                ...input.setup.event,
                dateConflict: { date: "2026-08-05", sourceId: "finnhub-agreement" },
              },
            },
          },
        }),
      ),
    ).not.toThrow();
  });

  test("rejects a date conflict that cites the event date or an unknown source", async () => {
    const input = await fixture("provider-estimated");
    const withConflict = (dateConflict: Record<string, unknown>) =>
      validateResearchReport(
        researchReport({
          jobType: "equity",
          symbol: "AAPL",
          sources: input.sources,
          extras: {
            earningsSetup: { ...input.setup, event: { ...input.setup.event, dateConflict } },
          },
        }),
      );

    expect(() => withConflict({ date: "2026-07-30", sourceId: "finnhub-agreement" })).toThrow(
      "Earnings Setup dateConflict must cite a known source and a different date",
    );
    expect(() => withConflict({ date: "2026-08-05", sourceId: "missing-source" })).toThrow(
      "Earnings Setup dateConflict must cite a known source and a different date",
    );
  });
});

function announcementSource(overrides: Partial<Source> = {}): Source {
  return {
    id: "news-aapl-results-date",
    title: "Apple Announces Date of Third Quarter 2026 Financial Results",
    url: "https://finnhub.io/api/news?id=example",
    publisher: "Yahoo",
    fetchedAt: "2026-07-18T20:15:00.000Z",
    kind: "news",
    assetClass: "equity",
    provider: "finnhub",
    summary:
      "CUPERTINO, July 18, 2026--Apple Inc. (NASDAQ: AAPL) today announced that it will report its financial results for the third quarter ended June 30, 2026 after the U.S. market closes on Thursday, August 5, 2026.",
    ...overrides,
  };
}

function netSource(summary: string, title = "Cloudflare quarterly results"): Source {
  return {
    id: "news-net-results-date",
    title,
    url: "https://finnhub.io/api/news?id=example",
    fetchedAt: "2026-10-13T20:15:00.000Z",
    kind: "news",
    assetClass: "equity",
    provider: "finnhub",
    summary,
  };
}

describe("provider-versus-source earnings-date conflicts", () => {
  test("keeps both dates and declares a conflict gap when a source announces a different future date", async () => {
    const identity = await fixture("issuer-confirmed");
    const provider = await fixture("provider-estimated");
    const source = announcementSource();
    const conflict = findEarningsDateConflict({
      setup: provider.setup,
      sources: [source],
      rawSnapshots: identity.rawSnapshots,
      analysisAsOf: provider.analysisAsOf,
    });

    expect(conflict).toEqual({ date: "2026-08-05", sourceId: "news-aapl-results-date" });

    const result = applyEarningsDateConflict({
      collectedSources: collectedSources({
        rawSnapshots: identity.rawSnapshots,
        newsSources: [source],
        earningsSetup: provider.setup,
      }),
      analysisAsOf: provider.analysisAsOf,
    });

    expect(result.earningsSetup?.event.dateConflict).toEqual({
      date: "2026-08-05",
      sourceId: "news-aapl-results-date",
    });
    expect(result.sourceGaps).toContainEqual(
      expect.objectContaining({
        source: "earnings-setup",
        symbol: "AAPL",
        message:
          "Earnings date conflict for AAPL: the Earnings Setup date 2026-07-30 differs from the earnings date 2026-08-05 announced by source news-aapl-results-date",
      }),
    );
  });

  test("reads ISO-formatted announcement dates", async () => {
    const identity = await fixture("issuer-confirmed");
    const provider = await fixture("provider-estimated");
    const conflict = findEarningsDateConflict({
      setup: provider.setup,
      sources: [
        announcementSource({
          summary:
            "Apple Inc. will report its quarterly financial results on 2026-08-05 after the market close.",
        }),
      ],
      rawSnapshots: identity.rawSnapshots,
      analysisAsOf: provider.analysisAsOf,
    });

    expect(conflict?.date).toBe("2026-08-05");
  });

  test("keeps no conflict when the source announces the same date", async () => {
    const identity = await fixture("issuer-confirmed");
    const provider = await fixture("provider-estimated");
    const sameDate = announcementSource({
      summary:
        "CUPERTINO, July 18, 2026--Apple Inc. (NASDAQ: AAPL) today announced that it will report its financial results for the third quarter on Thursday, July 30, 2026.",
    });

    expect(
      findEarningsDateConflict({
        setup: provider.setup,
        sources: [sameDate, ...provider.sources],
        rawSnapshots: identity.rawSnapshots,
        analysisAsOf: provider.analysisAsOf,
      }),
    ).toBeUndefined();
  });

  test("keeps no conflict without a source announcement", async () => {
    const identity = await fixture("issuer-confirmed");
    const provider = await fixture("provider-estimated");

    expect(
      findEarningsDateConflict({
        setup: provider.setup,
        sources: [],
        rawSnapshots: identity.rawSnapshots,
        analysisAsOf: provider.analysisAsOf,
      }),
    ).toBeUndefined();
  });

  test("keeps no conflict without an earnings setup and leaves collected sources untouched", () => {
    const sources = collectedSources();

    expect(
      findEarningsDateConflict({
        setup: undefined,
        sources: [announcementSource()],
        rawSnapshots: [],
        analysisAsOf: "2026-07-20T12:00:00.000Z",
      }),
    ).toBeUndefined();
    expect(
      applyEarningsDateConflict({
        collectedSources: sources,
        analysisAsOf: "2026-07-20T12:00:00.000Z",
      }),
    ).toBe(sources);
  });

  test("ignores announcements from other issuers and non-announcement futures", async () => {
    const identity = await fixture("issuer-confirmed");
    const provider = await fixture("provider-estimated");
    const foreign = announcementSource({
      id: "news-zs-results-date",
      title: "Zscaler Announces Date of Fourth Quarter 2026 Financial Results",
      symbol: "ZS",
      summary:
        "Zscaler, Inc. (NASDAQ: ZS) today announced that it will report its fourth quarter financial results on Thursday, August 5, 2026.",
    });
    const conference = announcementSource({
      id: "news-aapl-conference",
      summary: "Apple Inc. will attend the August 5, 2026 technology conference.",
    });

    expect(
      findEarningsDateConflict({
        setup: provider.setup,
        sources: [foreign, conference],
        rawSnapshots: identity.rawSnapshots,
        analysisAsOf: provider.analysisAsOf,
      }),
    ).toBeUndefined();
  });

  test("ignores an announced date that is no longer upcoming", async () => {
    const identity = await fixture("issuer-confirmed");
    const provider = await fixture("provider-estimated");
    const past = announcementSource({
      summary:
        "Apple Inc. will report its quarterly financial results on July 1, 2026 after the market close.",
    });

    expect(
      findEarningsDateConflict({
        setup: provider.setup,
        sources: [past],
        rawSnapshots: identity.rawSnapshots,
        analysisAsOf: provider.analysisAsOf,
      }),
    ).toBeUndefined();
  });

  test("ignores a period-end date in the announcement sentence", async () => {
    const identity = await fixture("issuer-confirmed");
    const provider = await fixture("provider-estimated");
    const quarterEnd = announcementSource({
      summary:
        "Apple Inc. will report financial results for the quarter ending July 25, 2026 on Thursday, July 30, 2026.",
    });

    expect(
      findEarningsDateConflict({
        setup: provider.setup,
        sources: [quarterEnd],
        rawSnapshots: identity.rawSnapshots,
        analysisAsOf: provider.analysisAsOf,
      }),
    ).toBeUndefined();
  });

  test("ignores the following quarter's announced date", async () => {
    const identity = await fixture("issuer-confirmed");
    const provider = await fixture("provider-estimated");
    const twoQuarters = announcementSource({
      summary:
        "Apple Inc. will report its third quarter financial results on Thursday, July 30, 2026 and its fourth quarter financial results on Thursday, November 5, 2026.",
    });

    expect(
      findEarningsDateConflict({
        setup: provider.setup,
        sources: [twoQuarters],
        rawSnapshots: identity.rawSnapshots,
        analysisAsOf: provider.analysisAsOf,
      }),
    ).toBeUndefined();
  });

  test("rejects an announcement span that names another issuer", async () => {
    const identity = await fixture("issuer-confirmed");
    const provider = await fixture("provider-estimated");
    const otherIssuer = announcementSource({
      summary:
        "Apple shares rose today. Microsoft will report quarterly financial results on August 5, 2026.",
    });

    expect(
      findEarningsDateConflict({
        setup: provider.setup,
        sources: [otherIssuer],
        rawSnapshots: identity.rawSnapshots,
        analysisAsOf: provider.analysisAsOf,
      }),
    ).toBeUndefined();
  });

  test.each(["on August 5 2026", "on August 5th, 2026", "on 5 Aug 2026", "on August 05, 2026"])(
    "reads the date format %s",
    async (announcement) => {
      const identity = await fixture("issuer-confirmed");
      const provider = await fixture("provider-estimated");
      const conflict = findEarningsDateConflict({
        setup: provider.setup,
        sources: [
          announcementSource({
            summary: `Apple Inc. will report its quarterly financial results ${announcement}.`,
          }),
        ],
        rawSnapshots: identity.rawSnapshots,
        analysisAsOf: provider.analysisAsOf,
      });

      expect(conflict?.date).toBe("2026-08-05");
    },
  );

  test("keeps a same-day announcement that has not elapsed", async () => {
    const identity = await fixture("issuer-confirmed");
    const provider = await fixture("provider-estimated");
    const sameDay = announcementSource({
      summary:
        "Apple Inc. today announced that it will report its financial results after the U.S. market close on Monday, July 20, 2026.",
    });

    expect(
      findEarningsDateConflict({
        setup: provider.setup,
        sources: [sameDay],
        rawSnapshots: identity.rawSnapshots,
        analysisAsOf: provider.analysisAsOf,
      }),
    ).toEqual({ date: "2026-07-20", sourceId: "news-aapl-results-date" });
  });

  test("detects the NET-shaped republication announcement", async () => {
    const provider = await fixture("provider-estimated");
    const netSetup: EarningsSetupCollected = {
      ...provider.setup,
      event: {
        ...provider.setup.event,
        symbol: "NET",
        date: "2026-10-29",
        sourceIds: ["extended-finnhub-events-net"],
        fetchedAt: "2026-10-14T08:30:49.704Z",
      },
    };
    const press: Source = {
      id: "news-equity-6",
      title: "Cloudflare Announces Date of Third Quarter 2026 Financial Results",
      url: "https://finnhub.io/api/news?id=bcd66fef",
      publisher: "Yahoo",
      fetchedAt: "2026-10-13T20:15:00.000Z",
      kind: "news",
      assetClass: "equity",
      provider: "finnhub",
      summary:
        "SAN FRANCISCO, October 13, 2026--Cloudflare, Inc. (NYSE: NET), the leading connectivity cloud company, today announced that it will report its financial results for the third quarter ended September 30, 2026 after the U.S. market closes on Thursday, November 5, 2026.",
    };

    expect(
      findEarningsDateConflict({
        setup: netSetup,
        sources: [press],
        rawSnapshots: [],
        instrumentIdentity: { displayName: "Cloudflare, Inc." },
        analysisAsOf: "2026-10-14T08:30:49.704Z",
      }),
    ).toEqual({ date: "2026-11-05", sourceId: "news-equity-6" });
  });

  test("reads a later date occurrence when an earlier same-date mention fails the anchor", async () => {
    const identity = await fixture("issuer-confirmed");
    const provider = await fixture("provider-estimated");
    const titled = announcementSource({ title: "Key dates to watch: August 5, 2026" });
    const datelined = announcementSource({
      summary:
        "CUPERTINO, August 5, 2026--Apple Inc. will report its quarterly financial results after the market close on Wednesday, August 5, 2026.",
    });

    for (const source of [titled, datelined]) {
      expect(
        findEarningsDateConflict({
          setup: provider.setup,
          sources: [source],
          rawSnapshots: identity.rawSnapshots,
          analysisAsOf: provider.analysisAsOf,
        }),
      ).toEqual({ date: "2026-08-05", sourceId: "news-aapl-results-date" });
    }
  });

  test.each([
    "Apple Inc. will report its quarterly financial results, scheduled for August 5, 2026.",
    "Apple Inc. will report its quarterly financial results on Wednesday August 5, 2026.",
  ])("reads the reporting construction %s", async (summary) => {
    const identity = await fixture("issuer-confirmed");
    const provider = await fixture("provider-estimated");

    expect(
      findEarningsDateConflict({
        setup: provider.setup,
        sources: [announcementSource({ summary })],
        rawSnapshots: identity.rawSnapshots,
        analysisAsOf: provider.analysisAsOf,
      }),
    ).toEqual({ date: "2026-08-05", sourceId: "news-aapl-results-date" });
  });

  test("reads a scheduled-for construction without another future phrase", async () => {
    const identity = await fixture("issuer-confirmed");
    const provider = await fixture("provider-estimated");

    expect(
      findEarningsDateConflict({
        setup: provider.setup,
        sources: [
          announcementSource({
            summary:
              "Apple Inc. announced that its quarterly financial results are scheduled for August 5, 2026.",
          }),
        ],
        rawSnapshots: identity.rawSnapshots,
        analysisAsOf: provider.analysisAsOf,
      }),
    ).toEqual({ date: "2026-08-05", sourceId: "news-aapl-results-date" });
  });

  test("does not record a conflict from a source that agrees on the event date", async () => {
    const provider = await fixture("provider-estimated");
    const meliSetup: EarningsSetupCollected = {
      ...provider.setup,
      event: {
        ...provider.setup.event,
        symbol: "MELI",
        date: "2026-11-04",
        sourceIds: ["extended-finnhub-events-meli"],
        fetchedAt: "2026-10-14T17:16:05.054Z",
      },
    };
    const marketBeat: Source = {
      id: "web-meli-6eb9809c",
      title: "MercadoLibre Q3 2026 Earnings Date and Estimates",
      url: "https://www.marketbeat.com/earnings/reports/2026-11-4-mercadolibre-inc-stock/",
      fetchedAt: "2026-10-14T17:16:05.054Z",
      kind: "web",
      assetClass: "equity",
      provider: "exa",
      summary:
        "MercadoLibre (MELI) Q3 2026 earnings overview: - Earnings date: Wednesday, November 4, 2026 (after market close). - Conference call: Wednesday, October 28, 2026 at 5:00 PM ET. - Expected results: earnings per share (EPS) ~ $9.27; revenue ~ $10.63 billion.",
      snippet:
        "MercadoLibre is estimated to report Q3 2026 earnings on Wednesday, November 4, 2026, after market closes. This date is estimated from past reporting schedules and may change once the company confirms it. ... MercadoLibre's Q3 2026 earnings conference call is scheduled for Wednesday, October 28, 2026 at 5:00 PM ET. MarketBeat streams the conference call audio and posts the transcript as soon as possible on the earnings announcement date.",
    };

    expect(
      findEarningsDateConflict({
        setup: meliSetup,
        sources: [marketBeat],
        rawSnapshots: [],
        instrumentIdentity: { displayName: "MercadoLibre, Inc." },
        analysisAsOf: "2026-10-14T17:16:05.054Z",
      }),
    ).toBeUndefined();
  });

  test("ignores a conference-call date when the source does not report the event date", async () => {
    const provider = await fixture("provider-estimated");
    const meliSetup: EarningsSetupCollected = {
      ...provider.setup,
      event: {
        ...provider.setup.event,
        symbol: "MELI",
        date: "2026-11-04",
        sourceIds: ["extended-finnhub-events-meli"],
        fetchedAt: "2026-10-14T17:16:05.054Z",
      },
    };
    const callOnly: Source = {
      id: "web-meli-call-date",
      title: "MercadoLibre Q3 2026 conference call",
      url: "https://www.marketbeat.com/earnings/reports/2026-11-4-mercadolibre-inc-stock/",
      fetchedAt: "2026-10-14T17:16:05.054Z",
      kind: "web",
      assetClass: "equity",
      provider: "exa",
      summary:
        "MercadoLibre's Q3 2026 earnings conference call is scheduled for Wednesday, October 28, 2026 at 5:00 PM ET.",
    };

    expect(
      findEarningsDateConflict({
        setup: meliSetup,
        sources: [callOnly],
        rawSnapshots: [],
        instrumentIdentity: { displayName: "MercadoLibre, Inc." },
        analysisAsOf: "2026-10-14T17:16:05.054Z",
      }),
    ).toBeUndefined();
  });

  const netSetup: EarningsSetupCollected = {
    event: {
      symbol: "NET",
      date: "2026-10-29",
      timing: "amc",
      eventDateStatus: "provider-estimated",
      dateStatus: "provider-estimated",
      sourceIds: ["extended-finnhub-events-net"],
      fetchedAt: "2026-10-14T08:30:49.704Z",
    },
    gaps: [],
  };

  test("keeps a conflict when the source only supersedes the provider date", () => {
    expect(
      findEarningsDateConflict({
        setup: netSetup,
        sources: [
          netSource(
            "Cloudflare earnings were previously expected on October 29, 2026, but Cloudflare now will report its financial results on November 5, 2026.",
          ),
        ],
        rawSnapshots: [],
        instrumentIdentity: { displayName: "Cloudflare, Inc." },
        analysisAsOf: "2026-10-14T08:30:49.704Z",
      }),
    ).toEqual({ date: "2026-11-05", sourceId: "news-net-results-date" });
  });

  test("keeps a reporting date that precedes a conference call", () => {
    expect(
      findEarningsDateConflict({
        setup: netSetup,
        sources: [
          netSource(
            "Ahead of its conference call, Cloudflare will report its financial results on November 5, 2026.",
          ),
        ],
        rawSnapshots: [],
        instrumentIdentity: { displayName: "Cloudflare, Inc." },
        analysisAsOf: "2026-10-14T08:30:49.704Z",
      }),
    ).toEqual({ date: "2026-11-05", sourceId: "news-net-results-date" });
  });

  test("ignores an unpunctuated conference-call title when the summary reports the date", () => {
    expect(
      findEarningsDateConflict({
        setup: netSetup,
        sources: [
          netSource(
            "Cloudflare will report its financial results on November 5, 2026.",
            "Cloudflare Q3 2026 earnings conference call scheduled for",
          ),
        ],
        rawSnapshots: [],
        instrumentIdentity: { displayName: "Cloudflare, Inc." },
        analysisAsOf: "2026-10-14T08:30:49.704Z",
      }),
    ).toEqual({ date: "2026-11-05", sourceId: "news-net-results-date" });
  });

  test("ignores a comma-less weekday in a conference-call schedule", () => {
    expect(
      findEarningsDateConflict({
        setup: netSetup,
        sources: [
          netSource(
            "Cloudflare earnings conference call is scheduled for Thursday November 5, 2026.",
          ),
        ],
        rawSnapshots: [],
        instrumentIdentity: { displayName: "Cloudflare, Inc." },
        analysisAsOf: "2026-10-14T08:30:49.704Z",
      }),
    ).toBeUndefined();
  });

  test("carries a conflict through projection and the full Earnings Setup markdown", async () => {
    const identity = await fixture("issuer-confirmed");
    const provider = await fixture("provider-estimated");
    const source = announcementSource();
    const withConflict = applyEarningsDateConflict({
      collectedSources: collectedSources({
        rawSnapshots: identity.rawSnapshots,
        newsSources: [source],
        earningsSetup: provider.setup,
      }),
      analysisAsOf: provider.analysisAsOf,
    });
    const extras = projectExtendedEvidenceReportExtras({
      modelExtras: {},
      collectedSources: withConflict,
    });

    expect(extras.earningsSetup).toMatchObject({
      event: { dateConflict: { date: "2026-08-05", sourceId: "news-aapl-results-date" } },
    });
    const markdown = renderEarningsSetup(
      researchReport({
        jobType: "equity",
        assetClass: "equity",
        symbol: "AAPL",
        sources: [
          ...identity.sources,
          source,
          {
            id: "extended-finnhub-events-aapl",
            title: "AAPL provider earnings estimate",
            fetchedAt: provider.analysisAsOf,
            kind: "extended-evidence",
          },
        ],
        extras,
      }),
    );

    expect(markdown).toContain("2026-08-05");
    expect(markdown).toContain("[news-aapl-results-date]");
  });
});

const amdSetup: EarningsSetupCollected = {
  event: {
    symbol: "AMD",
    date: "2026-11-03",
    timing: "amc",
    eventDateStatus: "provider-estimated",
    sourceIds: ["extended-finnhub-events-amd"],
    fetchedAt: "2026-10-10T12:00:00.000Z",
  },
  gaps: [],
};

function amdSubmissions(overrides: Record<string, unknown> = {}): RawSourceSnapshot {
  return {
    id: "raw-sec-submissions-amd",
    adapter: "sec-submissions",
    fetchedAt: "2026-10-10T12:00:00.000Z",
    payload: {
      cik: "0000002488",
      name: "ADVANCED MICRO DEVICES INC",
      tickers: ["AMD"],
      website: "",
      investorWebsite: "",
      ...overrides,
    },
  } as RawSourceSnapshot;
}

function amdSource(url: string, publisher?: string): Source {
  return {
    id: "web-amd-earnings",
    title: "AMD to Report Fiscal Third Quarter 2026 Financial Results",
    url,
    ...(publisher !== undefined ? { publisher } : {}),
    fetchedAt: "2026-10-06T16:15:00.000Z",
    kind: "web",
    assetClass: "equity",
    symbol: "AMD",
    provider: "exa",
    snippet:
      "AMD (NASDAQ: AMD) will report fiscal third quarter 2026 financial results on Tuesday, Nov. 3, 2026, after the market close.",
  };
}

function confirm(snapshot: RawSourceSnapshot, source: Source): EarningsSetupCollected | undefined {
  return confirmEarningsDateFromOfficialSources({
    setup: amdSetup,
    sources: [source],
    rawSnapshots: [snapshot],
    analysisAsOf: "2026-10-10T12:00:00.000Z",
  });
}

const irUrl = "https://ir.amd.com/news-events/press-releases/detail/1300/amd-to-report";

describe("checked-in issuer IR host fallback", () => {
  test("confirms from the mapped IR host when SEC website fields are empty", () => {
    const result = confirm(amdSubmissions(), amdSource(irUrl));

    expect(result?.event.eventDateStatus).toBe("issuer-confirmed");
    expect(result?.event.dateConfirmation).toMatchObject({
      sourceId: "web-amd-earnings",
      sourceType: "issuer-press-release",
      issuerIdentity: { symbol: "AMD", matchedBy: "official-host" },
    });
  });

  test("rejects lookalike hosts", () => {
    for (const url of [
      "https://ir.amd.com.evil.example/press-release",
      "https://amd.com.evil.example/press-release",
      "https://evil-ir.amd.com/press-release",
      "https://amd.com/press-release",
      "http://ir.amd.com/news-events/press-releases/detail/1300/amd-to-report",
    ]) {
      expect(confirm(amdSubmissions(), amdSource(url))?.event.eventDateStatus).toBe(
        "provider-estimated",
      );
    }
  });

  test("fails closed for an unmapped, missing, or malformed CIK", () => {
    for (const cik of [
      "0000000001",
      undefined,
      ["0000002488"],
      "2.488e3",
      "0x9b8",
      " 2488",
      2488.5,
    ]) {
      expect(confirm(amdSubmissions({ cik }), amdSource(irUrl))?.event.eventDateStatus).toBe(
        "provider-estimated",
      );
    }
    expect(confirm(amdSubmissions({ cik: 2488 }), amdSource(irUrl))?.event.eventDateStatus).toBe(
      "issuer-confirmed",
    );
  });

  test("never takes authority from a third-party publisher field", () => {
    const result = confirm(
      amdSubmissions(),
      amdSource("https://www.stocktitan.net/news/AMD/amd-to-report.html", "Advanced Micro Devices"),
    );

    expect(result?.event.eventDateStatus).toBe("provider-estimated");
  });

  test("does not consult the map when SEC metadata names a host", () => {
    const result = confirm(
      amdSubmissions({ investorWebsite: "https://investor.example-amd.com" }),
      amdSource(irUrl),
    );

    expect(result?.event.eventDateStatus).toBe("provider-estimated");
  });
});

const exhibitRawId = "raw-sec-earnings-release-exhibit-amd";

function amdExhibit(text: string, id = exhibitRawId): RawSourceSnapshot {
  return {
    id,
    adapter: "sec-earnings-release-exhibit",
    fetchedAt: "2026-10-10T12:00:00.000Z",
    payload: `<p>Media: www.we-worldwide.com. Filings at www.sec.gov. ${text}</p>`,
  };
}

function amdEightK(overrides: Partial<Source> = {}): Source {
  return {
    id: "extended-sec-edgar-amd-8k",
    title: "AMD 8-K",
    url: "https://www.sec.gov/Archives/edgar/data/2488/000000248826000121/q22026991.htm",
    fetchedAt: "2026-10-10T12:00:00.000Z",
    kind: "extended-evidence",
    assetClass: "equity",
    symbol: "AMD",
    provider: "sec-edgar",
    rawRef: exhibitRawId,
    identity: { aliases: [{ provider: "sec-edgar", idKind: "ticker", value: "AMD" }] },
    ...overrides,
  };
}

const newsroomUrl = "https://newsroom.amd.com/news/earnings-date-3q-2026/";
const amdFiling = amdExhibit("Learn more at&#8239;www.amd.com.");

function confirmWithFiling(
  url: string,
  input: {
    readonly exhibits?: readonly RawSourceSnapshot[];
    readonly filingSource?: Source;
    readonly submissions?: readonly RawSourceSnapshot[];
  } = {},
): EarningsSetupCollected | undefined {
  return confirmEarningsDateFromOfficialSources({
    setup: amdSetup,
    sources: [amdSource(url), input.filingSource ?? amdEightK()],
    rawSnapshots: [
      ...(input.submissions ?? [amdSubmissions()]),
      ...(input.exhibits ?? [amdFiling]),
    ],
    analysisAsOf: "2026-10-10T12:00:00.000Z",
  });
}

function statusWithFiling(url: string, input: Parameters<typeof confirmWithFiling>[1] = {}) {
  return confirmWithFiling(url, input)?.event.eventDateStatus;
}

describe("issuer domain from the issuer's own SEC filing text", () => {
  test("confirms from an issuer newsroom subdomain of the filed domain", () => {
    expect(confirmWithFiling(newsroomUrl)?.event.dateConfirmation).toMatchObject({
      sourceId: "web-amd-earnings",
      sourceType: "issuer-press-release",
      sourceUrl: newsroomUrl,
      issuerIdentity: { symbol: "AMD", matchedBy: "official-host" },
    });
    expect(statusWithFiling("https://www.amd.com/en/newsroom/q3")).toBe("issuer-confirmed");
  });

  test("rejects other subdomains, lookalikes, and plain HTTP", () => {
    for (const url of [
      "https://community.amd.com/t5/q3-earnings",
      "https://x.newsroom.amd.com/q3",
      "https://newsroom.amd.com.evil.example/q3",
      "https://evilamd.com/q3",
      "http://newsroom.amd.com/q3",
    ]) {
      expect(statusWithFiling(url)).toBe("provider-estimated");
    }
  });

  test("ignores filed domains that do not name the issuer exactly", () => {
    for (const [domain, url] of [
      ["www.micro.example", "https://news.micro.example/results"],
      ["www.amd.com.evil.net", "https://news.amd.com.evil.net/results"],
      ["www.a-m-d.example", "https://news.a-m-d.example/results"],
      ["www.amd.xn--p1ai", "https://amd.xn/results"],
      ["www.amd.xn--p1ai", "https://amd.xn--p1ai/results"],
      ["www.amd.co.uk", "https://news.amd.co.uk/results"],
      ["www.we-worldwide.com", "https://news.we-worldwide.com/amd-q3"],
      ["www.sec.gov", "https://www.sec.gov/amd-q3"],
      ["www.amd.com\u3002evil.net", newsroomUrl],
      ["www.amd.com\u00E9", newsroomUrl],
      ["www.amd.com.x\u3002y", newsroomUrl],
      ["\u00E9www.amd.com", newsroomUrl],
      ["www.amd.example", "https://news.amd.example/results"],
    ] as const) {
      expect(statusWithFiling(url, { exhibits: [amdExhibit(`See ${domain} for more.`)] })).toBe(
        "provider-estimated",
      );
    }
  });

  test("ignores filing text not bound to the issuer's CIK", () => {
    const unbound: Parameters<typeof confirmWithFiling>[1][] = [
      { filingSource: (({ rawRef: _rawRef, ...rest }) => rest)(amdEightK()) },
      { filingSource: amdEightK({ rawRef: "raw-other" }) },
      {
        filingSource: amdEightK({
          url: "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000001/ex99.htm",
        }),
      },
      {
        filingSource: amdEightK({ url: "https://www.sec.gov.evil.example/edgar/data/2488/x.htm" }),
      },
      { filingSource: amdEightK({ provider: "exa" }) },
      { filingSource: amdEightK({ symbol: "NVDA" }) },
      { submissions: [] },
      { submissions: [amdSubmissions({ cik: "0000000001" })] },
      { exhibits: [amdFiling, amdExhibit("Unrelated filing.")] },
      { exhibits: [{ ...amdFiling, cacheStatus: "stale-fallback" }] },
      { exhibits: [{ ...amdFiling, payloadCompacted: true }] },
    ];
    for (const input of unbound) {
      expect(statusWithFiling(newsroomUrl, input)).toBe("provider-estimated");
    }
  });

  test("stays provider-estimated when no filing names an issuer domain", () => {
    expect(statusWithFiling(newsroomUrl, { exhibits: [amdExhibit("")] })).toBe(
      "provider-estimated",
    );
    expect(confirm(amdSubmissions(), amdSource(newsroomUrl))?.event.eventDateStatus).toBe(
      "provider-estimated",
    );
  });
});
