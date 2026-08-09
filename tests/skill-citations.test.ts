import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * The run-review skill steers reviews by citing concrete paths and symbols.
 * Stale citations there produce confidently wrong reviews, so they are checked
 * like any other reference. Only backticked `path` and `path:symbol` citations
 * are scanned; bare field names are not path-qualified and go unchecked — cite
 * them as `file.ts:field` if they need coverage.
 */
const SKILL_FILES = [
  ".claude/skills/run-review/SKILL.md",
  ".claude/skills/improve-market-runs/SKILL.md",
];

const REPO_ROOT = join(import.meta.dir, "..");

const CITATION =
  /`((?:src|docs|tests|prompts|app)\/[\w./-]+\.(?:ts|md|json))(?::([A-Za-z_$][\w$]*))?`/gu;

function citations(body: string): { path: string; symbol: string | undefined }[] {
  return [...body.matchAll(CITATION)].map((match) => ({
    path: match[1] ?? "",
    symbol: match[2],
  }));
}

describe("skill citations", () => {
  for (const skill of SKILL_FILES) {
    const body = readFileSync(join(REPO_ROOT, skill), "utf8");
    const cited = citations(body);

    test(`${skill} cites at least one path`, () => {
      expect(cited.length).toBeGreaterThan(0);
    });

    for (const { path, symbol } of cited) {
      test(`${skill} -> ${path}${symbol ? `:${symbol}` : ""}`, () => {
        const absolute = join(REPO_ROOT, path);
        expect(existsSync(absolute)).toBe(true);
        if (symbol) {
          expect(readFileSync(absolute, "utf8")).toContain(symbol);
        }
      });
    }
  }
});

describe("skill copies stay in sync", () => {
  for (const skill of SKILL_FILES) {
    const mirror = skill.replace(".claude/", ".agents/");
    test(`${skill} matches ${mirror}`, () => {
      expect(readFileSync(join(REPO_ROOT, mirror), "utf8")).toBe(
        readFileSync(join(REPO_ROOT, skill), "utf8"),
      );
    });
  }
});
