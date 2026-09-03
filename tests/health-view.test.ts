import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import type { ProviderHealthDetail } from "../app/types";

async function renderHealthView(detail: ProviderHealthDetail): Promise<string> {
  const subprocess = Bun.spawn(
    [process.execPath, "run", resolve(import.meta.dir, "support/render-health-view.ts")],
    {
      stdin: new Blob([JSON.stringify(detail)]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [body, error, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(error);
  }
  return body;
}

function columnMarkup(html: string, col: string): string {
  return html.match(new RegExp(`<div(?=[^>]*data-col="${col}")[^>]*>[^<]*`, "u"))?.[0] ?? "";
}

describe("provider health console view", () => {
  test("does not warn on a sole session-in-progress trim", async () => {
    const html = await renderHealthView({
      summary: {
        routes: [
          {
            provider: "yahoo",
            route: "yahoo-verified-chart",
            total: 1,
            other: 1,
            sampleMessages: ["Dropped in-progress Yahoo session"],
          },
        ],
        validation: {
          routeClassifications: [
            { route: "yahoo-verified-chart", classification: "informational" },
          ],
        },
      },
    });

    expect(html).toContain("informational");
    expect(html).toContain('style="color: #8a8f96"');
    expect(html).not.toContain("WARN");
    expect(html).not.toMatch(/>\s*degraded\s*</u);
    expect(columnMarkup(html, "gaps")).toContain(">1");
    expect(columnMarkup(html, "gaps")).toContain("#5c6066");
    expect(columnMarkup(html, "gaps")).not.toContain("#8a6116");
    expect(columnMarkup(html, "degraded-runs")).toContain(">0");
  });

  test("warns on a covered web-search degradation and shows the degradation count", async () => {
    const html = await renderHealthView({
      summary: {
        routes: [
          {
            provider: "exa",
            route: "exaSearch",
            total: 2,
            degraded: 2,
            sampleMessages: ["Exa search was unusable for 1 of 3 web search request(s)"],
          },
        ],
        validation: {
          routeClassifications: [{ route: "exaSearch", classification: "expected" }],
        },
      },
    });

    expect(html).toContain("WARN");
    expect(html).toContain("provider route is degraded");
    expect(html).toContain("TOTAL");
    expect(html).not.toContain("SOURCES");
    expect(html).toContain("DEGRADED RUNS");
    expect(html).toMatch(/>\s*degraded\s*</u);
    expect(columnMarkup(html, "total")).toContain(">2");
    expect(columnMarkup(html, "gaps")).toContain(">0");
    expect(columnMarkup(html, "degraded-runs")).toContain(">2");
    expect(columnMarkup(html, "degraded-runs")).toContain("#8a6116");
  });

  test("shows zero in the degraded-runs column on a gap-only route", async () => {
    const html = await renderHealthView({
      summary: {
        routes: [
          {
            provider: "yahoo",
            route: "quote/daily",
            total: 12,
            fetchFailed: 2,
            yahooAuth: 1,
            sampleMessages: ["auth expired"],
          },
        ],
        validation: {
          routeClassifications: [{ route: "quote/daily", classification: "blocking" }],
        },
      },
    });

    expect(html).toContain("DEGRADED RUNS");
    expect(columnMarkup(html, "total")).toContain(">12");
    expect(columnMarkup(html, "gaps")).toContain(">3");
    expect(columnMarkup(html, "gaps")).toContain("#8a6116");
    expect(columnMarkup(html, "degraded-runs")).toContain(">0");
    expect(columnMarkup(html, "degraded-runs")).not.toContain("#8a6116");
  });

  test("renders operational with zeros and no banner when nothing is degraded or gapped", async () => {
    const html = await renderHealthView({
      summary: {
        routes: [{ provider: "stooq", route: "eod" }],
      },
    });

    expect(html).not.toContain("WARN");
    expect(html).toContain("operational");
    expect(html).toContain("TOTAL");
    expect(html).toContain("DEGRADED RUNS");
    expect(columnMarkup(html, "total")).toContain(">0");
    expect(columnMarkup(html, "gaps")).toContain(">0");
    expect(columnMarkup(html, "degraded-runs")).toContain(">0");
  });
});
