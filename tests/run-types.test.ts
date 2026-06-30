import { describe, expect, test } from "bun:test";
import { isInstrumentJobType, type JobType } from "../src/domain/types";
import {
  RUN_TYPE_REGISTRY,
  isResearchJobType,
  runTypeFixedAssetClass,
  runTypeProducesSynthesisReport,
  runTypeSupportsAsset,
  runTypeSupportsDepth,
  runTypeSupportsEvidenceRequest,
  runTypeSupportsWebGather,
  type ResearchJobType,
} from "../src/domain/run-types";

const RESEARCH_JOB_TYPES: readonly ResearchJobType[] = [
  "market-overview",
  "daily",
  "weekly",
  "equity",
  "crypto",
  "alpha-search",
  "research",
];

const OPERATIONAL_JOB_TYPES = [
  "score",
  "calibration",
  "cache-prune",
  "provider-health",
  "history-backfill",
] as const;

describe("RUN_TYPE_REGISTRY", () => {
  test("has exactly the seven research job types as keys", () => {
    expect(Object.keys(RUN_TYPE_REGISTRY).toSorted()).toEqual(RESEARCH_JOB_TYPES.toSorted());
  });

  test("isInstrument never drifts from the domain type guard", () => {
    for (const jobType of RESEARCH_JOB_TYPES) {
      expect(RUN_TYPE_REGISTRY[jobType].isInstrument).toBe(isInstrumentJobType(jobType as JobType));
    }
  });

  test("declares required, fixed, and none asset argument modes", () => {
    expect(RUN_TYPE_REGISTRY["market-overview"].assetArg).toBe("required");
    expect(RUN_TYPE_REGISTRY["alpha-search"].assetArg).toEqual({ fixed: "equity" });
    expect(RUN_TYPE_REGISTRY.equity.assetArg).toBe("none");
  });
});

describe("runTypeSupportsAsset", () => {
  test("true only for daily, weekly, market-overview", () => {
    expect(runTypeSupportsAsset("daily")).toBe(true);
    expect(runTypeSupportsAsset("weekly")).toBe(true);
    expect(runTypeSupportsAsset("market-overview")).toBe(true);
  });

  test("false for instrument, alpha-search, research", () => {
    expect(runTypeSupportsAsset("equity")).toBe(false);
    expect(runTypeSupportsAsset("crypto")).toBe(false);
    expect(runTypeSupportsAsset("alpha-search")).toBe(false);
    expect(runTypeSupportsAsset("research")).toBe(false);
  });

  test("false for operational job types", () => {
    for (const jobType of OPERATIONAL_JOB_TYPES) {
      expect(runTypeSupportsAsset(jobType)).toBe(false);
    }
  });
});

describe("runTypeFixedAssetClass", () => {
  test("returns fixed assets only for fixed-asset run types", () => {
    expect(runTypeFixedAssetClass("alpha-search")).toBe("equity");
    expect(runTypeFixedAssetClass("market-overview")).toBeUndefined();
    expect(runTypeFixedAssetClass("equity")).toBeUndefined();
    expect(runTypeFixedAssetClass("score")).toBeUndefined();
  });
});

describe("runTypeSupportsDepth", () => {
  test("true for all seven research job types", () => {
    for (const jobType of RESEARCH_JOB_TYPES) {
      expect(runTypeSupportsDepth(jobType)).toBe(true);
    }
  });

  test("false for operational job types", () => {
    for (const jobType of OPERATIONAL_JOB_TYPES) {
      expect(runTypeSupportsDepth(jobType)).toBe(false);
    }
  });
});

describe("runTypeSupportsWebGather", () => {
  test("true only for equity, crypto, research", () => {
    expect(runTypeSupportsWebGather("equity")).toBe(true);
    expect(runTypeSupportsWebGather("crypto")).toBe(true);
    expect(runTypeSupportsWebGather("research")).toBe(true);
  });

  test("false for market updates, alpha-search, and operational types", () => {
    expect(runTypeSupportsWebGather("market-overview")).toBe(false);
    expect(runTypeSupportsWebGather("daily")).toBe(false);
    expect(runTypeSupportsWebGather("weekly")).toBe(false);
    expect(runTypeSupportsWebGather("alpha-search")).toBe(false);
    for (const jobType of OPERATIONAL_JOB_TYPES) {
      expect(runTypeSupportsWebGather(jobType)).toBe(false);
    }
  });
});

describe("runTypeSupportsEvidenceRequest", () => {
  test("true only for equity", () => {
    expect(runTypeSupportsEvidenceRequest("equity")).toBe(true);
  });

  test("false for crypto, research, market updates, and operational types", () => {
    expect(runTypeSupportsEvidenceRequest("crypto")).toBe(false);
    expect(runTypeSupportsEvidenceRequest("research")).toBe(false);
    expect(runTypeSupportsEvidenceRequest("market-overview")).toBe(false);
    expect(runTypeSupportsEvidenceRequest("daily")).toBe(false);
    expect(runTypeSupportsEvidenceRequest("weekly")).toBe(false);
    expect(runTypeSupportsEvidenceRequest("alpha-search")).toBe(false);
    for (const jobType of OPERATIONAL_JOB_TYPES) {
      expect(runTypeSupportsEvidenceRequest(jobType)).toBe(false);
    }
  });
});

describe("isResearchJobType", () => {
  test("true for every research job type", () => {
    for (const jobType of RESEARCH_JOB_TYPES) {
      expect(isResearchJobType(jobType)).toBe(true);
    }
  });

  test("false for operational job types and unknown strings", () => {
    for (const jobType of OPERATIONAL_JOB_TYPES) {
      expect(isResearchJobType(jobType)).toBe(false);
    }
    expect(isResearchJobType("history-search")).toBe(false);
    expect(isResearchJobType("")).toBe(false);
  });
});

describe("runTypeProducesSynthesisReport", () => {
  test("true for every research job type except alpha-search", () => {
    for (const jobType of RESEARCH_JOB_TYPES) {
      expect(runTypeProducesSynthesisReport(jobType)).toBe(jobType !== "alpha-search");
    }
  });

  test("false for operational job types", () => {
    for (const jobType of OPERATIONAL_JOB_TYPES) {
      expect(runTypeProducesSynthesisReport(jobType)).toBe(false);
    }
  });
});
