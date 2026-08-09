import { describe, expect, test } from "bun:test";
import type { ResearchCommand } from "../src/cli/args";
import { finalSynthesisInstruction } from "./support/research-context-helpers";

// Carved out of prompt-final-synthesis.test.ts to keep both files under the 800-line hard limit
// (docs/architecture.md). Pins the horizon clause in buildPrimaryPredictionInstruction: the two
// Named windows must stay evidence-conditioned and must never read as a count or distribution.

describe("buildStagePrompt forecast diversity guidance", () => {
  test("names a concrete evidence-conditioned horizon choice", () => {
    const command: ResearchCommand = {
      jobType: "equity",
      assetClass: "equity",
      symbol: "AAPL",
      depth: "deep",
    };
    const instruction = finalSynthesisInstruction(command);

    expect(instruction).toContain(
      "a horizon of either 5 or 10 trading days, chosen per forecast: use 10 when the cited evidence resolves over that window, otherwise 5.",
    );
    expect(instruction).not.toContain("a default horizon near 5 trading days");
    // Naming two windows must not turn into a count-conditioned request. These are the phrasings a
    // Drift toward a quota would realistically produce — the failure mode ADR 0003's soft-target
    // Language exists to prevent — not synonyms nobody would write.
    for (const banned of [
      "use both horizons",
      "at least one forecast at each",
      "distribute forecasts across",
      "ensure multiple horizons",
      "resolution-window variety",
      "varying horizons",
      "mix of horizons",
    ]) {
      expect(instruction).not.toContain(banned);
    }
    // The positive half of the same contract: a run whose evidence all resolves over one window
    // Must be told that outcome is correct, not merely un-banned.
    expect(instruction).toContain("a uniform horizon is valid");
  });

  test("offers the longer window one calibration bucket out, not double the default", () => {
    // Market-overview passes --horizon straight through as the profile default, so a 10-day run is
    // Reachable; +5 yields 15 where doubling would yield 20 and skip a bucket.
    const command: ResearchCommand = {
      jobType: "market-overview",
      assetClass: "equity",
      depth: "deep",
      horizonTradingDays: 10,
    };
    const instruction = finalSynthesisInstruction(command);

    expect(instruction).toContain(
      "a horizon of either 10 or 15 trading days, chosen per forecast: use 15 when the cited evidence resolves over that window, otherwise 10.",
    );
    expect(instruction).not.toContain("10 or 20 trading days");
  });

  test("caps the longer window at the 20-trading-day bound", () => {
    // 16 is the smallest reachable default that exercises the clamp: 16 + 5 = 21 is outside the
    // DSL bound and must come back as 20. A 15-day default would pass with or without the cap.
    const command: ResearchCommand = {
      jobType: "market-overview",
      assetClass: "equity",
      depth: "deep",
      horizonTradingDays: 16,
    };
    const instruction = finalSynthesisInstruction(command);

    expect(instruction).toContain(
      "a horizon of either 16 or 20 trading days, chosen per forecast: use 20 when the cited evidence resolves over that window, otherwise 16.",
    );
    expect(instruction).not.toContain("21 trading days");
  });
});
