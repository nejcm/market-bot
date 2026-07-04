import type {
  ModelInputFieldRole,
  ModelInputSanitizationAggregate,
  ModelInputSanitizationAggregateEntry,
  ModelInputSanitizerProfile,
  ModelInputSanitizerTelemetry,
} from "../domain/types";

export type {
  ModelInputFieldRole,
  ModelInputSanitizationAggregate,
  ModelInputSanitizationAggregateEntry,
  ModelInputSanitizerProfile,
  ModelInputSanitizerTelemetry,
} from "../domain/types";

export interface ModelInputSanitizerResult {
  readonly text?: string;
  readonly telemetry: ModelInputSanitizerTelemetry;
}

export interface ModelInputSanitizationContext {
  readonly provider: string;
  readonly ingress: string;
  readonly profile: ModelInputSanitizerProfile;
  readonly fieldRole: ModelInputFieldRole;
}

export interface SanitizedModelInputField {
  readonly text?: string;
  readonly entry: ModelInputSanitizationAggregateEntry;
}

export function aggregateModelInputSanitization(
  entries: readonly ModelInputSanitizationAggregateEntry[],
): ModelInputSanitizationAggregate {
  const totals = new Map<string, ModelInputSanitizationAggregateEntry>();
  for (const entry of entries) {
    const key = `${entry.provider}\u0000${entry.ingress}\u0000${entry.profile}\u0000${entry.fieldRole}`;
    const previous = totals.get(key);
    totals.set(
      key,
      previous === undefined
        ? entry
        : {
            ...entry,
            inputChars: previous.inputChars + entry.inputChars,
            outputChars: previous.outputChars + entry.outputChars,
            removedInstructionSpanCount:
              previous.removedInstructionSpanCount + entry.removedInstructionSpanCount,
            removedMarkupChromeCount:
              previous.removedMarkupChromeCount + entry.removedMarkupChromeCount,
            truncatedFieldCount: previous.truncatedFieldCount + entry.truncatedFieldCount,
            truncatedCharCount: previous.truncatedCharCount + entry.truncatedCharCount,
            emptyAfterSanitizeFieldCount:
              previous.emptyAfterSanitizeFieldCount + entry.emptyAfterSanitizeFieldCount,
            droppedItemCount: previous.droppedItemCount + entry.droppedItemCount,
          },
    );
  }
  return { entries: [...totals.values()] };
}

export function mergeModelInputSanitization(
  ...aggregates: readonly (ModelInputSanitizationAggregate | undefined)[]
): ModelInputSanitizationAggregate {
  return aggregateModelInputSanitization(
    aggregates.flatMap((aggregate) => aggregate?.entries ?? []),
  );
}

export const MODEL_INPUT_FIELD_CAPS = {
  title: 300,
  publisher: 200,
  summary: 1200,
  snippet: 1200,
  prose: undefined,
} as const;

export const MAX_MODEL_INPUT_SANITIZER_WORK_CHARS = 10_000;

const ACTIVE_HTML_RE =
  /<(script|style|form|template|noscript|iframe|svg|head)\b[\s\S]*?(?:<\/\1>|$)|<(meta|link|input|button|select|textarea)\b[^>]*>/giu;
const COMMENT_RE = /<!--[\s\S]*?(?:-->|$)/gu;
const TAG_RE = /<[^>]+>/gu;
const CODE_FENCE_RE = /```[\s\S]*?(?:```|$)/gu;
const ENTITY_RE = /&(?:#(\d+)|#x([\da-f]+)|amp|lt|gt|quot|apos|nbsp|mdash|ndash);/giu;
const UNKNOWN_ENTITY_RE = /&[a-z][a-z\d]+;/giu;
const FORMAT_RE = /\p{Cf}+/gu;
const WHITESPACE_RE = /\s+/gu;
const MAX_CODE_POINT = 1_114_111;

const INSTRUCTION_PATTERNS: readonly RegExp[] = [
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
  /^we use cookies\b[^.!?]*[.!?]?$/iu,
  /^cookie (?:settings|preferences|policy)$/iu,
  /^(?:subscribe|sign in|log in|create account|join now|newsletter)$/iu,
  /^(?:share|shared? on|follow us|advertisement|advertising|sponsored)$/iu,
  /^(?:skip to (?:content|main content)|privacy policy|terms of use|all rights reserved)$/iu,
];

export function sanitizeModelInputField(
  input: string,
  context: ModelInputSanitizationContext,
): SanitizedModelInputField {
  const maxChars = MODEL_INPUT_FIELD_CAPS[context.fieldRole];
  const sanitized = sanitizeModelInputText(input, {
    profile: context.profile,
    fieldRole: context.fieldRole,
    ...(maxChars !== undefined ? { maxChars } : {}),
  });
  return {
    ...(sanitized.text !== undefined ? { text: sanitized.text } : {}),
    entry: {
      ...context,
      droppedItemCount: 0,
      ...sanitized.telemetry,
    },
  };
}

export function droppedModelInputItemEntry(
  context: ModelInputSanitizationContext,
): ModelInputSanitizationAggregateEntry {
  return {
    ...context,
    droppedItemCount: 1,
    inputChars: 0,
    outputChars: 0,
    removedInstructionSpanCount: 0,
    removedMarkupChromeCount: 0,
    truncatedFieldCount: 0,
    truncatedCharCount: 0,
    emptyAfterSanitizeFieldCount: 0,
  };
}

export function sanitizeModelInputText(
  input: string,
  options: {
    readonly profile: ModelInputSanitizerProfile;
    readonly fieldRole: ModelInputFieldRole;
    readonly maxChars?: number;
  },
): ModelInputSanitizerResult {
  let text = input.slice(0, MAX_MODEL_INPUT_SANITIZER_WORK_CHARS);
  const workTruncatedChars = input.length - text.length;
  let removedMarkupChromeCount = 0;
  let removedInstructionSpanCount = 0;

  for (let pass = 0; pass < 2; pass += 1) {
    text = text.replace(ENTITY_RE, (_match, decimal: string, hex: string) =>
      decodeEntity(_match, decimal, hex),
    );
  }
  text = removeControlAndFormatCharacters(text);

  if (options.profile !== "sec-filing") {
    ({ text, count: removedMarkupChromeCount } = replaceCounted(
      text,
      COMMENT_RE,
      removedMarkupChromeCount,
    ));
    ({ text, count: removedMarkupChromeCount } = replaceCounted(
      text,
      ACTIVE_HTML_RE,
      removedMarkupChromeCount,
    ));
    ({ text, count: removedMarkupChromeCount } = replaceCounted(
      text,
      TAG_RE,
      removedMarkupChromeCount,
    ));
    ({ text, count: removedMarkupChromeCount } = replaceCounted(
      text,
      UNKNOWN_ENTITY_RE,
      removedMarkupChromeCount,
    ));
  }

  if (
    options.profile === "open-web" ||
    options.profile === "news" ||
    options.profile === "legacy-history"
  ) {
    ({ text, count: removedInstructionSpanCount } = replaceCounted(
      text,
      CODE_FENCE_RE,
      removedInstructionSpanCount,
    ));
  }

  const filterChrome =
    options.profile === "open-web" ||
    options.profile === "news" ||
    options.profile === "legacy-history";
  const retainedLines: string[] = [];
  for (const line of text.split(/\r?\n+/u)) {
    const normalizedLine = line.replaceAll(WHITESPACE_RE, " ").trim();
    if (normalizedLine === "") {
      continue;
    }
    if (filterChrome && isChrome(normalizedLine)) {
      removedMarkupChromeCount += 1;
    } else {
      retainedLines.push(normalizedLine);
    }
  }
  const normalized = retainedLines.join(" ").trim();
  if (options.profile === "short-metadata" && isInstruction(normalized)) {
    return result(input.length, undefined, {
      removedInstructionSpanCount: 1,
      removedMarkupChromeCount,
      truncatedCharCount: workTruncatedChars,
    });
  }

  const retained: string[] = [];
  for (const sentence of normalized.split(/(?<=[.!?])\s+/u)) {
    if (
      options.profile !== "sec-filing" &&
      options.profile !== "short-metadata" &&
      isChrome(sentence)
    ) {
      removedMarkupChromeCount += 1;
    } else if (isInstruction(sentence)) {
      removedInstructionSpanCount += 1;
    } else if (sentence !== "") {
      retained.push(sentence);
    }
  }

  const safe = retained.join(" ").trim();
  const bounded = truncateAtSentence(safe, options.maxChars);
  return result(input.length, bounded.text, {
    removedInstructionSpanCount,
    removedMarkupChromeCount,
    truncatedCharCount: workTruncatedChars + bounded.truncatedChars,
  });
}

function result(
  inputChars: number,
  text: string | undefined,
  counts: {
    readonly removedInstructionSpanCount: number;
    readonly removedMarkupChromeCount: number;
    readonly truncatedCharCount?: number;
  },
): ModelInputSanitizerResult {
  const output = text === "" ? undefined : text;
  const truncatedCharCount = counts.truncatedCharCount ?? 0;
  return {
    ...(output !== undefined ? { text: output } : {}),
    telemetry: {
      inputChars,
      outputChars: output?.length ?? 0,
      removedInstructionSpanCount: counts.removedInstructionSpanCount,
      removedMarkupChromeCount: counts.removedMarkupChromeCount,
      truncatedFieldCount: truncatedCharCount > 0 ? 1 : 0,
      truncatedCharCount,
      emptyAfterSanitizeFieldCount: inputChars > 0 && output === undefined ? 1 : 0,
    },
  };
}

function truncateAtSentence(
  text: string,
  maxChars: number | undefined,
): { readonly text: string; readonly truncatedChars: number } {
  if (maxChars === undefined || text.length <= maxChars) {
    return { text, truncatedChars: 0 };
  }
  const candidate = text.slice(0, maxChars + 1);
  const boundary = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? "),
  );
  const cut =
    boundary >= Math.floor(maxChars / 2)
      ? candidate.slice(0, boundary + 1)
      : `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
  return { text: cut, truncatedChars: text.length - cut.length };
}

function replaceCounted(
  text: string,
  pattern: RegExp,
  initial: number,
): { readonly text: string; readonly count: number } {
  let count = initial;
  return {
    text: text.replace(pattern, () => {
      count += 1;
      return " ";
    }),
    count,
  };
}

function isInstruction(text: string): boolean {
  const comparison = text.normalize("NFKC");
  return INSTRUCTION_PATTERNS.some((pattern) => pattern.test(comparison));
}

function isChrome(text: string): boolean {
  if (text.length > 180) {
    return false;
  }
  const candidate = text.replace(/[.!?]+$/u, "").trimEnd();
  return CHROME_PATTERNS.some((pattern) => pattern.test(candidate));
}

function decodeEntity(match: string, decimal?: string, hex?: string): string {
  if (decimal !== undefined) {
    return decodeCodePoint(Number.parseInt(decimal, 10));
  }
  if (hex !== undefined) {
    return decodeCodePoint(Number.parseInt(hex, 16));
  }
  const entities: Readonly<Record<string, string>> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&apos;": "'",
    "&nbsp;": " ",
    "&mdash;": "-",
    "&ndash;": "-",
  };
  return entities[match.toLowerCase()] ?? " ";
}

function removeControlAndFormatCharacters(value: string): string {
  return [...value.replace(FORMAT_RE, " ")]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159)
        ? " "
        : character;
    })
    .join("");
}

function decodeCodePoint(value: number): string {
  return Number.isInteger(value) && value >= 0 && value <= MAX_CODE_POINT
    ? String.fromCodePoint(value)
    : " ";
}
