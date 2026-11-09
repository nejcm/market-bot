import { describe, expect, test } from "bun:test";
import { ASSET_CLASSES, JOB_TYPES } from "../src/domain/job-type";
import { isAssetClass, isJobType } from "../src/run-artifact-value-guards";

describe("run artifact value guards", () => {
  test("isJobType accepts exactly the JobType union", () => {
    expect(JOB_TYPES.filter((value) => isJobType(value))).toEqual([...JOB_TYPES]);
    expect(JOB_TYPES).toHaveLength(8);
    for (const value of ["score", "calibration", "Equity", "", undefined, null, 1]) {
      expect(isJobType(value)).toBe(false);
    }
  });

  test("isAssetClass accepts exactly the AssetClass union", () => {
    expect(ASSET_CLASSES.filter((value) => isAssetClass(value))).toEqual(["equity", "crypto"]);
    for (const value of ["forex", "Crypto", "", undefined, null, 0]) {
      expect(isAssetClass(value)).toBe(false);
    }
  });
});
