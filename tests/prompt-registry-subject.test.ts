import { describe, expect, test } from "bun:test";
import type { ResearchCommand } from "../src/cli/args";
import { resolveResearchSubject } from "../src/research/research-subject-identity";
import { collectedSources, marketSnapshot, newsSource } from "./support/fixtures";
import { config, researchContext, stagePromptFromArgs } from "./support/research-context-helpers";

// ---------------------------------------------------------------------------
// Phase 2.2 — registry subject in evidence payload and missing-snapshot gaps
// ---------------------------------------------------------------------------
describe("phase 2.2 — registrySubject in evidence payload", () => {
  test("includes registrySubject block for resolved research subject", () => {
    const command: ResearchCommand = {
      jobType: "research",
      assetClass: "equity",
      subject: "chip stocks",
      subjectKey: "semiconductors",
      predictionProxySymbol: "SMH",
      depth: "brief",
    };
    const resolvedSubject = resolveResearchSubject(command)!;
    const prompt = stagePromptFromArgs(
      "specialist-analysis",
      command,
      collectedSources({
        resolvedSubject,
        marketSnapshots: [
          marketSnapshot({ sourceId: "market-smh", symbol: "SMH" }),
          marketSnapshot({ sourceId: "market-nvda", symbol: "NVDA" }),
        ],
        newsSources: [newsSource()],
      }),
      config,
      { ...researchContext(command), resolvedSubject },
      { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." },
    );
    const parsed = JSON.parse(prompt) as {
      readonly evidence?: {
        readonly registrySubject?: {
          readonly subjectKey?: string;
          readonly displayName?: string;
          readonly representativeInstruments?: readonly {
            readonly symbol?: string;
            readonly hasLiveSnapshot?: boolean;
          }[];
          readonly provenanceSources?: readonly { readonly sourceId?: string }[];
          readonly predictionProxy?: { readonly symbol?: string };
        };
      };
    };

    const subject = parsed.evidence?.registrySubject;
    expect(subject?.subjectKey).toBe("semiconductors");
    expect(subject?.displayName).toBe("Semiconductors");
    expect(subject?.predictionProxy?.symbol).toBe("SMH");

    const reps = subject?.representativeInstruments ?? [];
    const smh = reps.find((r) => r.symbol === "SMH");
    const nvda = reps.find((r) => r.symbol === "NVDA");
    const amd = reps.find((r) => r.symbol === "AMD");

    expect(smh?.hasLiveSnapshot).toBe(true);
    expect(nvda?.hasLiveSnapshot).toBe(true);
    expect(amd?.hasLiveSnapshot).toBe(false);

    const sourceIds = (subject?.provenanceSources ?? []).map((s) => s.sourceId);
    expect(sourceIds).toContain("vaneck-smh");
    expect(sourceIds).toContain("nasdaq-nvda");
  });

  test("omits registrySubject block for unresolved research subject", () => {
    const command: ResearchCommand = {
      jobType: "research",
      assetClass: "equity",
      subject: "unknown niche",
      depth: "brief",
    };
    const prompt = stagePromptFromArgs(
      "specialist-analysis",
      command,
      collectedSources({ newsSources: [newsSource()] }),
      config,
      researchContext(command),
      { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." },
    );
    const parsed = JSON.parse(prompt) as {
      readonly evidence?: { readonly registrySubject?: unknown };
    };

    expect(parsed.evidence?.registrySubject).toBeUndefined();
  });
});
