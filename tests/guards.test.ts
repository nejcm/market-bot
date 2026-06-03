import { describe, expect, test } from "bun:test";
import {
  nonEmptyStringArrayValue,
  numberAt,
  readStringArray,
  stringArrayValue,
} from "../src/sources/guards";

describe("source guards", () => {
  test("reads nested finite numbers with zero fallback", () => {
    const record = {
      analytics: {
        evidenceQuality: {
          itemCount: 3,
          gapCount: Number.NaN,
        },
      },
    };

    expect(numberAt(record, ["analytics", "evidenceQuality", "itemCount"])).toBe(3);
    expect(numberAt(record, ["analytics", "evidenceQuality", "gapCount"])).toBe(0);
    expect(numberAt(record, ["analytics", "missing"])).toBe(0);
  });

  test("strict string array reader rejects mixed arrays", () => {
    expect(readStringArray({ sourceIds: ["a", "b"] }, "sourceIds")).toEqual(["a", "b"]);
    expect(readStringArray({ sourceIds: ["a", 1] }, "sourceIds")).toBeUndefined();
    expect(readStringArray({ sourceIds: "a" }, "sourceIds")).toBeUndefined();
  });

  test("string array value filters non-strings", () => {
    expect(stringArrayValue(["a", 1, "b", undefined])).toEqual(["a", "b"]);
    expect(stringArrayValue("a")).toEqual([]);
  });

  test("non-empty string array value filters blank strings", () => {
    expect(nonEmptyStringArrayValue(["a", "", "  ", " b "])).toEqual(["a", " b "]);
  });
});
