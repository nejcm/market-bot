const MAX_SSE_BUFFER_CHARS = 1_048_576;

export interface ServerSentEvent {
  readonly event?: string;
  readonly data: string;
}

export interface SseTextResult {
  readonly text?: string;
  readonly done?: boolean;
}

interface SseTextOptions {
  readonly providerName: string;
  readonly parse: (event: ServerSentEvent) => SseTextResult;
  readonly cancel?: () => void;
}

export function decodeServerSentEvents(
  body: ReadableStream<Uint8Array>,
): ReadableStream<ServerSentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let lineBuffer = "";
  let eventName: string | undefined = undefined;
  let dataLines: string[] = [];
  let frameChars = 0;
  let stopped = false;

  return new ReadableStream<ServerSentEvent>({
    async pull(controller): Promise<void> {
      const dispatch = (): "continue" | "enqueued" | "closed" => {
        if (dataLines.length === 0) {
          eventName = undefined;
          frameChars = 0;
          return "continue";
        }

        const data = dataLines.join("\n");
        const dispatchedEventName = eventName;
        eventName = undefined;
        dataLines = [];
        frameChars = 0;
        if (data === "[DONE]") {
          stopped = true;
          controller.close();
          void reader.cancel();
          return "closed";
        }
        controller.enqueue({
          ...(dispatchedEventName !== undefined ? { event: dispatchedEventName } : {}),
          data,
        });
        return "enqueued";
      };

      const consumeLine = (rawLine: string): "continue" | "enqueued" | "closed" => {
        if (rawLine.length > MAX_SSE_BUFFER_CHARS) {
          throw new Error("SSE frame exceeded the maximum buffer size");
        }
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line === "") {
          return dispatch();
        }
        frameChars += rawLine.length + 1;
        if (frameChars > MAX_SSE_BUFFER_CHARS) {
          throw new Error("SSE frame exceeded the maximum buffer size");
        }
        if (line.startsWith(":")) {
          return "continue";
        }

        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) {
          value = value.slice(1);
        }
        if (field === "event") {
          eventName = value;
        } else if (field === "data") {
          dataLines.push(value);
        }
        return "continue";
      };

      const finish = (): void => {
        lineBuffer += decoder.decode();
        if (lineBuffer.length > MAX_SSE_BUFFER_CHARS) {
          throw new Error("SSE frame exceeded the maximum buffer size");
        }
        if (lineBuffer !== "") {
          const result = consumeLine(lineBuffer);
          lineBuffer = "";
          if (result !== "continue") {
            return;
          }
        }
        const result = dispatch();
        if (result !== "closed") {
          stopped = true;
          controller.close();
        }
      };

      try {
        // oxlint-disable-next-line no-unmodified-loop-condition -- Terminal frames and EOF update stopped through helpers.
        while (!stopped) {
          const newline = lineBuffer.indexOf("\n");
          if (newline !== -1) {
            const line = lineBuffer.slice(0, newline);
            lineBuffer = lineBuffer.slice(newline + 1);
            const result = consumeLine(line);
            if (result !== "continue") {
              return;
            }
            continue;
          }
          if (lineBuffer.length > MAX_SSE_BUFFER_CHARS) {
            throw new Error("SSE frame exceeded the maximum buffer size");
          }

          // oxlint-disable-next-line no-await-in-loop -- Stream chunks are ordered protocol input.
          const next = await reader.read();
          if (next.done) {
            finish();
            return;
          }

          lineBuffer += decoder.decode(next.value, { stream: true });
        }
      } catch (error: unknown) {
        if (!stopped) {
          stopped = true;
          await reader.cancel(error).catch(() => {});
          controller.error(error);
        }
      }
    },
    async cancel(reason: unknown): Promise<void> {
      stopped = true;
      await reader.cancel(reason).catch(() => {});
    },
  });
}

export function mapSseEventsToText(
  events: ReadableStream<ServerSentEvent>,
  options: SseTextOptions,
): ReadableStream<string> {
  const reader = events.getReader();
  let emitted = false;
  let stopped = false;

  return new ReadableStream<string>({
    async pull(controller): Promise<void> {
      try {
        while (!stopped) {
          // oxlint-disable-next-line no-await-in-loop -- SSE events must be consumed sequentially.
          const next = await reader.read();
          if (next.done) {
            stopped = true;
            if (!emitted) {
              controller.error(new Error(`${options.providerName} stream did not include content`));
            } else {
              controller.close();
            }
            return;
          }

          const result = options.parse(next.value);
          if (result.done === true) {
            stopped = true;
            // oxlint-disable-next-line no-await-in-loop -- Cancellation belongs to this terminal event.
            await reader.cancel().catch(() => {});
            if (!emitted) {
              controller.error(new Error(`${options.providerName} stream did not include content`));
            } else {
              controller.close();
            }
            return;
          }
          if (result.text !== undefined && result.text !== "") {
            emitted = true;
            controller.enqueue(result.text);
            return;
          }
        }
      } catch (error: unknown) {
        stopped = true;
        options.cancel?.();
        await reader.cancel(error).catch(() => {});
        controller.error(error);
      }
    },
    async cancel(reason: unknown): Promise<void> {
      stopped = true;
      options.cancel?.();
      await reader.cancel(reason).catch(() => {});
    },
  });
}
