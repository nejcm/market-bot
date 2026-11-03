// Inline XBRL fact attribute and displayed-value parsing shared by the SEC filing readers.
export function attribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(`(?<![\\w:.-])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "u").exec(attrs);
  return match?.[1] ?? match?.[2];
}

const ZERO_FORMATS = new Set(["ixt:fixed-zero", "ixt:zerodash", "ixt:numdash"]);
const DOT_DECIMAL_FORMATS = new Set(["", "ixt:num-dot-decimal", "ixt:numdotdecimal"]);
const COMMA_DECIMAL_FORMATS = new Set([
  "ixt:num-comma-decimal",
  "ixt:numcommadecimal",
  "ixt:numdotcomma",
]);

// Unknown display formats are skipped rather than guessed.
export function factValue(attrs: string, content: string): number | undefined {
  const format = (attribute(attrs, "format") ?? "").replace(/^ixt\d*:/u, "ixt:");
  const text = content.replaceAll(/<[^>]*>/gu, "").trim();
  // A nil fact has no value, whatever its display format.
  if (attribute(attrs, "xsi:nil") === "true") {
    return undefined;
  }
  if (ZERO_FORMATS.has(format)) {
    return 0;
  }
  const digits = DOT_DECIMAL_FORMATS.has(format)
    ? text.replaceAll(/[,\s]/gu, "")
    : COMMA_DECIMAL_FORMATS.has(format)
      ? text.replaceAll(/[.\s\u00A0]/gu, "").replace(",", ".")
      : undefined;
  if (digits === undefined || !/^\d+(\.\d+)?$/u.test(digits)) {
    return undefined;
  }
  const value = Number(digits) * 10 ** Number(attribute(attrs, "scale") ?? "0");
  return attribute(attrs, "sign") === "-" ? -value : value;
}
