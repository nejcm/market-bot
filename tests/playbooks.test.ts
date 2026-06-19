import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  eligiblePlaybookCandidates,
  loadPlaybookRegistry,
  loadPlaybooksByStage,
  mandatoryPlaybookSelections,
  parsePlaybookSelection,
  type PlaybookMetadata,
} from "../src/research/playbooks";

const registry: readonly PlaybookMetadata[] = [
  {
    id: "market-regime",
    title: "Market Regime",
    summary: "Regime context.",
    file: "market-regime.md",
    jobTypes: ["daily", "weekly"],
    assetClasses: ["equity", "crypto"],
    depths: ["brief", "deep"],
    stages: ["specialist-analysis", "critique", "final-synthesis"],
  },
  {
    id: "critique-discipline",
    title: "Critique Discipline",
    summary: "Critique weak claims.",
    file: "critique-discipline.md",
    jobTypes: ["daily", "weekly", "ticker"],
    assetClasses: ["equity", "crypto"],
    depths: ["brief", "deep"],
    stages: ["critique"],
  },
  {
    id: "synthesis-discipline",
    title: "Synthesis Discipline",
    summary: "Synthesize evidence.",
    file: "synthesis-discipline.md",
    jobTypes: ["market-overview", "daily", "weekly", "ticker", "research"],
    assetClasses: ["equity", "crypto"],
    depths: ["brief", "deep"],
    stages: ["final-synthesis"],
  },
  {
    id: "market-behavior",
    title: "Market Behavior",
    summary: "Behavior context.",
    file: "market-behavior.md",
    jobTypes: ["ticker"],
    assetClasses: ["equity"],
    depths: ["deep"],
    stages: ["market-behavior-analysis", "critique", "final-synthesis"],
  },
  {
    id: "source-discipline",
    title: "Source Discipline",
    summary: "Evidence posture.",
    file: "source-discipline.md",
    jobTypes: ["research"],
    assetClasses: ["equity"],
    depths: ["brief", "deep"],
    stages: ["critique", "final-synthesis"],
  },
];

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function makePromptDir(
  files: Record<string, string>,
): Promise<{ readonly dir: string; readonly cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "playbook-test-"));
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

function registryJson(playbooks: readonly unknown[]): string {
  return JSON.stringify({ playbooks });
}

describe("loadPlaybookRegistry", () => {
  test("validates registry entries from JSON", async () => {
    const { dir, cleanup } = await makePromptDir({
      "playbooks/registry.json": registryJson([registry[0]]),
    });
    cleanups.push(cleanup);

    const result = await loadPlaybookRegistry(dir);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(registry[0]);
  });

  test("rejects duplicate ids and invalid stages", async () => {
    const duplicate = await makePromptDir({
      "playbooks/registry.json": registryJson([registry[0], registry[0]]),
    });
    cleanups.push(duplicate.cleanup);

    await expect(loadPlaybookRegistry(duplicate.dir)).rejects.toThrow("duplicate id");

    const invalid = await makePromptDir({
      "playbooks/registry.json": registryJson([{ ...registry[0], stages: ["evidence-request"] }]),
    });
    cleanups.push(invalid.cleanup);

    await expect(loadPlaybookRegistry(invalid.dir)).rejects.toThrow("invalid stage");
  });

  test("rejects malformed registry JSON with context", async () => {
    const { dir, cleanup } = await makePromptDir({
      "playbooks/registry.json": "{not-json",
    });
    cleanups.push(cleanup);

    await expect(loadPlaybookRegistry(dir)).rejects.toThrow(
      "Playbook registry file has invalid JSON",
    );
  });

  test("loads every real playbook file", async () => {
    const realRegistry = await loadPlaybookRegistry();
    const selected = realRegistry.map((playbook) => ({
      stage: playbook.stages[0] ?? "specialist-analysis",
      playbookIds: [playbook.id],
    }));

    const result = await loadPlaybooksByStage("prompts", realRegistry, selected);

    expect(result).toHaveLength(realRegistry.length);
    expect(
      result.flatMap((stage) => stage.playbooks).every((item) => item.instruction.length > 0),
    ).toBe(true);
  });

  test("synthesis-discipline teaches calibrated-probability discipline", async () => {
    const realRegistry = await loadPlaybookRegistry();
    const [stage] = await loadPlaybooksByStage("prompts", realRegistry, [
      { stage: "final-synthesis", playbookIds: ["synthesis-discipline"] },
    ]);
    const instruction = (stage?.playbooks[0]?.instruction ?? "").toLowerCase();

    // Base-rate anchoring, widen-on-thin-evidence, and the Brier cost of overconfidence.
    expect(instruction).toContain("base rate");
    expect(instruction).toContain("widen");
    expect(instruction).toContain("brier");
  });

  test("critique-discipline demands prediction-specific disconfirmation", async () => {
    const realRegistry = await loadPlaybookRegistry();
    const [stage] = await loadPlaybooksByStage("prompts", realRegistry, [
      { stage: "critique", playbookIds: ["critique-discipline"] },
    ]);
    const instruction = (stage?.playbooks[0]?.instruction ?? "").toLowerCase();

    // Strongest disconfirming case per prediction, plus probability/evidence-strength mismatch.
    expect(instruction).toContain("prediction");
    expect(instruction).toContain("disconfirm");
    expect(instruction).toContain("observable");
    // Evidence-strength mismatch flagging and the direction the probability should move.
    expect(instruction).toContain("probability");
    expect(instruction).toContain("evidence");
    expect(instruction).toContain("direction");
  });

  test("source-discipline labels evidence posture for research stages", async () => {
    const realRegistry = await loadPlaybookRegistry();
    const sourceDiscipline = realRegistry.find((playbook) => playbook.id === "source-discipline");
    const loaded = await loadPlaybooksByStage("prompts", realRegistry, [
      { stage: "critique", playbookIds: ["source-discipline"] },
      { stage: "final-synthesis", playbookIds: ["source-discipline"] },
    ]);
    const instruction = loaded
      .flatMap((stage) => stage.playbooks)
      .map((playbook) => playbook.instruction.toLowerCase())
      .join("\n");

    expect(sourceDiscipline).toMatchObject({
      jobTypes: ["research"],
      assetClasses: ["equity"],
      stages: ["critique", "final-synthesis"],
    });
    expect(instruction).toContain("observed fact");
    expect(instruction).toContain("issuer claim");
    expect(instruction).toContain("derived calculation");
    expect(instruction).toContain("model inference");
    expect(instruction).toContain("assumption");
    expect(instruction).toContain("stale evidence");
    expect(instruction).toContain("conflicting evidence");
    expect(instruction).toContain("missing required source");
  });
});

describe("eligiblePlaybookCandidates", () => {
  test("filters by command, depth, asset, and stage", () => {
    const result = eligiblePlaybookCandidates(
      { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      ["specialist-analysis", "market-behavior-analysis", "critique", "final-synthesis"],
      registry,
    );

    expect(result.map((candidate) => candidate.id)).toEqual([
      "critique-discipline",
      "synthesis-discipline",
    ]);
  });

  test("returns no candidates when no playbooks are eligible", () => {
    const result = eligiblePlaybookCandidates(
      { jobType: "ticker", assetClass: "crypto", symbol: "BTC", depth: "brief" },
      ["instrument-evidence-analysis"],
      [registry[0]!],
    );

    expect(result).toEqual([]);
  });

  test("makes research discipline playbooks eligible for their configured stages", () => {
    const result = eligiblePlaybookCandidates(
      { jobType: "research", assetClass: "equity", depth: "brief" },
      ["specialist-analysis", "critique", "final-synthesis"],
      registry,
    );

    expect(result).toEqual([
      {
        id: "synthesis-discipline",
        title: "Synthesis Discipline",
        summary: "Synthesize evidence.",
        eligibleStages: ["final-synthesis"],
      },
      {
        id: "source-discipline",
        title: "Source Discipline",
        summary: "Evidence posture.",
        eligibleStages: ["critique", "final-synthesis"],
      },
    ]);
  });
});

describe("mandatoryPlaybookSelections", () => {
  test("requires source-discipline for research critique and synthesis-discipline for final synthesis", () => {
    const candidates = eligiblePlaybookCandidates(
      { jobType: "research", assetClass: "equity", depth: "brief" },
      ["specialist-analysis", "critique", "final-synthesis"],
      registry,
    );

    expect(
      mandatoryPlaybookSelections(
        { jobType: "research", assetClass: "equity", depth: "brief" },
        ["specialist-analysis", "critique", "final-synthesis"],
        candidates,
      ),
    ).toEqual([
      { stage: "critique", playbookIds: ["source-discipline"] },
      { stage: "final-synthesis", playbookIds: ["synthesis-discipline"] },
    ]);
  });

  test("requires synthesis-discipline for eligible non-research final synthesis", () => {
    const candidates = eligiblePlaybookCandidates(
      { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      ["critique", "final-synthesis"],
      registry,
    );

    expect(
      mandatoryPlaybookSelections(
        { jobType: "ticker", assetClass: "equity", depth: "deep" },
        ["critique", "final-synthesis"],
        candidates,
      ),
    ).toEqual([{ stage: "final-synthesis", playbookIds: ["synthesis-discipline"] }]);
  });

  test("throws when required research source-discipline is missing from candidates", () => {
    expect(() =>
      mandatoryPlaybookSelections(
        { jobType: "research", assetClass: "crypto", depth: "brief" },
        ["critique", "final-synthesis"],
        [],
      ),
    ).toThrow(
      "Mandatory playbook source-discipline is not eligible for research source-discipline stages: critique",
    );
  });
});

describe("loadPlaybooksByStage", () => {
  test("loads instruction and optional goal sections", async () => {
    const { dir, cleanup } = await makePromptDir({
      "playbooks/market-regime.md":
        "## instruction\n\nUse regime evidence.\n\n## goal\n\nExplain regime.",
    });
    cleanups.push(cleanup);

    const result = await loadPlaybooksByStage(dir, registry, [
      { stage: "specialist-analysis", playbookIds: ["market-regime"] },
    ]);

    expect(result[0]?.playbooks[0]).toMatchObject({
      id: "market-regime",
      instruction: "Use regime evidence.",
      goal: "Explain regime.",
    });
  });

  test("rejects malformed markdown, missing files, and char cap overflow", async () => {
    const malformed = await makePromptDir({
      "playbooks/market-regime.md": "## goal\n\nNo instruction.",
    });
    cleanups.push(malformed.cleanup);

    await expect(
      loadPlaybooksByStage(malformed.dir, registry, [
        { stage: "specialist-analysis", playbookIds: ["market-regime"] },
      ]),
    ).rejects.toThrow("missing required ## instruction");

    const missing = await makePromptDir({});
    cleanups.push(missing.cleanup);

    await expect(
      loadPlaybooksByStage(missing.dir, registry, [
        { stage: "specialist-analysis", playbookIds: ["market-regime"] },
      ]),
    ).rejects.toThrow("Selected playbook file missing");

    const tooLong = await makePromptDir({
      "playbooks/market-regime.md": `## instruction\n\n${"a".repeat(2501)}`,
    });
    cleanups.push(tooLong.cleanup);

    await expect(
      loadPlaybooksByStage(tooLong.dir, registry, [
        { stage: "specialist-analysis", playbookIds: ["market-regime"] },
      ]),
    ).rejects.toThrow("exceeds 2500 characters");
  });
});

describe("parsePlaybookSelection", () => {
  const candidates = [
    {
      id: "market-regime",
      title: "Market Regime",
      summary: "Regime.",
      eligibleStages: ["specialist-analysis", "critique", "final-synthesis"] as const,
    },
    {
      id: "critique-discipline",
      title: "Critique Discipline",
      summary: "Critique.",
      eligibleStages: ["critique"] as const,
    },
    {
      id: "synthesis-discipline",
      title: "Synthesis Discipline",
      summary: "Synthesis.",
      eligibleStages: ["critique", "final-synthesis"] as const,
    },
    {
      id: "extra-discipline",
      title: "Extra Discipline",
      summary: "Extra.",
      eligibleStages: ["critique", "final-synthesis"] as const,
    },
  ];

  test("accepts valid selections and caps rationale length", () => {
    const result = parsePlaybookSelection(
      JSON.stringify({
        rationale: "x".repeat(600),
        selections: [
          { stage: "critique", playbookIds: ["market-regime", "critique-discipline"] },
          { stage: "final-synthesis", playbookIds: ["synthesis-discipline"] },
        ],
      }),
      candidates,
    );

    expect(result.selected).toEqual([
      { stage: "critique", playbookIds: ["market-regime", "critique-discipline"] },
      { stage: "final-synthesis", playbookIds: ["synthesis-discipline"] },
    ]);
    expect(result.rationale?.length).toBe(500);
    expect(result.rationale?.endsWith("...")).toBe(true);
    expect(result.rejected).toEqual([]);
  });

  test("rejects malformed JSON, unknown ids, duplicates, invalid stages, and caps", () => {
    expect(parsePlaybookSelection("not-json", candidates).rejected).toEqual([
      { reason: "selector returned malformed JSON" },
    ]);

    const result = parsePlaybookSelection(
      JSON.stringify({
        selections: [
          { stage: "evidence-request", playbookIds: ["market-regime"] },
          {
            stage: "critique",
            playbookIds: [
              "market-regime",
              "market-regime",
              "critique-discipline",
              "extra-discipline",
            ],
          },
          { stage: "final-synthesis", playbookIds: ["unknown"] },
        ],
      }),
      candidates,
    );

    expect(result.selected).toEqual([
      { stage: "critique", playbookIds: ["market-regime", "critique-discipline"] },
    ]);
    expect(result.rejected).toEqual([
      { stage: "evidence-request", reason: "invalid stage" },
      { stage: "critique", playbookId: "market-regime", reason: "duplicate selection" },
      {
        stage: "critique",
        playbookId: "extra-discipline",
        reason: "per-stage playbook cap exceeded",
      },
      { stage: "final-synthesis", playbookId: "unknown", reason: "playbook is not eligible" },
    ]);
  });

  test("enforces per-run cap", () => {
    const manyCandidates = Array.from({ length: 7 }, (_, idx) => ({
      id: `p${String(idx + 1)}`,
      title: `P${String(idx + 1)}`,
      summary: "Candidate.",
      eligibleStages: [
        "specialist-analysis",
        "market-behavior-analysis",
        "critique",
        "final-synthesis",
      ] as const,
    }));
    const result = parsePlaybookSelection(
      JSON.stringify({
        selections: [
          { stage: "specialist-analysis", playbookIds: ["p1", "p2"] },
          { stage: "critique", playbookIds: ["p3", "p4"] },
          { stage: "final-synthesis", playbookIds: ["p5", "p6"] },
          { stage: "market-behavior-analysis", playbookIds: ["p7"] },
        ],
      }),
      manyCandidates,
    );

    expect(result.selected.flatMap((selection) => selection.playbookIds)).toHaveLength(6);
    expect(result.rejected).toContainEqual({
      stage: "market-behavior-analysis",
      playbookId: "p7",
      reason: "per-run playbook cap exceeded",
    });
  });

  test("rejects selections when candidate list is empty", () => {
    const result = parsePlaybookSelection(
      JSON.stringify({
        selections: [{ stage: "critique", playbookIds: ["market-regime"] }],
      }),
      [],
    );

    expect(result.selected).toEqual([]);
    expect(result.rejected).toEqual([
      { stage: "critique", playbookId: "market-regime", reason: "playbook is not eligible" },
    ]);
  });

  test("aggregates repeated stage selections before enforcing stage cap", () => {
    const result = parsePlaybookSelection(
      JSON.stringify({
        selections: [
          { stage: "critique", playbookIds: ["market-regime"] },
          {
            stage: "critique",
            playbookIds: ["critique-discipline", "synthesis-discipline"],
          },
        ],
      }),
      candidates,
    );

    expect(result.selected).toEqual([
      { stage: "critique", playbookIds: ["market-regime", "critique-discipline"] },
    ]);
    expect(result.rejected).toEqual([
      {
        stage: "critique",
        playbookId: "synthesis-discipline",
        reason: "per-stage playbook cap exceeded",
      },
    ]);
  });

  test("preseeds mandatory selections before selector output", () => {
    const result = parsePlaybookSelection(
      JSON.stringify({
        selections: [{ stage: "critique", playbookIds: ["critique-discipline"] }],
      }),
      [
        ...candidates,
        {
          id: "source-discipline",
          title: "Source Discipline",
          summary: "Evidence posture.",
          eligibleStages: ["critique", "final-synthesis"] as const,
        },
      ],
      [
        { stage: "critique", playbookIds: ["source-discipline"] },
        { stage: "final-synthesis", playbookIds: ["synthesis-discipline"] },
      ],
    );

    expect(result.selected).toEqual([
      { stage: "critique", playbookIds: ["source-discipline", "critique-discipline"] },
      { stage: "final-synthesis", playbookIds: ["synthesis-discipline"] },
    ]);
    expect(result.rejected).toEqual([]);
  });

  test("does not reject selector repeats of mandatory selections as duplicates", () => {
    const result = parsePlaybookSelection(
      JSON.stringify({
        selections: [
          { stage: "critique", playbookIds: ["source-discipline", "critique-discipline"] },
          { stage: "final-synthesis", playbookIds: ["synthesis-discipline"] },
        ],
      }),
      [
        ...candidates,
        {
          id: "source-discipline",
          title: "Source Discipline",
          summary: "Evidence posture.",
          eligibleStages: ["critique", "final-synthesis"] as const,
        },
      ],
      [
        { stage: "critique", playbookIds: ["source-discipline"] },
        { stage: "final-synthesis", playbookIds: ["synthesis-discipline"] },
      ],
    );

    expect(result.selected).toEqual([
      { stage: "critique", playbookIds: ["source-discipline", "critique-discipline"] },
      { stage: "final-synthesis", playbookIds: ["synthesis-discipline"] },
    ]);
    expect(result.rejected).toEqual([]);
  });

  test("keeps mandatory selections when selector output is malformed", () => {
    const result = parsePlaybookSelection(
      "not-json",
      [
        ...candidates,
        {
          id: "source-discipline",
          title: "Source Discipline",
          summary: "Evidence posture.",
          eligibleStages: ["critique", "final-synthesis"] as const,
        },
      ],
      [
        { stage: "critique", playbookIds: ["source-discipline"] },
        { stage: "final-synthesis", playbookIds: ["synthesis-discipline"] },
      ],
    );

    expect(result.selected).toEqual([
      { stage: "critique", playbookIds: ["source-discipline"] },
      { stage: "final-synthesis", playbookIds: ["synthesis-discipline"] },
    ]);
    expect(result.rejected).toEqual([{ reason: "selector returned malformed JSON" }]);
  });

  test("throws when mandatory selections exceed the per-run cap", () => {
    const manyCandidates = Array.from({ length: 7 }, (_, idx) => ({
      id: `p${String(idx + 1)}`,
      title: `P${String(idx + 1)}`,
      summary: "Candidate.",
      eligibleStages: [
        "specialist-analysis",
        "market-behavior-analysis",
        "critique",
        "final-synthesis",
      ] as const,
    }));

    expect(() =>
      parsePlaybookSelection(JSON.stringify({ selections: [] }), manyCandidates, [
        { stage: "specialist-analysis", playbookIds: ["p1", "p2"] },
        { stage: "critique", playbookIds: ["p3", "p4"] },
        { stage: "final-synthesis", playbookIds: ["p5", "p6"] },
        { stage: "market-behavior-analysis", playbookIds: ["p7"] },
      ]),
    ).toThrow(
      "Mandatory playbook p7 for market-behavior-analysis failed: per-run playbook cap exceeded",
    );
  });
});
