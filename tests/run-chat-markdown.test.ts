import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../app/client/components/markdown";

// Identity sanitizer exposes the raw marked output so the markdown-to-HTML
// Mapping can be asserted without a DOM.
const passthrough = (html: string): string => html;

describe("renderMarkdown", () => {
  test("renders bold and italic emphasis", () => {
    const html = renderMarkdown("**bold** and _italic_", passthrough);
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
  });

  test("renders headings", () => {
    expect(renderMarkdown("# Title", passthrough)).toContain("<h1>Title</h1>");
  });

  test("renders unordered lists", () => {
    const html = renderMarkdown("- one\n- two", passthrough);
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<li>two</li>");
  });

  test("renders fenced code blocks", () => {
    const html = renderMarkdown("```\nconst x = 1;\n```", passthrough);
    expect(html).toContain("<pre>");
    expect(html).toContain("<code");
    expect(html).toContain("const x = 1;");
  });

  test("renders links", () => {
    const html = renderMarkdown("[site](https://example.com)", passthrough);
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain(">site</a>");
  });

  test("treats single newlines as line breaks (gfm breaks)", () => {
    expect(renderMarkdown("line one\nline two", passthrough)).toContain("<br>");
  });

  test("renders gfm tables", () => {
    const html = renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 |", passthrough);
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>1</td>");
  });

  test("passes parsed html through the sanitizer", () => {
    let received = "";
    const result = renderMarkdown("**hi**", (html) => {
      received = html;
      return "<clean/>";
    });
    expect(received).toContain("<strong>hi</strong>");
    expect(result).toBe("<clean/>");
  });

  test("returns a string for empty input", () => {
    expect(renderMarkdown("", passthrough)).toBe("");
  });
});
