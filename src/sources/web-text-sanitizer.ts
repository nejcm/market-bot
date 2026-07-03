import {
  MAX_MODEL_INPUT_SANITIZER_WORK_CHARS,
  sanitizeModelInputText,
} from "./model-input-sanitizer";

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

export const MAX_WEB_TEXT_SANITIZER_INPUT_CHARS = MAX_MODEL_INPUT_SANITIZER_WORK_CHARS;

export function sanitizeModelVisibleWebText(input: string): WebTextSanitizerResult {
  const result = sanitizeModelInputText(input, {
    profile: "open-web",
    fieldRole: "prose",
  });
  return {
    ...(result.text !== undefined ? { text: result.text } : {}),
    telemetry: {
      inputChars: result.telemetry.inputChars,
      outputChars: result.telemetry.outputChars,
      removedInstructionSpanCount: result.telemetry.removedInstructionSpanCount,
      removedChromeHtmlCount: result.telemetry.removedMarkupChromeCount,
    },
  };
}
