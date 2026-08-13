import { afterEach, describe, expect, test } from "bun:test";
import {
  configureProgress,
  formatProgressLine,
  progress,
  progressDetail,
  progressEnabled,
  progressVerbose,
} from "../src/progress";

function captureStderr(run: () => void): string {
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return written.join("");
}

afterEach(() => {
  configureProgress({ env: "off" });
});

describe("progress", () => {
  test("stays silent when stderr is not a terminal and no override is set", () => {
    configureProgress({ env: undefined, isTty: false });

    const output = captureStderr(() => {
      progress("collecting sources");
    });

    expect(progressEnabled()).toBe(false);
    expect(output).toBe("");
  });

  test("enables itself on a terminal and writes elapsed-prefixed lines to stderr", () => {
    configureProgress({ env: undefined, isTty: true, nowMs: Date.now() - 1500 });

    const output = captureStderr(() => {
      progress("final synthesis");
    });

    expect(output).toMatch(/^\[\s+1\.5s\] final synthesis\n$/u);
  });

  test("honours an explicit off override on a terminal", () => {
    configureProgress({ env: "off", isTty: true });

    expect(
      captureStderr(() => {
        progress("final synthesis");
      }),
    ).toBe("");
  });

  test("emits per-request detail only at verbose level", () => {
    configureProgress({ env: "on", isTty: false });
    const quiet = captureStderr(() => {
      progressDetail("fetch yahoo https://example.test");
    });

    configureProgress({ env: "VERBOSE ", isTty: false });
    const loud = captureStderr(() => {
      progressDetail("fetch yahoo https://example.test");
    });

    expect(quiet).toBe("");
    expect(progressVerbose()).toBe(true);
    expect(loud).toContain("fetch yahoo https://example.test");
  });

  test("formats elapsed seconds in a fixed-width column", () => {
    expect(formatProgressLine("stage critique done", 42_000)).toBe(
      "[   42.0s] stage critique done",
    );
  });
});
