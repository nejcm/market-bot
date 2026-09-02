import { describe, expect, test } from "bun:test";
import type { ProviderRouteHealth, RunHealth } from "../src/health/provider-health";
import { buildValidation } from "../src/health/validation";

const NOW = new Date("2026-06-01T00:00:00.000Z");

function run(overrides: Partial<RunHealth> = {}): RunHealth {
  return {
    runId: "run-1",
    failed: false,
    sourceGaps: [],
    sources: [],
    predictionHorizons: [],
    scoreCount: 0,
    resolvedScoreCount: 0,
    ...overrides,
  };
}

function route(overrides: Partial<ProviderRouteHealth> = {}): ProviderRouteHealth {
  return {
    route: "route-1",
    provider: "provider-1",
    total: 1,
    missingCredential: 0,
    fetchFailed: 0,
    yahooAuth: 0,
    other: 1,
    statuses: {},
    causes: {},
    runIds: [],
    sampleMessages: [],
    ...overrides,
  };
}

function classificationFor(summary: ReturnType<typeof buildValidation>, routeName: string) {
  return summary.routeClassifications.find((item) => item.route === routeName);
}

describe("buildValidation route classification", () => {
  test("treats FRED macro gaps as blocking", () => {
    const summary = buildValidation(
      [],
      [route({ route: "fred-macro", provider: "fred" })],
      true,
      NOW,
    );
    expect(classificationFor(summary, "fred-macro")?.classification).toBe("blocking");
  });

  test("treats Yahoo authentication failures as blocking", () => {
    const summary = buildValidation(
      [],
      [route({ route: "yahoo-quote", provider: "yahoo", yahooAuth: 1 })],
      true,
      NOW,
    );
    expect(classificationFor(summary, "yahoo-quote")?.classification).toBe("blocking");
  });

  /*
   * The successful path of the in-progress-bar trim: the collector dropped a partial session and
   * published the prior one. Before this classification it fell through to "Unclassified provider
   * gap requires review" and every routine intraday run registered a blocking provider defect.
   */
  test("treats a sole session-in-progress cause as informational, not blocking", () => {
    const summary = buildValidation(
      [],
      [
        route({
          route: "yahoo-verified-chart",
          provider: "yahoo",
          total: 1,
          causes: { "session-in-progress": 1 },
        }),
      ],
      true,
      NOW,
    );
    expect(classificationFor(summary, "yahoo-verified-chart")?.classification).toBe(
      "informational",
    );
  });

  test("keeps a route blocking when session-in-progress is mixed with another cause", () => {
    const summary = buildValidation(
      [],
      [
        route({
          route: "yahoo-verified-chart",
          provider: "yahoo",
          total: 2,
          causes: { "session-in-progress": 1, "malformed-response": 1 },
        }),
      ],
      true,
      NOW,
    );
    expect(classificationFor(summary, "yahoo-verified-chart")?.classification).toBe("blocking");
  });

  /*
   * The counters and the cause table disagree by design: `causes` records only gaps that declared
   * a cause, `total` records every gap. This route aggregates a routine trim with a cause-less
   * HTTP failure, so `causes` sees one clean entry while a real provider failure sits beside it.
   * Reading `causes` alone called this sole-cause and downgraded a broken route to informational.
   */
  test("keeps a route blocking when a cause-less gap sits beside the trimmed session", () => {
    const summary = buildValidation(
      [],
      [
        route({
          route: "yahoo-verified-chart",
          provider: "yahoo",
          total: 2,
          causes: { "session-in-progress": 1 },
          fetchFailed: 1,
        }),
      ],
      true,
      NOW,
    );
    expect(classificationFor(summary, "yahoo-verified-chart")?.classification).toBe("blocking");
  });

  test("keeps a non-Yahoo route blocking when a cause-less gap joins the trimmed session", () => {
    const summary = buildValidation(
      [],
      [
        route({
          route: "provider-chart",
          provider: "provider-1",
          total: 2,
          causes: { "session-in-progress": 1 },
          other: 1,
        }),
      ],
      true,
      NOW,
    );
    expect(classificationFor(summary, "provider-chart")?.classification).toBe("blocking");
  });

  test("still treats an all-trim route as informational when several runs aggregate", () => {
    const summary = buildValidation(
      [],
      [
        route({
          route: "yahoo-verified-chart",
          provider: "yahoo",
          total: 3,
          causes: { "session-in-progress": 3 },
          other: 3,
        }),
      ],
      true,
      NOW,
    );
    expect(classificationFor(summary, "yahoo-verified-chart")?.classification).toBe(
      "informational",
    );
  });

  /*
   * Yahoo is the primary equity source but was the only primary-source rule not reading its own
   * fetchFailed counter (CoinGecko below always has). A cause-less transport failure still blocked,
   * via the generic fallback, but was reported as an unclassified gap rather than as the primary
   * market-data source failing.
   */
  test("attributes a cause-less Yahoo transport failure to the primary-source rule", () => {
    const summary = buildValidation(
      [],
      [route({ route: "yahoo-chart", provider: "yahoo", total: 1, fetchFailed: 1 })],
      true,
      NOW,
    );
    const classification = classificationFor(summary, "yahoo-chart");
    expect(classification?.classification).toBe("blocking");
    expect(classification?.reason).toBe("Yahoo is the primary equity market-data source.");
  });

  test("keeps a fetch-failed Yahoo route blocking even beside a trimmed session", () => {
    const summary = buildValidation(
      [],
      [
        route({
          route: "yahoo-verified-chart",
          provider: "yahoo",
          total: 2,
          causes: { "session-in-progress": 1, "fetch-failed": 1 },
        }),
      ],
      true,
      NOW,
    );
    expect(classificationFor(summary, "yahoo-verified-chart")?.classification).toBe("blocking");
  });

  test("treats CoinGecko fetch failures as blocking", () => {
    const summary = buildValidation(
      [],
      [route({ route: "coingecko-markets", provider: "coingecko", fetchFailed: 1 })],
      true,
      NOW,
    );
    expect(classificationFor(summary, "coingecko-markets")?.classification).toBe("blocking");
  });

  test("treats individual news provider gaps as expected", () => {
    const summary = buildValidation(
      [],
      [route({ route: "marketaux-news", provider: "marketaux" })],
      true,
      NOW,
    );
    expect(classificationFor(summary, "marketaux-news")?.classification).toBe("expected");
  });

  test("treats SEC extended-evidence gaps as expected", () => {
    const summary = buildValidation(
      [],
      [route({ route: "sec-filings", provider: "sec" })],
      true,
      NOW,
    );
    expect(classificationFor(summary, "sec-filings")?.classification).toBe("expected");
  });

  test("treats persistent news-seen fallback as informational", () => {
    const summary = buildValidation(
      [],
      [route({ route: "news-seen", provider: "news" })],
      true,
      NOW,
    );
    expect(classificationFor(summary, "news-seen")?.classification).toBe("informational");
  });

  test("treats profile reuse as informational without demoting stale cache fallbacks", () => {
    const summary = buildValidation(
      [],
      [
        route({
          route: "web-subject-profile",
          provider: "market-bot",
          causes: { "stale-fallback": 1 },
        }),
        route({
          route: "yahoo-verified-chart",
          provider: "yahoo",
          causes: { "stale-fallback": 1 },
        }),
      ],
      true,
      NOW,
    );
    const failureSummary = buildValidation(
      [],
      [
        route({
          route: "web-subject-profile",
          provider: "market-bot",
          causes: { "validation-failed": 1 },
        }),
      ],
      true,
      NOW,
    );

    expect(classificationFor(summary, "web-subject-profile")?.classification).toBe("informational");
    expect(classificationFor(failureSummary, "web-subject-profile")?.classification).toBe(
      "blocking",
    );
    expect(classificationFor(summary, "yahoo-verified-chart")?.classification).toBe("blocking");
  });

  test("treats missing optional credentials as expected", () => {
    const summary = buildValidation(
      [],
      [route({ route: "glassnode-metrics", provider: "glassnode", missingCredential: 1 })],
      true,
      NOW,
    );
    // Glassnode is explicitly optional enrichment.
    expect(classificationFor(summary, "glassnode-metrics")?.classification).toBe("expected");
  });

  test("flags an unclassified provider gap as blocking for review", () => {
    const summary = buildValidation(
      [],
      [route({ route: "mystery", provider: "mystery" })],
      true,
      NOW,
    );
    expect(classificationFor(summary, "mystery")?.classification).toBe("blocking");
    expect(classificationFor(summary, "mystery")?.reason).toContain("Unclassified");
  });
});

describe("buildValidation synthetic issues", () => {
  test("reports every required coverage lane as missing when there are no runs", () => {
    const summary = buildValidation([], [], true, NOW);

    expect(summary.requiredCoverage).toHaveLength(8);
    expect(summary.requiredCoverage.every((item) => !item.met)).toBe(true);
    expect(summary.status).toBe("fail");
    expect(
      summary.routeClassifications.filter((item) => item.route.startsWith("coverage:")).length,
    ).toBe(8);
  });

  test("flags a matured prediction with no scoring pass as blocking", () => {
    const summary = buildValidation(
      [run({ generatedAt: "2026-05-01T00:00:00.000Z", predictionHorizons: [5], scoreCount: 0 })],
      [],
      true,
      NOW,
    );
    expect(classificationFor(summary, "scoring:due")?.classification).toBe("blocking");
  });

  test("does not flag scoring when a due prediction already has scores", () => {
    const summary = buildValidation(
      [run({ generatedAt: "2026-05-01T00:00:00.000Z", predictionHorizons: [5], scoreCount: 2 })],
      [],
      true,
      NOW,
    );
    expect(classificationFor(summary, "scoring:due")).toBeUndefined();
  });

  test("marks absent calibration as an expected warning once horizons exist", () => {
    const summary = buildValidation([run({ predictionHorizons: [5] })], [], false, NOW);
    expect(classificationFor(summary, "calibration")?.classification).toBe("expected");
  });

  test("sorts classifications by class then route and derives the worst status", () => {
    const summary = buildValidation(
      [],
      [
        route({ route: "zzz-expected", provider: "sec" }),
        route({ route: "aaa-blocking", provider: "fred" }),
      ],
      true,
      NOW,
    );
    // Fail because coverage lanes are all missing (blocking).
    expect(summary.status).toBe("fail");
    const classes = summary.routeClassifications.map((item) => item.classification);
    // "blocking" sorts before "expected".
    expect(classes.indexOf("blocking")).toBeLessThan(classes.lastIndexOf("expected"));
  });
});
