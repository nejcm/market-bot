import { describe, expect, test } from "bun:test";
import { bumpFor, nextVersion, releasableCommits, renderSection } from "../scripts/release";

const commit = (subject: string, body = "") => ({ hash: "abcdef1234567", subject, body });

describe("release bump", () => {
  test("feat is minor, fix and perf are patch", () => {
    expect(bumpFor(releasableCommits([commit("feat(x): a"), commit("fix: b")]))).toBe("minor");
    expect(bumpFor(releasableCommits([commit("fix: b"), commit("perf: c")]))).toBe("patch");
  });

  test("breaking marker or footer is major, on any type", () => {
    expect(bumpFor(releasableCommits([commit("refactor!: a")]))).toBe("major");
    expect(bumpFor(releasableCommits([commit("fix: a", "BREAKING CHANGE: gone")]))).toBe("major");
  });

  test("docs, chore, release commits and non-conventional subjects do not release", () => {
    const commits = releasableCommits([
      commit("docs: a"),
      commit("chore(release): v1.0.1"),
      commit("refactor: b"),
      commit("Merge pull request #1"),
    ]);
    expect(bumpFor(commits)).toBeUndefined();
  });
});

describe("nextVersion", () => {
  test("resets lower components", () => {
    expect(nextVersion("1.2.3", "major")).toBe("2.0.0");
    expect(nextVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(nextVersion("1.2.3", "patch")).toBe("1.2.4");
  });
});

describe("renderSection", () => {
  test("groups entries and lists breaking changes once", () => {
    const section = renderSection({
      version: "2.0.0",
      date: "2026-10-14",
      compareUrl: "https://example.test/compare/v1.0.0...v2.0.0",
      commitUrl: "https://example.test/commit",
      commits: releasableCommits([commit("feat(cli)!: drop flag"), commit("fix: repair gap")]),
    });
    expect(section).toBe(
      [
        "## [2.0.0](https://example.test/compare/v1.0.0...v2.0.0) (2026-10-14)",
        "### Breaking Changes\n\n- **cli:** drop flag ([abcdef1](https://example.test/commit/abcdef1234567))",
        "### Bug Fixes\n\n- repair gap ([abcdef1](https://example.test/commit/abcdef1234567))",
      ].join("\n\n"),
    );
  });
});
