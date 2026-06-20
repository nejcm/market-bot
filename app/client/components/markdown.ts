import DOMPurify from "dompurify";
import { Marked } from "marked";

// Assistant replies may contain markdown. We render it to HTML and then
// Sanitize, because model output (and the run artifacts it quotes) is
// Untrusted and must never reach the DOM as live HTML.
const marked = new Marked({ gfm: true, breaks: true });

// Links from model output open in a new tab without leaking the opener,
// Matching how sources are linked elsewhere in the console. DOMPurify is only
// Initialized where a DOM exists, so guard the hook for non-browser imports.
if (typeof DOMPurify.addHook === "function") {
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A" && node.hasAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
}

export type HtmlSanitizer = (html: string) => string;

function defaultSanitize(html: string): string {
  return DOMPurify.sanitize(html);
}

// The sanitizer is injectable so the markdown-to-HTML mapping can be unit
// Tested without a DOM; production always uses the DOMPurify default.
export function renderMarkdown(text: string, sanitize: HtmlSanitizer = defaultSanitize): string {
  const html = marked.parse(text, { async: false });
  return sanitize(html);
}
