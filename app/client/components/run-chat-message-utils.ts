import type { UIMessage } from "@ai-sdk/svelte";

const TIMESTAMP_LOCALE = "en-US";

const TODAY_FORMATTER = new Intl.DateTimeFormat(TIMESTAMP_LOCALE, {
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
});

const OLDER_FORMATTER = new Intl.DateTimeFormat(TIMESTAMP_LOCALE, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function textFromParts(parts: readonly unknown[]): string {
  return parts
    .filter(
      (part): part is { type: "text"; text: string } =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
}

export function messageCreatedAt(message: UIMessage): number | undefined {
  const { metadata } = message;
  if (!isRecord(metadata) || typeof metadata.createdAt !== "number") {
    return undefined;
  }
  return metadata.createdAt;
}

function isSameLocalDate(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function formatChatTimestamp(timestamp?: number, now: Date = new Date()): string {
  if (timestamp === undefined || !Number.isFinite(timestamp)) {
    return "";
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return isSameLocalDate(date, now) ? TODAY_FORMATTER.format(date) : OLDER_FORMATTER.format(date);
}
