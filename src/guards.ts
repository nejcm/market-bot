export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function recordAt(
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> {
  const next = value?.[key];
  return isRecord(next) ? next : {};
}

export function numberAt(
  value: Record<string, unknown> | undefined,
  path: readonly string[],
): number {
  const [first, ...rest] = path;
  if (first === undefined) {
    return 0;
  }
  if (rest.length === 0) {
    return numberValue(value?.[first]);
  }
  return numberAt(recordAt(value, first), rest);
}

export function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

// Preserves empty and whitespace-only strings, unlike readString which drops them.
export function readStringVerbatim(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

export function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = readString(record, key);
  return value === undefined ? undefined : value;
}

export function readStringArray(
  record: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  const value = record[key];
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

export function stringArrayValue(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function nonEmptyStringArrayValue(value: unknown): readonly string[] {
  return stringArrayValue(value).filter((item) => item.trim() !== "");
}

// Parses a JSON-encoded string array, such as a serialized index column.
// Malformed JSON and non-array payloads return an empty array.
export function parseStringArrayJson(value: string): readonly string[] {
  try {
    return stringArrayValue(JSON.parse(value));
  } catch {
    return [];
  }
}
