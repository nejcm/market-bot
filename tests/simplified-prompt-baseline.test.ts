import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { simplifiedPromptBaselineMatrix } from "./support/simplified-prompt-baseline-matrix";

// Refresh deliberately with UPDATE_PROMPT_BASELINE=1 bun test tests/simplified-prompt-baseline.test.ts.
const GOLDEN_PATH = join(import.meta.dir, "support", "simplified-prompt-baseline.golden.json");

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

// Every path whose key names a wholesale snapshot collection, at any depth.
// Returned as paths rather than a boolean so a failure names where the payload regrew.
function snapshotBearingKeys(value: unknown, path = "$"): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => snapshotBearingKeys(item, `${path}[${String(index)}]`));
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const here = `${path}.${key}`;
    const offending = key.toLowerCase().endsWith("marketsnapshots") ? [here] : [];
    return [...offending, ...snapshotBearingKeys(child, here)];
  });
}

describe("simplified deep-equity prompt baseline", () => {
  test("renders the metadata-sanitized snapshot with production tail-key order", async () => {
    const matrix = await simplifiedPromptBaselineMatrix();
    const equityAnalysis = matrix.cases.find(({ key }) => key === "equity-analysis");
    expect(equityAnalysis).toBeDefined();
    const prompt = JSON.parse(equityAnalysis!.text) as {
      readonly evidence: {
        readonly canonicalFacts: {
          readonly marketSnapshots: readonly Record<string, unknown>[];
        };
      };
    };
    const [snapshot] = prompt.evidence.canonicalFacts.marketSnapshots;

    expect(snapshot).toBeDefined();
    expect(Object.keys(snapshot!).slice(-3)).toEqual(["name", "identity", "benchmark"]);
  });

  // This was a line-anchored regex over the prompt text, so it only worked while the JSON stayed
  // Pretty-printed. Emitting the prompt on one line would have made the pattern unmatchable and the
  // Guard silently permanent, with the hash pin as the only remaining backstop.
  // Walking the parsed structure instead makes it independent of formatting.
  test("keeps final-synthesis on named projections instead of wholesale snapshots", async () => {
    const matrix = await simplifiedPromptBaselineMatrix();
    const finalSynthesis = matrix.cases.find(({ key }) => key === "final-synthesis");

    expect(finalSynthesis).toBeDefined();
    expect(snapshotBearingKeys(JSON.parse(finalSynthesis!.text))).toEqual([]);
  });

  // Guard on the guard. The payload below is exactly what the check exists to reject, serialized
  // The way the old pattern could not see. If this ever passes, the replacement was pointless.
  test("detects a wholesale snapshot the line-anchored pattern would miss", () => {
    const regrown = { evidence: { canonicalFacts: { marketSnapshots: [{ symbol: "AAPL" }] } } };
    const singleLine = JSON.stringify(regrown);

    expect(singleLine).not.toMatch(/^\s*"\w*[Mm]arketSnapshots":/mu);
    expect(snapshotBearingKeys(regrown)).toEqual(["$.evidence.canonicalFacts.marketSnapshots"]);
  });

  test("prompt hashes match the checked-in goldens", async () => {
    const matrix = await simplifiedPromptBaselineMatrix();
    const actual: Record<string, string> = {};
    for (const { key, text } of matrix.cases) {
      expect(actual[key]).toBeUndefined();
      actual[key] = sha256(text);
    }

    if (process.env.UPDATE_PROMPT_BASELINE === "1") {
      await Bun.write(GOLDEN_PATH, `${JSON.stringify(actual, undefined, 2)}\n`);
      return;
    }

    const golden = (await Bun.file(GOLDEN_PATH).json()) as Record<string, string>;
    expect(Object.keys(actual).toSorted()).toEqual(Object.keys(golden).toSorted());
    for (const [key, hash] of Object.entries(actual)) {
      expect(`${key}:${hash}`).toBe(`${key}:${golden[key] ?? "<missing>"}`);
    }
  });

  test("matrix is deterministic across builds", async () => {
    const first = await simplifiedPromptBaselineMatrix();
    const second = await simplifiedPromptBaselineMatrix();

    expect(second.cases.map(({ key, text }) => [key, sha256(text)])).toEqual(
      first.cases.map(({ key, text }) => [key, sha256(text)]),
    );
  });
});
