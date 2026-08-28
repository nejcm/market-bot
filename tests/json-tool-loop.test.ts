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

function testGap(message: string) {
  return sourceGap({
    source: "test-loop",
    message,
    capability: "evidence-request",
    cause: "malformed-response",
    evidenceQualityImpact: "no-cap",
  });
}

function testStage(content: string): TestStage {
  return {
    stage: "test-loop",
    content,
    tokenEstimate: 1,
    costEstimateUsd: 0,
  };
}

describe("runJsonToolLoop", () => {
  test("runs dependent rounds and aggregates audit counters", async () => {
    const priorStageCounts: number[] = [];
    const validationPriorStageCounts: number[] = [];

    const result = await runJsonToolLoop<TestState, TestRequest, "lookup", TestStage, TestAudit>({
      options: { maxRounds: 2, maxToolCalls: 2, sourceBudget: 4 },
      initialState: { executed: [], gaps: [] },
      invalidJsonMessage: "invalid json",
      invalidShapeMessage: "invalid shape",
      malformedGap: testGap,
      generateRound: async (_state, roundState) => {
        priorStageCounts.push(roundState.priorStages.length);
        const content =
          roundState.round === 1
            ? JSON.stringify({ requests: [{ tool: "lookup" }] })
            : JSON.stringify({ requests: [] });
        return testStage(content);
      },
      validateRequests: (requests, roundState) => {
        validationPriorStageCounts.push(roundState.priorStages.length);
        return {
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
        };
      },
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
    expect(validationPriorStageCounts).toEqual([0]);
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
      malformedGap: testGap,
      generateRound: async () => testStage("not-json"),
      validateRequests: () => ({ requests: [], rejected: [], gaps: [] }),
      mergeGaps: (state, gaps) => ({
        ...state,
        gaps: [...state.gaps, ...gaps.map((gap) => gap.message)],
      }),
      executeRequest: async (state) => ({ state, gaps: [] }),
    });

    expect(result.stageOutputs).toHaveLength(1);
    expect(result.state.gaps).toEqual(["invalid json"]);
    expect(result.parseRetriesExhausted).toBe(true);
    expect(result.audit.emittedGaps).toEqual([
      expect.objectContaining({ message: "invalid json" }),
    ]);
  });

  test("emits malformed gap and stops on valid JSON with wrong shape", async () => {
    const result = await runJsonToolLoop<TestState, TestRequest, "lookup", TestStage, TestAudit>({
      options: { maxRounds: 2, maxToolCalls: 2, sourceBudget: 4 },
      initialState: { executed: [], gaps: [] },
      invalidJsonMessage: "invalid json",
      invalidShapeMessage: "invalid shape",
      malformedGap: testGap,
      generateRound: async () => testStage(JSON.stringify([{ tool: "lookup" }])),
      validateRequests: () => ({ requests: [], rejected: [], gaps: [] }),
      mergeGaps: (state, gaps) => ({
        ...state,
        gaps: [...state.gaps, ...gaps.map((gap) => gap.message)],
      }),
      executeRequest: async (state) => ({ state, gaps: [] }),
    });

    expect(result.stageOutputs).toHaveLength(1);
    expect(result.state.gaps).toEqual(["invalid shape"]);
    expect(result.parseRetriesExhausted).toBe(true);
    expect(result.audit.emittedGaps).toEqual([
      expect.objectContaining({ message: "invalid shape" }),
    ]);
  });

  test("retries once on invalid JSON then continues without a malformed gap", async () => {
    let modelCalls = 0;
    const retryPriorContents: string[] = [];

    const result = await runJsonToolLoop<TestState, TestRequest, "lookup", TestStage, TestAudit>({
      options: { maxRounds: 2, maxToolCalls: 2, sourceBudget: 4, maxParseRetries: 1 },
      initialState: { executed: [], gaps: [] },
      invalidJsonMessage: "invalid json",
      invalidShapeMessage: "invalid shape",
      malformedGap: testGap,
      generateRound: async (_state, roundState) => {
        modelCalls += 1;
        retryPriorContents.push(roundState.priorStages[0]?.content ?? "");
        return modelCalls === 1
          ? testStage("not-json")
          : testStage(JSON.stringify({ requests: [{ tool: "lookup" }] }));
      },
      validateRequests: (_requests, roundState) => ({
        requests: [
          {
            request: { tool: "lookup" },
            audit: { round: roundState.round, tool: "lookup", status: "accepted", sourceUnits: 2 },
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

    expect(modelCalls).toBe(2);
    expect(result.parseRetriesExhausted).toBeUndefined();
    expect(result.audit.emittedGaps).toEqual([]);
    expect(result.state.executed).toEqual(["lookup"]);
    expect(retryPriorContents[1]).toContain("Parse failure: invalid json");
    expect(retryPriorContents[1]).toContain("not-json");
  });

  test("treats the first unparseable round as exhausted when no parse retry remains", async () => {
    let modelCalls = 0;

    const result = await runJsonToolLoop<TestState, TestRequest, "lookup", TestStage, TestAudit>({
      options: { maxRounds: 3, maxToolCalls: 2, sourceBudget: 4, maxParseRetries: 1 },
      initialState: { executed: [], gaps: [] },
      invalidJsonMessage: "invalid json",
      invalidShapeMessage: "invalid shape",
      malformedGap: testGap,
      generateRound: async () => {
        modelCalls += 1;
        return testStage("not-json");
      },
      validateRequests: () => ({ requests: [], rejected: [], gaps: [] }),
      mergeGaps: (state, gaps) => ({
        ...state,
        gaps: [...state.gaps, ...gaps.map((gap) => gap.message)],
      }),
      executeRequest: async (state) => ({ state, gaps: [] }),
    });

    expect(modelCalls).toBe(2);
    expect(result.stageOutputs).toHaveLength(2);
    expect(result.parseRetriesExhausted).toBe(true);
    expect(result.audit.emittedGaps).toEqual([
      expect.objectContaining({ message: "invalid json" }),
    ]);
  });

  test("returns immediately when max rounds is zero", async () => {
    let roundsGenerated = 0;

    const result = await runJsonToolLoop<TestState, TestRequest, "lookup", TestStage, TestAudit>({
      options: { maxRounds: 0, maxToolCalls: 2, sourceBudget: 4 },
      initialState: { executed: [], gaps: [] },
      invalidJsonMessage: "invalid json",
      invalidShapeMessage: "invalid shape",
      malformedGap: testGap,
      generateRound: async () => {
        roundsGenerated += 1;
        return testStage(JSON.stringify({ requests: [{ tool: "lookup" }] }));
      },
      validateRequests: () => ({ requests: [], rejected: [], gaps: [] }),
      mergeGaps: (state) => state,
      executeRequest: async (state) => ({ state, gaps: [] }),
    });

    expect(roundsGenerated).toBe(0);
    expect(result.stageOutputs).toEqual([]);
    expect(result.audit.rounds).toBe(0);
  });

  test("stops after tool-call budget is exhausted", async () => {
    const result = await runJsonToolLoop<TestState, TestRequest, "lookup", TestStage, TestAudit>({
      options: { maxRounds: 3, maxToolCalls: 1, sourceBudget: 9 },
      initialState: { executed: [], gaps: [] },
      invalidJsonMessage: "invalid json",
      invalidShapeMessage: "invalid shape",
      malformedGap: testGap,
      generateRound: async () => testStage(JSON.stringify({ requests: [{ tool: "lookup" }] })),
      validateRequests: (_requests, roundState) => ({
        requests: [
          {
            request: { tool: "lookup" },
            audit: { round: roundState.round, tool: "lookup", status: "accepted", sourceUnits: 1 },
            sourceUnits: 1,
            tool: "lookup",
          },
        ],
        rejected: [],
        gaps: [],
      }),
      mergeGaps: (state) => state,
      executeRequest: async (state, request) => ({
        state: { ...state, executed: [...state.executed, request.tool] },
        gaps: [],
      }),
    });

    expect(result.stageOutputs).toHaveLength(1);
    expect(result.audit.sourceUnitsUsed).toBe(1);
    expect(result.audit.executedTools).toEqual(["lookup"]);
  });

  test("does not execute over-admitted requests beyond tool-call budget", async () => {
    const result = await runJsonToolLoop<TestState, TestRequest, "lookup", TestStage, TestAudit>({
      options: { maxRounds: 3, maxToolCalls: 1, sourceBudget: 9 },
      initialState: { executed: [], gaps: [] },
      invalidJsonMessage: "invalid json",
      invalidShapeMessage: "invalid shape",
      malformedGap: testGap,
      generateRound: async () =>
        testStage(JSON.stringify({ requests: [{ tool: "lookup" }, { tool: "lookup" }] })),
      validateRequests: (_requests, roundState) => ({
        requests: [
          {
            request: { tool: "lookup" },
            audit: { round: roundState.round, tool: "lookup", status: "accepted", sourceUnits: 1 },
            sourceUnits: 1,
            tool: "lookup",
          },
          {
            request: { tool: "lookup" },
            audit: { round: roundState.round, tool: "lookup", status: "accepted", sourceUnits: 1 },
            sourceUnits: 1,
            tool: "lookup",
          },
        ],
        rejected: [],
        gaps: [],
      }),
      mergeGaps: (state) => state,
      executeRequest: async (state, request) => ({
        state: { ...state, executed: [...state.executed, request.tool] },
        gaps: [],
      }),
    });

    expect(result.state.executed).toEqual(["lookup"]);
    expect(result.audit.sourceUnitsUsed).toBe(1);
    expect(result.audit.acceptedRequests).toHaveLength(1);
    expect(result.audit.executedTools).toEqual(["lookup"]);
  });

  test("stops after source budget is exhausted", async () => {
    const result = await runJsonToolLoop<TestState, TestRequest, "lookup", TestStage, TestAudit>({
      options: { maxRounds: 3, maxToolCalls: 9, sourceBudget: 2 },
      initialState: { executed: [], gaps: [] },
      invalidJsonMessage: "invalid json",
      invalidShapeMessage: "invalid shape",
      malformedGap: testGap,
      generateRound: async () => testStage(JSON.stringify({ requests: [{ tool: "lookup" }] })),
      validateRequests: (_requests, roundState) => ({
        requests: [
          {
            request: { tool: "lookup" },
            audit: { round: roundState.round, tool: "lookup", status: "accepted", sourceUnits: 2 },
            sourceUnits: 2,
            tool: "lookup",
          },
        ],
        rejected: [],
        gaps: [],
      }),
      mergeGaps: (state) => state,
      executeRequest: async (state, request) => ({
        state: { ...state, executed: [...state.executed, request.tool] },
        gaps: [],
      }),
    });

    expect(result.stageOutputs).toHaveLength(1);
    expect(result.audit.sourceUnitsUsed).toBe(2);
    expect(result.state.executed).toEqual(["lookup"]);
  });

  test("does not execute over-admitted requests beyond source budget", async () => {
    const result = await runJsonToolLoop<TestState, TestRequest, "lookup", TestStage, TestAudit>({
      options: { maxRounds: 3, maxToolCalls: 9, sourceBudget: 2 },
      initialState: { executed: [], gaps: [] },
      invalidJsonMessage: "invalid json",
      invalidShapeMessage: "invalid shape",
      malformedGap: testGap,
      generateRound: async () =>
        testStage(JSON.stringify({ requests: [{ tool: "lookup" }, { tool: "lookup" }] })),
      validateRequests: (_requests, roundState) => ({
        requests: [
          {
            request: { tool: "lookup" },
            audit: { round: roundState.round, tool: "lookup", status: "accepted", sourceUnits: 2 },
            sourceUnits: 2,
            tool: "lookup",
          },
          {
            request: { tool: "lookup" },
            audit: { round: roundState.round, tool: "lookup", status: "accepted", sourceUnits: 1 },
            sourceUnits: 1,
            tool: "lookup",
          },
        ],
        rejected: [],
        gaps: [],
      }),
      mergeGaps: (state) => state,
      executeRequest: async (state, request) => ({
        state: { ...state, executed: [...state.executed, request.tool] },
        gaps: [],
      }),
    });

    expect(result.state.executed).toEqual(["lookup"]);
    expect(result.audit.sourceUnitsUsed).toBe(2);
    expect(result.audit.acceptedRequests).toHaveLength(1);
    expect(result.audit.executedTools).toEqual(["lookup"]);
  });

  test("threads budget counters across rounds and stops when exhausted", async () => {
    const validationToolCallsSeen: number[] = [];

    const result = await runJsonToolLoop<TestState, TestRequest, "lookup", TestStage, TestAudit>({
      options: { maxRounds: 3, maxToolCalls: 2, sourceBudget: 9 },
      initialState: { executed: [], gaps: [] },
      invalidJsonMessage: "invalid json",
      invalidShapeMessage: "invalid shape",
      malformedGap: testGap,
      generateRound: async () => testStage(JSON.stringify({ requests: [{ tool: "lookup" }] })),
      validateRequests: (_requests, roundState) => {
        validationToolCallsSeen.push(roundState.toolCallsUsed);
        return {
          requests: [
            {
              request: { tool: "lookup" },
              audit: {
                round: roundState.round,
                tool: "lookup",
                status: "accepted",
                sourceUnits: 1,
              },
              sourceUnits: 1,
              tool: "lookup",
            },
          ],
          rejected: [],
          gaps: [],
        };
      },
      mergeGaps: (state) => state,
      executeRequest: async (state, request) => ({
        state: { ...state, executed: [...state.executed, request.tool] },
        gaps: [],
      }),
    });

    expect(validationToolCallsSeen).toEqual([0, 1]);
    expect(result.stageOutputs).toHaveLength(2);
    expect(result.state.executed).toEqual(["lookup", "lookup"]);
    expect(result.audit.executedTools).toEqual(["lookup", "lookup"]);
    expect(result.audit.acceptedRequests).toHaveLength(2);
  });

  test("accumulates rejected requests and emitted validation gaps", async () => {
    const result = await runJsonToolLoop<TestState, TestRequest, "lookup", TestStage, TestAudit>({
      options: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 },
      initialState: { executed: [], gaps: [] },
      invalidJsonMessage: "invalid json",
      invalidShapeMessage: "invalid shape",
      malformedGap: testGap,
      generateRound: async () => testStage(JSON.stringify({ requests: [{ tool: "lookup" }] })),
      validateRequests: (_requests, roundState) => ({
        requests: [],
        rejected: [{ round: roundState.round, tool: "lookup", status: "rejected" }],
        gaps: [testGap("validation failed")],
      }),
      mergeGaps: (state, gaps) => ({
        ...state,
        gaps: [...state.gaps, ...gaps.map((gap) => gap.message)],
      }),
      executeRequest: async (state) => ({ state, gaps: [] }),
    });

    expect(result.state.executed).toEqual([]);
    expect(result.state.gaps).toEqual(["validation failed"]);
    expect(result.audit.rejectedRequests).toEqual([
      { round: 1, tool: "lookup", status: "rejected" },
    ]);
    expect(result.audit.emittedGaps).toEqual([
      expect.objectContaining({ message: "validation failed" }),
    ]);
  });
});
