import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { researchConsoleStaticPath } from "../app/server";

describe("research console static assets", () => {
  test("resolves built files under dist", () => {
    const distDir = mkdtempSync(join(tmpdir(), "research-console-dist-"));
    const assetDir = join(distDir, "assets");
    mkdirSync(assetDir);
    const assetPath = join(assetDir, "index.js");
    writeFileSync(assetPath, "export {};\n", "utf8");

    expect(researchConsoleStaticPath("/assets/index.js", distDir)).toBe(assetPath);
  });

  test("falls back to index for client routes", () => {
    const distDir = mkdtempSync(join(tmpdir(), "research-console-dist-"));
    const indexPath = join(distDir, "index.html");
    writeFileSync(indexPath, "<main></main>\n", "utf8");

    expect(researchConsoleStaticPath("/runs/abc", distDir)).toBe(indexPath);
  });

  test("rejects paths outside dist", () => {
    const distDir = mkdtempSync(join(tmpdir(), "research-console-dist-"));
    writeFileSync(join(distDir, "index.html"), "<main></main>\n", "utf8");

    expect(researchConsoleStaticPath("/../secret.txt", distDir)).toBeUndefined();
    expect(researchConsoleStaticPath("/%2e%2e/secret.txt", distDir)).toBeUndefined();
  });
});
