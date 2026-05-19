import { describe, expect, test } from "bun:test";
import { createOpenAIProvider } from "../src/model/openai";

describe("createOpenAIProvider", () => {
  test("posts chat completion requests and reads content", async () => {
    const requests: Request[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push(new Request(input, init));
      return Response.json({
        choices: [{ message: { content: "{\"summary\":\"ok\"}" } }],
        usage: { total_tokens: 12 },
      });
    };

    const provider = createOpenAIProvider(
      {
        provider: "openai",
        apiKey: "test-key",
        quickModel: "quick",
        synthesisModel: "synthesis",
        dataDir: "data/runs",
        sourceOptions: {
          equityMoverLimit: 5,
          cryptoMoverLimit: 5,
          newsLimit: 8,
        },
      },
      fetchImpl,
    );

    const response = await provider.generate({
      model: "synthesis",
      responseFormat: "json",
      messages: [{ role: "user", content: "Return JSON" }],
    });

    expect(response).toEqual({
      content: "{\"summary\":\"ok\"}",
      tokenEstimate: 12,
      costEstimateUsd: 0,
    });
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer test-key");
    await expect(requests[0]?.json()).resolves.toMatchObject({
      model: "synthesis",
      response_format: { type: "json_object" },
    });
  });
});
