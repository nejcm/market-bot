import { describe, expect, test } from "bun:test";
import { type CacheEntry, selectDateDirEntries } from "../scripts/fixture-cache-selection";

function entry(cacheKey: string, fetchedAt: string): CacheEntry {
  return { cacheKey, adapter: "test", fetchedAt, payload: `payload-${fetchedAt}` };
}

describe("fixture date-dir cache selection", () => {
  const startedAt = "2026-10-10T18:51:21.658Z";

  test("keeps earlier same-day entries and the entry at the cutoff", () => {
    const selected = selectDateDirEntries(
      [entry("earlier", "2026-10-10T12:01:54.856Z"), entry("at-cutoff", startedAt)],
      startedAt,
    );

    expect(selected.map((candidate) => candidate.cacheKey)).toEqual(["earlier", "at-cutoff"]);
  });

  test("rejects an entry fetched after the cutoff", () => {
    const selected = selectDateDirEntries(
      [entry("before", "2026-10-10T18:00:00.000Z"), entry("after", "2026-10-10T18:51:21.659Z")],
      startedAt,
    );

    expect(selected.map((candidate) => candidate.cacheKey)).toEqual(["before"]);
  });

  test("keeps the latest fetch per cacheKey", () => {
    const selected = selectDateDirEntries(
      [
        entry("shared", "2026-10-10T12:01:54.856Z"),
        entry("shared", startedAt),
        entry("other", "2026-10-10T12:01:54.856Z"),
      ],
      startedAt,
    );

    expect(selected.map((candidate) => candidate.cacheKey)).toEqual(["shared", "other"]);
    expect(selected.find((candidate) => candidate.cacheKey === "shared")?.fetchedAt).toBe(
      startedAt,
    );
  });
});
