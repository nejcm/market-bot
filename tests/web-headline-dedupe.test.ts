import { describe, expect, test } from "bun:test";
import type { Source } from "../src/domain/types";
import {
  dedupeWebSourcesByHeadline,
  headlineSimilarity,
  normalizedHeadlineTokens,
} from "../src/sources/web-headline-dedupe";

function webSource(overrides: Partial<Source> & Pick<Source, "id" | "title">): Source {
  return {
    url: `https://example.com/${overrides.id}`,
    fetchedAt: "2026-07-01T00:00:00.000Z",
    kind: "web",
    provider: "exa",
    ...overrides,
  };
}

describe("dedupeWebSourcesByHeadline", () => {
  test("rejects an exact duplicate headline from a different outlet", () => {
    const existing = [
      webSource({ id: "web-aapl-1", title: "Apple sued by OpenAI over Siri claims" }),
    ];
    const candidate = webSource({
      id: "web-aapl-2",
      title: "Apple sued by OpenAI over Siri claims",
      url: "https://other-outlet.example/openai-apple",
    });

    const result = dedupeWebSourcesByHeadline(existing, [candidate]);

    expect(result.kept).toHaveLength(0);
    expect(result.rejected).toEqual([
      {
        reason: "duplicate-headline",
        sourceId: "web-aapl-2",
        title: "Apple sued by OpenAI over Siri claims",
        duplicateOfSourceId: "web-aapl-1",
        duplicateOfTitle: "Apple sued by OpenAI over Siri claims",
      },
    ]);
  });

  test("rejects a paraphrased duplicate above the similarity threshold", () => {
    const existing = [
      webSource({ id: "web-aapl-1", title: "Apple sued by OpenAI over Siri claims" }),
    ];
    const candidate = webSource({
      id: "web-aapl-2",
      title: "OpenAI sues Apple over Siri assistant claims",
    });

    const result = dedupeWebSourcesByHeadline(existing, [candidate]);

    expect(result.kept).toHaveLength(0);
    expect(result.rejected[0]).toMatchObject({
      reason: "duplicate-headline",
      sourceId: "web-aapl-2",
      duplicateOfSourceId: "web-aapl-1",
    });
  });

  test("keeps a different story about the same entity", () => {
    const existing = [
      webSource({ id: "web-aapl-1", title: "Apple sued by OpenAI over Siri claims" }),
    ];
    const candidate = webSource({
      id: "web-aapl-2",
      title: "Apple unveils new iPhone lineup at fall event",
    });

    const result = dedupeWebSourcesByHeadline(existing, [candidate]);

    expect(result.kept).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  test("dedupes within a single candidate batch, keeping the first occurrence", () => {
    const candidates = [
      webSource({ id: "web-aapl-1", title: "Apple sued by OpenAI over Siri claims" }),
      webSource({ id: "web-aapl-2", title: "Apple sued by OpenAI over Siri claims" }),
      webSource({ id: "web-aapl-3", title: "OpenAI lawsuit targets Apple Siri claims" }),
    ];

    const result = dedupeWebSourcesByHeadline([], candidates);

    expect(result.kept.map((source) => source.id)).toEqual(["web-aapl-1"]);
    expect(result.rejected.map((entry) => entry.sourceId)).toEqual(["web-aapl-2", "web-aapl-3"]);
    expect(result.rejected.every((entry) => entry.duplicateOfSourceId === "web-aapl-1")).toBeTrue();
  });

  test("never compares against non-web sources", () => {
    const secSource: Source = {
      id: "extended-sec-edgar-aapl-10k",
      title: "Apple sued by OpenAI over Siri claims",
      fetchedAt: "2026-07-01T00:00:00.000Z",
      kind: "extended-evidence",
      provider: "sec-edgar",
    };
    const candidate = webSource({
      id: "web-aapl-1",
      title: "Apple sued by OpenAI over Siri claims",
    });

    const result = dedupeWebSourcesByHeadline([secSource], [candidate]);

    expect(result.kept).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  test("keeps titles below the comparable-token floor, including hostname fallbacks", () => {
    const candidates = [
      webSource({ id: "web-aapl-1", title: "example.com" }),
      webSource({ id: "web-aapl-2", title: "example.com" }),
    ];

    const result = dedupeWebSourcesByHeadline([], candidates);

    expect(result.kept).toHaveLength(2);
    expect(result.rejected).toHaveLength(0);
  });

  test("passes through same-id candidates for the downstream id dedupe", () => {
    const existing = [
      webSource({ id: "web-aapl-1", title: "Apple sued by OpenAI over Siri claims" }),
    ];
    const candidate = webSource({
      id: "web-aapl-1",
      title: "Apple sued by OpenAI over Siri claims",
    });

    const result = dedupeWebSourcesByHeadline(existing, [candidate]);

    expect(result.kept).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });
});

describe("headlineSimilarity", () => {
  test("returns 0 when either token set is below the floor", () => {
    const short = normalizedHeadlineTokens("example.com");
    const long = normalizedHeadlineTokens("Apple sued by OpenAI over Siri claims");
    expect(headlineSimilarity(short, long)).toBe(0);
    expect(headlineSimilarity(short, short)).toBe(0);
  });

  test("normalization strips punctuation, casing, stopwords, and single characters", () => {
    expect(normalizedHeadlineTokens("Apple's Siri: sued, by OpenAI!")).toEqual(
      new Set(["apple", "siri", "sued", "openai"]),
    );
  });
});
