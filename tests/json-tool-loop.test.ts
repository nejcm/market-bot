import { describe, expect, test } from "bun:test";
import { sourceGap } from "../src/domain/source-gaps";
import { runJsonToolLoop, type JsonToolLoopStageOutput } from "../src/research/json-tool-loop";

interface TestState {
  readonly executed: readonly string[];
  readonly gaps: readonly string[];
}

interface TestRequest {
  readonly tool: "lookup";
}

interface TestAudit {
  readonly round: number;
  readonly tool: string;
  readonly status: "accepted" | "rejected";
  readonly sourceUnits?: number;
}

type TestStage = JsonToolLoopStageOutput & { readonly stage: "test-loop" };

describe("runJsonToolLoop", () => {
  test("runs dependent rounds and aggregates audit counters", async () => {
    const priorStageCounts: number[] = [];

    const result = await runJsonToolLoop<TestState, TestRequest, "lookup", TestStage, TestAudit>({
      options: { maxRounds: 2, maxToolCalls: 2, sourceBudget: 4 },
      initialState: { executed: [], gaps: [] },
      invalidJsonMessage: "invalid json",
      invalidShapeMessage: "invalid shape",
      malformedGap: (message) =>
        sourceGap({
          source: "test-loop",
          message,
          capability: "research-gather",
          cause: "malformed-response",
          evidenceQualityImpact: "no-cap",
        }),
      generateRound: async (_state, roundState) => {
        priorStageCounts.push(roundState.priorStages.length);
        return {
          stage: "test-loop",
          content:
            roundState.round === 1
              ? JSON.stringify({ requests: [{ tool: "lookup" }] })
              : JSON.stringify({ requests: [] }),
          tokenEstimate: 1,
          costEstimateUsd: 0,
        };
      },
      validateRequests: (requests, roundState) => ({
        requests:
          requests.length === 0
            ? []
            : [
                {
                  request: { tool: "lookup" },
                  audit: {
                    round: roundState.round,
                    tool: "lookup",
                    status: "accepted",
                    sourceUnits: 2,
                  },
                  sourceUnits: 2,
                  tool: "lookup",
                },
              ],
        rejected: [],
        gaps: [],
      }),
      mergeGaps: (state, gaps) => ({
        ...state,
        gaps: [...state.gaps, ...gaps.map((gap) => gap.message)],
      }),
      executeRequest: async (state, request) => ({
        state: { ...state, executed: [...state.executed, request.tool] },
        gaps: [],
      }),
    });

    expect(result.state.executed).toEqual(["lookup"]);
    expect(priorStageCounts).toEqual([0, 1]);
    expect(result.audit).toMatchObject({
      rounds: 2,
      sourceUnitsUsed: 2,
      executedTools: ["lookup"],
      emittedGaps: [],
    });
    expect(result.audit.acceptedRequests).toHaveLength(1);
  });

  test("emits malformed gap and stops on invalid JSON", async () => {
    const result = await runJsonToolLoop<TestState, TestRequest, "lookup", TestStage, TestAudit>({
      options: { maxRounds: 2, maxToolCalls: 2, sourceBudget: 4 },
      initialState: { executed: [], gaps: [] },
      invalidJsonMessage: "invalid json",
      invalidShapeMessage: "invalid shape",
      malformedGap: (message) =>
        sourceGap({
          source: "test-loop",
          message,
          capability: "research-gather",
          cause: "malformed-response",
          evidenceQualityImpact: "no-cap",
        }),
      generateRound: async () => ({
        stage: "test-loop",
        content: "not-json",
        tokenEstimate: 1,
        costEstimateUsd: 0,
      }),
      validateRequests: () => ({ requests: [], rejected: [], gaps: [] }),
      mergeGaps: (state, gaps) => ({
        ...state,
        gaps: [...state.gaps, ...gaps.map((gap) => gap.message)],
      }),
      executeRequest: async (state) => ({ state, gaps: [] }),
    });

    expect(result.stageOutputs).toHaveLength(1);
    expect(result.state.gaps).toEqual(["invalid json"]);
    expect(result.audit.emittedGaps).toEqual([
      expect.objectContaining({ message: "invalid json" }),
    ]);
  });
});
