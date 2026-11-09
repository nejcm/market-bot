import type { FigureQuote } from "../domain/report";
import { isRecord } from "../guards";

export function readFigureQuotes(value: unknown): readonly FigureQuote[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((item) =>
    isRecord(item) &&
    typeof item.sourceId === "string" &&
    typeof item.quote === "string" &&
    item.quote.trim() !== ""
      ? [
          {
            sourceId: item.sourceId,
            quote: item.quote,
            ...(typeof item.unitQuote === "string" && item.unitQuote.trim() !== ""
              ? { unitQuote: item.unitQuote }
              : {}),
          },
        ]
      : [],
  );
}
