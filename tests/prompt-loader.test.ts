import { describe, expect, test, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadStagePrompt } from "../src/research/prompt-loader";

async function makePromptDir(
  files: Record<string, string>,
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "prompt-test-"));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(dir, relPath);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content, "utf8");
  }
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const BASE_CONTENT = `## system

Test system message.

## instruction

Base instruction text.

## goal

Base goal text.
`;

const dailyEquityCommand = {
  jobType: "daily" as const,
  assetClass: "equity" as const,
  depth: "brief" as const,
};

const tickerCommand = {
  jobType: "ticker" as const,
  assetClass: "equity" as const,
  symbol: "AAPL",
  depth: "brief" as const,
};

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

describe("loadStagePrompt — base only", () => {
  test("parses system, instruction, and goal from base.md", async () => {
    const { dir, cleanup } = await makePromptDir({
      "specialist-analysis/base.md": BASE_CONTENT,
    });
    cleanups.push(cleanup);

    const result = await loadStagePrompt("specialist-analysis", dailyEquityCommand, dir);

    expect(result.system).toBe("Test system message.");
    expect(result.instruction).toBe("Base instruction text.");
    expect(result.goal).toBe("Base goal text.");
  });

  test("throws when base.md is missing", async () => {
    const { dir, cleanup } = await makePromptDir({});
    cleanups.push(cleanup);

    await expect(loadStagePrompt("specialist-analysis", dailyEquityCommand, dir)).rejects.toThrow(
      "Prompt base file missing",
    );
  });

  test("throws when base.md is missing a required section", async () => {
    const { dir, cleanup } = await makePromptDir({
      "specialist-analysis/base.md": `## system

Test system message.

## instruction

Base instruction text.
`,
    });
    cleanups.push(cleanup);

    await expect(loadStagePrompt("specialist-analysis", dailyEquityCommand, dir)).rejects.toThrow(
      "missing required ## goal section",
    );
  });

  test("uses base only when override file is absent", async () => {
    const { dir, cleanup } = await makePromptDir({
      "critique/base.md": BASE_CONTENT,
    });
    cleanups.push(cleanup);

    const result = await loadStagePrompt("critique", dailyEquityCommand, dir);

    expect(result.instruction).toBe("Base instruction text.");
    expect(result.goal).toBe("Base goal text.");
  });
});

describe("loadStagePrompt — base + override append", () => {
  test("appends override instruction and goal to base", async () => {
    const overrideContent = `## instruction

Override instruction delta.

## goal

Override goal delta.
`;
    const { dir, cleanup } = await makePromptDir({
      "specialist-analysis/base.md": BASE_CONTENT,
      "specialist-analysis/daily-equity.md": overrideContent,
    });
    cleanups.push(cleanup);

    const result = await loadStagePrompt("specialist-analysis", dailyEquityCommand, dir);

    expect(result.instruction).toBe("Base instruction text.\n\nOverride instruction delta.");
    expect(result.goal).toBe("Base goal text.\n\nOverride goal delta.");
    expect(result.system).toBe("Test system message.");
  });

  test("appends only instruction when override has no goal section", async () => {
    const overrideContent = `## instruction

Only instruction delta.
`;
    const { dir, cleanup } = await makePromptDir({
      "specialist-analysis/base.md": BASE_CONTENT,
      "specialist-analysis/daily-equity.md": overrideContent,
    });
    cleanups.push(cleanup);

    const result = await loadStagePrompt("specialist-analysis", dailyEquityCommand, dir);

    expect(result.instruction).toBe("Base instruction text.\n\nOnly instruction delta.");
    expect(result.goal).toBe("Base goal text.");
  });

  test("uses ticker.md override for ticker commands", async () => {
    const overrideContent = `## instruction

Ticker-specific delta.
`;
    const { dir, cleanup } = await makePromptDir({
      "final-synthesis/base.md": BASE_CONTENT,
      "final-synthesis/ticker.md": overrideContent,
    });
    cleanups.push(cleanup);

    const result = await loadStagePrompt("final-synthesis", tickerCommand, dir);

    expect(result.instruction).toBe("Base instruction text.\n\nTicker-specific delta.");
  });

  test("throws when override includes unsupported system section", async () => {
    const { dir, cleanup } = await makePromptDir({
      "specialist-analysis/base.md": BASE_CONTENT,
      "specialist-analysis/daily-equity.md": `## system

Unexpected system delta.
`,
    });
    cleanups.push(cleanup);

    await expect(loadStagePrompt("specialist-analysis", dailyEquityCommand, dir)).rejects.toThrow(
      "unsupported ## system section",
    );
  });

  test("does not apply daily-equity override when command is weekly-equity", async () => {
    const { dir, cleanup } = await makePromptDir({
      "critique/base.md": BASE_CONTENT,
      "critique/daily-equity.md": `## instruction\n\nDaily equity delta.\n`,
    });
    cleanups.push(cleanup);

    const weeklyCommand = {
      jobType: "weekly" as const,
      assetClass: "equity" as const,
      depth: "brief" as const,
    };
    const result = await loadStagePrompt("critique", weeklyCommand, dir);

    expect(result.instruction).toBe("Base instruction text.");
  });
});

describe("loadStagePrompt — real prompt files", () => {
  test("loads all three real base.md files without error", async () => {
    const stages = [
      "evidence-request",
      "specialist-analysis",
      "critique",
      "final-synthesis",
    ] as const;
    for (const stage of stages) {
      const result = await loadStagePrompt(stage, dailyEquityCommand);
      expect(result.system.length).toBeGreaterThan(0);
      expect(result.instruction.length).toBeGreaterThan(0);
      expect(result.goal.length).toBeGreaterThan(0);
    }
  });

  test("real specialist-analysis system message matches expected text", async () => {
    const result = await loadStagePrompt("specialist-analysis", dailyEquityCommand);
    expect(result.system).toContain("market research workflow stage");
  });

  test("real instruction contains research-only constraint", async () => {
    const result = await loadStagePrompt("final-synthesis", dailyEquityCommand);
    expect(result.instruction).toContain("Do not include trade actions");
  });
});
