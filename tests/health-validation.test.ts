import { describe, expect, test } from "bun:test";
import type { ProviderRouteHealth, RunHealth } from "../src/health/provider-health";
import { buildValidation } from "../src/health/validation";

const NOW = new Date("2026-06-01T00:00:00.000Z");

function run(overrides: Partial<RunHealth> = {}): RunHealth {
  return {
    runId: "run-1",
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
