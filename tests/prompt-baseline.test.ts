import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { promptBaselineCases } from "./support/prompt-baseline-matrix";

// Prompt byte-identity contract for the deepen-modules refactor: emitted prompt strings
// Must stay byte-identical across structure-only moves. The LLM cassette is keyed
// Stage|model and the content tests assert substrings, so neither can catch prompt drift;
// This golden map of SHA-256 hashes can. A deliberate prompt change refreshes the goldens
// Explicitly: UPDATE_PROMPT_BASELINE=1 bun test tests/prompt-baseline.test.ts
const GOLDEN_PATH = join(import.meta.dir, "support", "prompt-baseline.golden.json");

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function historicalDataGaps(key: string): readonly string[] {
  const baseline = promptBaselineCases().find((candidate) => candidate.key === key);
  if (baseline === undefined) {
    throw new Error(`Missing prompt baseline case ${key}`);
  }
  const prompt = JSON.parse(baseline.text) as {
    readonly evidence: {
      readonly historicalContext: {
        readonly runs: readonly { readonly dataGaps: readonly string[] }[];
      };
    };
  };
  return prompt.evidence.historicalContext.runs[0]?.dataGaps ?? [];
}

describe("prompt baseline", () => {
  test("prompt hashes match the checked-in goldens", async () => {
    const hashes: Record<string, string> = {};
    for (const { key, text } of promptBaselineCases()) {
      expect(hashes[key]).toBeUndefined();
      hashes[key] = sha256(text);
    }

    if (process.env.UPDATE_PROMPT_BASELINE === "1") {
      await Bun.write(GOLDEN_PATH, `${JSON.stringify(hashes, undefined, 2)}\n`);
      return;
    }

    const golden = (await Bun.file(GOLDEN_PATH).json()) as Record<string, string>;
    expect(Object.keys(hashes).toSorted()).toEqual(Object.keys(golden).toSorted());
    for (const [key, hash] of Object.entries(hashes)) {
      expect(`${key}:${hash}`).toBe(`${key}:${golden[key] ?? "<missing>"}`);
    }
  });

  test("matrix is deterministic across builds", () => {
    const first = promptBaselineCases();
    const second = promptBaselineCases();
    expect(second.map(({ key, text }) => `${key}:${sha256(text)}`)).toEqual(
      first.map(({ key, text }) => `${key}:${sha256(text)}`),
    );
  });

  test("historical-gap cases retain the complete and Web Gather views", () => {
    const hidden = [
      "finnhub-analyst-range: analyst range unavailable",
      "finnhub-eps-estimate: EPS estimates unavailable",
      "finnhub-revenue-estimate: revenue estimates unavailable",
      "finnhub-ebitda-estimate: EBITDA estimates unavailable",
      "business-framework: Business Framework partial for AAPL: analyst-consensus: consensus unavailable",
    ];
    const retained = [
      "finnhub-events: dividend history unavailable",
      "tradier-options: options evidence unavailable",
      "business-framework: Business Framework partial for AAPL: segment-mix: segment mix unavailable",
    ];

    expect(historicalDataGaps("stage:evidence-request:historical-gaps")).toEqual([
      ...hidden,
      ...retained,
    ]);
    expect(historicalDataGaps("stage:web-gather:historical-gaps")).toEqual(retained);
  });
});
