import { describe, expect, test } from "bun:test";
import { classifyRunFreshness, instrumentFreshness } from "../app/client/run-freshness";

const NOW = new Date("2026-10-20T12:00:00.000Z");

describe("classifyRunFreshness", () => {
  test("classifies a symbol without a successful run as never-run", () => {
    expect(classifyRunFreshness(undefined, ["2026-10-01"], NOW, 30)).toEqual({
      state: "never-run",
    });
  });

  test("classifies a young run without earnings evidence as fresh", () => {
    expect(classifyRunFreshness({ generatedAt: "2026-10-19T12:00:00.000Z" }, [], NOW, 30)).toEqual({
      state: "fresh",
    });
  });

  test("treats exactly N days old as fresh and N+1 as stale by age", () => {
    expect(classifyRunFreshness({ generatedAt: "2026-09-20T15:00:00.000Z" }, [], NOW, 30)).toEqual({
      state: "fresh",
    });
    expect(classifyRunFreshness({ generatedAt: "2026-09-19T15:00:00.000Z" }, [], NOW, 30)).toEqual({
      state: "stale",
      reason: "age",
      since: "2026-09-19T15:00:00.000Z",
    });
  });

  test("respects the configured threshold, including across month boundaries", () => {
    // 2026-09-30 to 2026-10-20 is 20 calendar days.
    expect(classifyRunFreshness({ generatedAt: "2026-09-30T00:00:00.000Z" }, [], NOW, 20)).toEqual({
      state: "fresh",
    });
    expect(classifyRunFreshness({ generatedAt: "2026-09-30T00:00:00.000Z" }, [], NOW, 19)).toEqual({
      state: "stale",
      reason: "age",
      since: "2026-09-30T00:00:00.000Z",
    });
  });

  test("flags a run whose earnings date has passed, whatever its age", () => {
    expect(
      classifyRunFreshness({ generatedAt: "2026-10-19T12:00:00.000Z" }, ["2026-10-19"], NOW, 30),
    ).toEqual({ state: "stale", reason: "earnings", since: "2026-10-19" });
  });

  test("does not treat an earnings date equal to today as passed", () => {
    expect(
      classifyRunFreshness({ generatedAt: "2026-10-19T12:00:00.000Z" }, ["2026-10-20"], NOW, 30),
    ).toEqual({ state: "fresh" });
  });

  test("ignores future earnings dates", () => {
    expect(
      classifyRunFreshness({ generatedAt: "2026-10-19T12:00:00.000Z" }, ["2026-11-03"], NOW, 30),
    ).toEqual({ state: "fresh" });
  });

  test("flags the earliest passed date among multiple earnings dates", () => {
    expect(
      classifyRunFreshness(
        { generatedAt: "2026-10-15T12:00:00.000Z" },
        ["2026-11-03", "2026-10-18"],
        NOW,
        30,
      ),
    ).toEqual({ state: "stale", reason: "earnings", since: "2026-10-18" });
    expect(
      classifyRunFreshness(
        { generatedAt: "2026-10-15T12:00:00.000Z" },
        ["2026-10-18", "2026-10-17"],
        NOW,
        30,
      ),
    ).toEqual({ state: "stale", reason: "earnings", since: "2026-10-17" });
  });

  test("ignores malformed earnings dates", () => {
    expect(
      classifyRunFreshness(
        { generatedAt: "2026-10-19T12:00:00.000Z" },
        ["2026-1-3", "not-a-date"],
        NOW,
        30,
      ),
    ).toEqual({ state: "fresh" });
  });

  test("treats a same-day run as fresh regardless of time of day", () => {
    expect(classifyRunFreshness({ generatedAt: "2026-10-20T00:05:00.000Z" }, [], NOW, 30)).toEqual({
      state: "fresh",
    });
  });

  test("declares a run without a date stale rather than fresh forever", () => {
    expect(classifyRunFreshness({ generatedAt: null }, [], NOW, 30)).toEqual({
      state: "stale",
      reason: "unknown-date",
    });
    expect(classifyRunFreshness({ generatedAt: "not-a-date" }, [], NOW, 30)).toEqual({
      state: "stale",
      reason: "unknown-date",
    });
    expect(classifyRunFreshness({ generatedAt: "2026-13-45T00:00:00.000Z" }, [], NOW, 30)).toEqual({
      state: "stale",
      reason: "unknown-date",
    });
  });

  test("ignores earnings dates before the run date", () => {
    expect(
      classifyRunFreshness({ generatedAt: "2026-10-19T12:00:00.000Z" }, ["2026-10-01"], NOW, 30),
    ).toEqual({ state: "fresh" });
  });
});

describe("instrumentFreshness", () => {
  test("maps the never-run input to never-run", () => {
    expect(instrumentFreshness({ state: "never-run" }, NOW, 30)).toEqual({ state: "never-run" });
  });

  test("is undefined for an unavailable index, stale unknown-date without a timestamp", () => {
    expect(instrumentFreshness({ state: "index-unavailable" }, NOW, 30)).toBeUndefined();
    expect(instrumentFreshness({ state: "available", earningsDates: [] }, NOW, 30)).toEqual({
      state: "stale",
      reason: "unknown-date",
    });
  });

  test("classifies an available input with its timestamp and dates", () => {
    expect(
      instrumentFreshness(
        {
          state: "available",
          latestRunAt: "2026-10-15T12:00:00.000Z",
          earningsDates: ["2026-10-18"],
        },
        NOW,
        30,
      ),
    ).toEqual({ state: "stale", reason: "earnings", since: "2026-10-18" });
  });
});
