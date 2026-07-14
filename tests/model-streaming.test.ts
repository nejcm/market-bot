import { describe, expect, test } from "bun:test";
import type { AppConfig, ProviderName } from "../src/config";
import { createAnthropicProvider } from "../src/model/anthropic";
import { createOpenAIProvider } from "../src/model/openai";

function config(provider: ProviderName): AppConfig {
  return {
    provider,
    apiKey: "test-key",
    ...(provider === "openai-compatible" ? { baseUrl: "http://localhost:11434/v1" } : {}),
    quickModel: "quick",
    synthesisModel: "synthesis",
    modelTimeoutMs: 5000,
    dataDir: "data/runs",
    promptDir: "prompts",
    sourceOptions: {
      equityMoverLimit: 5,
      cryptoMoverLimit: 5,
      newsLimit: 8,
      sourceTimeoutMs: 1000,
    },
    evidenceRequestOptions: { maxRounds: 0, maxToolCalls: 0, sourceBudget: 0 },
    webGatherOptions: { maxRounds: 0, maxToolCalls: 0, sourceBudget: 0 },
    webGatherDisabled: false,
    webProfileReuseDaysBySubjectKind: { company: 30, "crypto-asset": 7, theme: 7 },
    alphaSearchOptions: {
      apeWisdomFilter: "all-stocks",
      apeWisdomBriefPageLimit: 5,
      apeWisdomDeepPageLimit: 10,
      validationCandidateLimit: 25,
      leadLimit: 15,
      topCandidateLimit: 15,
      secDiscoveryLimit: 25,
      secFormTypes: ["S-1", "F-1", "8-K", "6-K"],
      minPrice: 0.5,
      minVolume: 100_000,
      minMarketCap: 50_000_000,
      maxMarketCap: 10_000_000_000,
    },
  };
}

function byteStream(
  chunks: readonly Uint8Array[],
  onCancel?: () => void,
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller): void {
      const chunk = chunks[index++];
      if (chunk === undefined) {
        controller.close();
      } else {
        controller.enqueue(chunk);
      }
    },
    cancel(): void {
      onCancel?.();
    },
  });
}

function splitBytes(bytes: Uint8Array, indexes: readonly number[]): readonly Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (const end of indexes) {
    chunks.push(bytes.slice(start, end));
    start = end;
  }
  chunks.push(bytes.slice(start));
  return chunks;
}

async function readChunks(stream: ReadableStream<string>): Promise<readonly string[]> {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("OpenAI streaming", () => {
  test("decodes fragmented CRLF SSE frames and split UTF-8 text deltas", async () => {
    const requests: Request[] = [];
    const sse =
      `data: ${JSON.stringify({ choices: [{ delta: { content: "café " } }] })}\r\n\r\n` +
      `data: ${JSON.stringify({ choices: [{ delta: { content: "🙂" } }] })}\r\n\r\n` +
      "data: [DONE]\r\n\r\n";
    const bytes = new TextEncoder().encode(sse);
    const emojiStart = bytes.indexOf(240);
    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      requests.push(new Request(input, init));
      return new Response(byteStream(splitBytes(bytes, [1, 7, emojiStart + 1, bytes.length - 3])));
    };
    const provider = createOpenAIProvider(config("openai"), fetchImpl);

    const chunks = await readChunks(
      await provider.generateStream({
        model: "quick",
        messages: [{ role: "user", content: "stream" }],
        params: { max_completion_tokens: 32 },
      }),
    );

    expect(chunks).toEqual(["café ", "🙂"]);
    await expect(requests[0]?.json()).resolves.toMatchObject({
      model: "quick",
      stream: true,
      max_completion_tokens: 32,
    });
  });

  test("surfaces malformed, empty, and non-OK streams", async () => {
    let malformedCancelled = false;
    const malformedRequest: { signal?: AbortSignal } = {};
    const malformedBody = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode("data: nope\n\n"));
      },
      cancel(): void {
        malformedCancelled = true;
      },
    });
    const malformed = createOpenAIProvider(config("openai"), async (_input, init) => {
      if (init?.signal !== undefined && init.signal !== null) {
        malformedRequest.signal = init.signal;
      }
      return new Response(malformedBody);
    });
    await expect(
      readChunks(await malformed.generateStream({ model: "quick", messages: [] })),
    ).rejects.toThrow("malformed JSON");
    expect(malformedCancelled).toBe(true);
    expect(malformedRequest.signal?.aborted).toBe(true);

    const empty = createOpenAIProvider(
      config("openai"),
      async () => new Response("data: [DONE]\n\n"),
    );
    await expect(
      readChunks(await empty.generateStream({ model: "quick", messages: [] })),
    ).rejects.toThrow("did not include content");

    const failed = createOpenAIProvider(
      config("openai-compatible"),
      async () => new Response("bad", { status: 429 }),
    );
    await expect(failed.generateStream({ model: "quick", messages: [] })).rejects.toThrow(
      "status 429",
    );
  });

  test("bounds complete and multiline SSE frames", async () => {
    const oversizedLine = createOpenAIProvider(
      config("openai"),
      async () => new Response(`data: ${"x".repeat(1_048_577)}\n\n`),
    );
    await expect(
      readChunks(await oversizedLine.generateStream({ model: "quick", messages: [] })),
    ).rejects.toThrow("maximum buffer size");

    const multiline = `${Array.from({ length: 1025 }, () => `data: ${"x".repeat(1024)}\n`).join("")}\n`;
    const oversizedFrame = createOpenAIProvider(
      config("openai"),
      async () => new Response(multiline),
    );
    await expect(
      readChunks(await oversizedFrame.generateStream({ model: "quick", messages: [] })),
    ).rejects.toThrow("maximum buffer size");
  });

  test("rejects unsupported streaming modes and aborts on cancellation", async () => {
    let bodyCancelled = false;
    const requestState: { signal?: AbortSignal } = {};
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(
          new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'),
        );
      },
      cancel(): void {
        bodyCancelled = true;
      },
    });
    const provider = createOpenAIProvider(config("openai"), async (_input, init) => {
      if (init?.signal !== undefined && init.signal !== null) {
        requestState.signal = init.signal;
      }
      return new Response(body);
    });
    const stream = await provider.generateStream({ model: "quick", messages: [] });
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();

    expect(bodyCancelled).toBe(true);
    expect(requestState.signal?.aborted).toBe(true);

    const negotiationController = new AbortController();
    const negotiationState: { signal?: AbortSignal } = {};
    const negotiating = createOpenAIProvider(config("openai"), async (_input, init) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        throw new Error("missing request signal");
      }
      negotiationState.signal = signal;
      return new Promise<Response>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const negotiation = negotiating.generateStream({
      model: "quick",
      messages: [],
      signal: negotiationController.signal,
    });
    await Bun.sleep(0);
    negotiationController.abort();
    await expect(negotiation).rejects.toMatchObject({ name: "AbortError" });
    expect(negotiationState.signal?.aborted).toBe(true);

    await expect(
      provider.generateStream({ model: "quick", messages: [], responseFormat: "json" }),
    ).rejects.toThrow("does not support JSON");
    await expect(
      provider.generateStream({ model: "quick", messages: [], webSearch: true }),
    ).rejects.toThrow("does not support web search");
  });
});

describe("Anthropic streaming", () => {
  test("emits only Messages API text deltas and stops normally", async () => {
    const requests: Request[] = [];
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start" })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ delta: { type: "thinking_delta", thinking: "hidden" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ delta: { type: "text_delta", text: "Hello" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ delta: { type: "text_delta", text: " world" } })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ].join("");
    const provider = createAnthropicProvider(config("anthropic"), async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(byteStream(splitBytes(new TextEncoder().encode(sse), [2, 19, 87])));
    });

    expect(
      await readChunks(await provider.generateStream({ model: "quick", messages: [] })),
    ).toEqual(["Hello", " world"]);
    await expect(requests[0]?.json()).resolves.toMatchObject({ stream: true });
  });

  test("surfaces provider error events and rejects unsupported modes", async () => {
    let bodyCancelled = false;
    const requestState: { signal?: AbortSignal } = {};
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(
          new TextEncoder().encode(
            `event: error\ndata: ${JSON.stringify({ error: { type: "overloaded_error", message: "Busy" } })}\n\n`,
          ),
        );
      },
      cancel(): void {
        bodyCancelled = true;
      },
    });
    const provider = createAnthropicProvider(config("anthropic"), async (_input, init) => {
      if (init?.signal !== undefined && init.signal !== null) {
        requestState.signal = init.signal;
      }
      return new Response(body);
    });

    await expect(
      readChunks(await provider.generateStream({ model: "quick", messages: [] })),
    ).rejects.toThrow("Busy");
    expect(bodyCancelled).toBe(true);
    expect(requestState.signal?.aborted).toBe(true);
    await expect(
      provider.generateStream({ model: "quick", messages: [], responseFormat: "json" }),
    ).rejects.toThrow("does not support JSON");
    await expect(
      provider.generateStream({ model: "quick", messages: [], webSearch: true }),
    ).rejects.toThrow("does not support web search");
  });

  test("handles malformed, empty, non-OK, and cancelled streams", async () => {
    const malformed = createAnthropicProvider(
      config("anthropic"),
      async () => new Response("event: content_block_delta\ndata: nope\n\n"),
    );
    await expect(
      readChunks(await malformed.generateStream({ model: "quick", messages: [] })),
    ).rejects.toThrow("malformed JSON");

    const empty = createAnthropicProvider(
      config("anthropic"),
      async () => new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n'),
    );
    await expect(
      readChunks(await empty.generateStream({ model: "quick", messages: [] })),
    ).rejects.toThrow("did not include content");

    const failed = createAnthropicProvider(config("anthropic"), async () =>
      Response.json({ error: { type: "overloaded_error", message: "Later" } }, { status: 529 }),
    );
    await expect(failed.generateStream({ model: "quick", messages: [] })).rejects.toThrow(
      "status 529: Later",
    );

    let cancelled = false;
    const requestState: { signal?: AbortSignal } = {};
    const cancellable = createAnthropicProvider(config("anthropic"), async (_input, init) => {
      if (init?.signal !== undefined && init.signal !== null) {
        requestState.signal = init.signal;
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(
              new TextEncoder().encode(
                'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"a"}}\n\n',
              ),
            );
          },
          cancel(): void {
            cancelled = true;
          },
        }),
      );
    });
    const stream = await cancellable.generateStream({ model: "quick", messages: [] });
    const reader = stream.getReader();
    expect(await reader.read()).toEqual({ done: false, value: "a" });
    await reader.cancel();
    expect(cancelled).toBe(true);
    expect(requestState.signal?.aborted).toBe(true);
  });
});
