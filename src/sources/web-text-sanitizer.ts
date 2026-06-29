export interface WebTextSanitizerTelemetry {
  readonly inputChars: number;
  readonly outputChars: number;
  readonly removedInstructionSpanCount: number;
  readonly removedChromeHtmlCount: number;
}

export interface WebTextSanitizerResult {
  readonly text?: string;
  readonly telemetry: WebTextSanitizerTelemetry;
}

export const MAX_WEB_TEXT_SANITIZER_INPUT_CHARS = 10_000;

const CODE_FENCE_RE = /```[\s\S]*?```/gu;
const HTML_BLOCK_RE =
  /<(script|style|form|template|noscript|iframe|svg|head|meta|link|input|button|select|textarea)\b[\s\S]*?<\/\1>|<(meta|link|input|button|select|textarea)\b[^>]*>/giu;
const HTML_UNCLOSED_BLOCK_RE =
  /<(script|style|form|template|noscript|iframe|svg|head)\b[^>]*>[\s\S]*$/giu;
const HTML_DANGLING_RISKY_TAG_RE =
  /<(script|style|form|template|noscript|iframe|svg|head)\b[^>]*$/giu;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/gu;
const HTML_TAG_RE = /<[^>]+>/gu;
const ENTITY_RE = /&(?:#(\d+)|#x([\da-f]+)|amp|lt|gt|quot|apos|nbsp|mdash|ndash);/giu;
const FORMAT_SEPARATOR_RE = /[\u00AD\u200B-\u200D\uFEFF]+/gu;
const WHITESPACE_RE = /\s+/gu;
const MAX_UNICODE_CODE_POINT = 1_114_111;

const INSTRUCTION_SPAN_PATTERNS: readonly RegExp[] = [
  /\bignore (?:all |any |the |these |previous |prior |above ){0,4}instructions?\b/iu,
  /\bdisregard (?:all |any |the |these |previous |prior |above ){0,4}instructions?\b/iu,
  /\bforget (?:all |any |the |these |previous |prior |above ){0,4}instructions?\b/iu,
  /\b(?:system|developer|assistant|user) (?:prompt|message|instruction)s?\b/iu,
  /\b(?:tool call|function call|run this command|execute this command)\b/iu,
  /\breveal (?:the )?(?:system|developer|hidden) prompt\b/iu,
  /\bdo not (?:summarize|cite|mention|follow) (?:this|the page|the source|previous instructions)\b/iu,
  /\bcopy and paste this prompt\b/iu,
  /\bBEGIN (?:SYSTEM|DEVELOPER|PROMPT|INSTRUCTIONS?)\b/iu,
  /\bEND (?:SYSTEM|DEVELOPER|PROMPT|INSTRUCTIONS?)\b/iu,
];

const CHROME_PATTERNS: readonly RegExp[] = [
  /^(?:accept|reject|manage|allow)(?: all)? cookies?$/iu,
  /^we use cookies\b/iu,
  /^cookie (?:settings|preferences|policy)$/iu,
  /^(?:subscribe|sign in|log in|create account|join now|newsletter)$/iu,
  /^(?:share|shared? on|follow us|advertisement|advertising|sponsored)$/iu,
  /^(?:skip to (?:content|main content)|privacy policy|terms of use|all rights reserved)$/iu,
];

export function sanitizeModelVisibleWebText(input: string): WebTextSanitizerResult {
  const inputChars = input.length;
  let removedInstructionSpanCount = 0;
  let removedChromeHtmlCount = 0;
  let text = input.slice(0, MAX_WEB_TEXT_SANITIZER_INPUT_CHARS);

  for (let pass = 0; pass < 2; pass += 1) {
    ({ text, removedCount: removedChromeHtmlCount } = replacePattern(
      text,
      ENTITY_RE,
      (match, decimal: string | undefined, hex: string | undefined) =>
        decodeHtmlEntity(match, decimal, hex),
      removedChromeHtmlCount,
    ));
  }
  ({ text, removedCount: removedChromeHtmlCount } = removePattern(
    text,
    HTML_COMMENT_RE,
    removedChromeHtmlCount,
  ));
  ({ text, removedCount: removedChromeHtmlCount } = removePattern(
    text,
    HTML_BLOCK_RE,
    removedChromeHtmlCount,
  ));
  ({ text, removedCount: removedChromeHtmlCount } = removePattern(
    text,
    HTML_UNCLOSED_BLOCK_RE,
    removedChromeHtmlCount,
  ));
  ({ text, removedCount: removedChromeHtmlCount } = removePattern(
    text,
    HTML_DANGLING_RISKY_TAG_RE,
    removedChromeHtmlCount,
  ));
  ({ text, removedCount: removedInstructionSpanCount } = removePattern(
    text,
    CODE_FENCE_RE,
    removedInstructionSpanCount,
  ));
  ({ text, removedCount: removedChromeHtmlCount } = replacePattern(
    text,
    HTML_TAG_RE,
    " ",
    removedChromeHtmlCount,
  ));
  const retainedLines: string[] = [];
  for (const line of text.split(/\r?\n+/u)) {
    const normalized = line
      .replaceAll(FORMAT_SEPARATOR_RE, " ")
      .replaceAll(WHITESPACE_RE, " ")
      .trim();
    if (normalized === "") {
      continue;
    }
    if (isChromeLine(normalized)) {
      removedChromeHtmlCount += 1;
      continue;
    }
    retainedLines.push(normalized);
  }

  const filtered: string[] = [];
  const normalizedText = retainedLines.join(" ").replaceAll(WHITESPACE_RE, " ").trim();
  for (const sentence of normalizedText.split(/(?<=[.!?])\s+/u)) {
    if (isInstructionSpan(sentence)) {
      removedInstructionSpanCount += 1;
      continue;
    }
    filtered.push(sentence);
  }

  const output = filtered.join(" ").replaceAll(WHITESPACE_RE, " ").trim();
  return {
    ...(output !== "" ? { text: output } : {}),
    telemetry: {
      inputChars,
      outputChars: output.length,
      removedInstructionSpanCount,
      removedChromeHtmlCount,
    },
  };
}

function removePattern(
  text: string,
  pattern: RegExp,
  removedCount: number,
): { readonly text: string; readonly removedCount: number } {
  let count = removedCount;
  const next = text.replace(pattern, () => {
    count += 1;
    return "";
  });
  return { text: next, removedCount: count };
}

function replacePattern(
  text: string,
  pattern: RegExp,
  replacement:
    | string
    | ((match: string, decimal: string | undefined, hex: string | undefined) => string),
  removedCount: number,
): { readonly text: string; readonly removedCount: number } {
  let count = removedCount;
  const next = text.replace(pattern, (...args: readonly unknown[]) => {
    count += 1;
    return typeof replacement === "string"
      ? replacement
      : replacement(
          args[0] as string,
          args[1] as string | undefined,
          args[2] as string | undefined,
        );
  });
  return { text: next, removedCount: count };
}

function decodeHtmlEntity(
  match: string,
  decimal: string | undefined,
  hex: string | undefined,
): string {
  if (decimal !== undefined) {
    return decodeCodePoint(Number.parseInt(decimal, 10));
  }
  if (hex !== undefined) {
    return decodeCodePoint(Number.parseInt(hex, 16));
  }
  const lower = match.toLowerCase();
  if (lower === "&amp;") {
    return "&";
  }
  if (lower === "&lt;") {
    return "<";
  }
  if (lower === "&gt;") {
    return ">";
  }
  if (lower === "&quot;") {
    return '"';
  }
  if (lower === "&apos;") {
    return "'";
  }
  if (lower === "&nbsp;") {
    return " ";
  }
  if (lower === "&mdash;" || lower === "&ndash;") {
    return "-";
  }
  return " ";
}

function decodeCodePoint(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > MAX_UNICODE_CODE_POINT) {
    return " ";
  }
  return String.fromCodePoint(value);
}

function isInstructionSpan(text: string): boolean {
  return INSTRUCTION_SPAN_PATTERNS.some((pattern) => pattern.test(text));
}

function isChromeLine(text: string): boolean {
  if (text.length > 180) {
    return false;
  }
  return CHROME_PATTERNS.some((pattern) => pattern.test(text));
}
