import { describe, expect, test } from "bun:test";
import { scorePassOptions } from "../src/app";

describe("scorePassOptions", () => {
  test("disables scorer close cache when source cache is disabled", () => {
    expect(
      scorePassOptions({
        equityMoverLimit: 5,
        cryptoMoverLimit: 5,
        newsLimit: 8,
        sourceTimeoutMs: 15_000,
        cacheDir: "data/cache",
        cacheDisabled: true,
      }),
    ).toEqual({});
  });

  test("uses cache dir for scorer close cache when cache is enabled", () => {
    expect(
      scorePassOptions({
        equityMoverLimit: 5,
        cryptoMoverLimit: 5,
        newsLimit: 8,
        sourceTimeoutMs: 15_000,
        cacheDir: "data/cache",
        cacheDisabled: false,
      }),
    ).toEqual({ closeCacheDir: "data/cache" });
  });
});
