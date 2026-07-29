import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readCodeVersion } from "../src/code-version";
import {
  DEEP_EQUITY_OPERATOR_GATE_RECORD_TYPE,
  deepEquityEvaluationRootIdentifier,
  readDeepEquityOperatorGateRecord,
  validateDeepEquityOperatorGateRecord,
  type DeepEquityOperatorGateKey,
  type DeepEquityOperatorGateValidationContext,
} from "./support/deep-equity-operator-gates";

const FALSE_OPERATOR_INPUTS = {
  zeroCriticalMaterialEvidenceOmissionsAfterAdjudication: false,
  humanReviewApproved: false,
  liveSmokePassed: false,
} as const;
const tempRoots: string[] = [];

interface TempApprovalPaths {
  readonly repositoryRoot: string;
  readonly repositoryCommit: string;
  readonly root: string;
  readonly recordPath: string;
  readonly evaluationRootIdentifier: string;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function runGit(repositoryRoot: string, args: readonly string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr).trim()}`,
    );
  }
}

async function tempApprovalPaths(name: string): Promise<TempApprovalPaths> {
  const repositoryRoot = await mkdtemp(join(tmpdir(), `market-bot-operator-gates-${name}-`));
  tempRoots.push(repositoryRoot);
  runGit(repositoryRoot, ["init", "--quiet"]);
  runGit(repositoryRoot, ["config", "user.email", "operator-gates@example.invalid"]);
  runGit(repositoryRoot, ["config", "user.name", "Operator Gate Tests"]);
  await writeFile(join(repositoryRoot, "baseline.txt"), "baseline\n", "utf8");
  runGit(repositoryRoot, ["add", "baseline.txt"]);
  runGit(repositoryRoot, ["commit", "--quiet", "-m", "test baseline"]);
  const approvalDirectory = join(repositoryRoot, "operator-approvals", "deep-equity", name);
  await mkdir(approvalDirectory, { recursive: true });
  const evaluationRoot = join(repositoryRoot, "evaluation");
  await mkdir(evaluationRoot);
  return {
    repositoryRoot,
    repositoryCommit: currentCommit(repositoryRoot),
    root: evaluationRoot,
    recordPath: join(approvalDirectory, "approval.json"),
    evaluationRootIdentifier: deepEquityEvaluationRootIdentifier(evaluationRoot, repositoryRoot),
  };
}

function currentCommit(repositoryRoot: string): string {
  const { commit } = readCodeVersion(repositoryRoot);
  if (commit === undefined) {
    throw new Error("Tests require a repository HEAD commit.");
  }
  return commit;
}

function validRecord(
  paths: TempApprovalPaths,
  gateOverrides: Partial<Record<DeepEquityOperatorGateKey, unknown>> = {},
  envelopeOverrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    recordType: DEEP_EQUITY_OPERATOR_GATE_RECORD_TYPE,
    authentication: "none",
    evaluationRoot: paths.evaluationRootIdentifier,
    repositoryCommit: paths.repositoryCommit,
    statedBy: "repository-owner@example.invalid",
    statedOn: "2026-07-29",
    statedVerdicts: {
      zeroCriticalMaterialEvidenceOmissionsAfterAdjudication: {
        verdict: true,
        rationale: "The adjudicated omission ledger contains no critical material omissions.",
      },
      humanReviewApproved: {
        verdict: true,
        rationale: "The blinded reports were reviewed against the cutover rubric.",
      },
      liveSmokePassed: {
        verdict: true,
        rationale: "The separately authorized live-smoke matrix completed successfully.",
      },
      ...gateOverrides,
    },
    ...envelopeOverrides,
  };
}

function cleanValidationContext(
  overrides: Partial<DeepEquityOperatorGateValidationContext> = {},
): DeepEquityOperatorGateValidationContext {
  return {
    sourcePath: "operator-approvals/deep-equity/approval.json",
    checkedEvaluationRoot: "evaluation",
    checkedRepositoryCommit: "a".repeat(40),
    checkedRepositoryTree: {
      status: "clean",
      dirty: false,
      dirtyPathCount: 0,
      dirtyPathSample: [],
      offendingPathCount: 0,
      offendingPathSample: [],
    },
    repositoryRoot: resolve("."),
    ...overrides,
  };
}

const DIRECT_VALIDATION_PATHS: TempApprovalPaths = {
  repositoryRoot: resolve("."),
  repositoryCommit: "a".repeat(40),
  root: "evaluation",
  recordPath: "operator-approvals/deep-equity/approval.json",
  evaluationRootIdentifier: "evaluation",
};

const ENVELOPE_REJECTION_CASES: {
  readonly name: string;
  readonly value: unknown;
}[] = [
  {
    name: "a non-object record",
    value: null,
  },
  {
    name: "an unsupported schema version",
    value: validRecord(DIRECT_VALIDATION_PATHS, {}, { schemaVersion: 2 }),
  },
  {
    name: "an unexpected record type",
    value: validRecord(DIRECT_VALIDATION_PATHS, {}, { recordType: "unexpected-record" }),
  },
  {
    name: "a missing evaluation root",
    value: validRecord(DIRECT_VALIDATION_PATHS, {}, { evaluationRoot: undefined }),
  },
  {
    name: "an invalid repository commit",
    value: validRecord(DIRECT_VALIDATION_PATHS, {}, { repositoryCommit: "abc123" }),
  },
  {
    name: "an invalid stated date",
    value: validRecord(DIRECT_VALIDATION_PATHS, {}, { statedOn: "2026-02-30" }),
  },
  {
    name: "a non-object stated verdict collection",
    value: validRecord(DIRECT_VALIDATION_PATHS, {}, { statedVerdicts: [] }),
  },
];

async function writeRecord(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("deep-equity operator gate record", () => {
  test.each(ENVELOPE_REJECTION_CASES)("$name fails envelope validation", ({ value }) => {
    const audit = validateDeepEquityOperatorGateRecord(value, cleanValidationContext());

    expect(audit.status).toBe("rejected");
    expect(audit.effectiveInputs).toEqual(FALSE_OPERATOR_INPUTS);
    expect(audit.rejectionReasons.map((reason) => reason.code)).toContain("schema-violation");
  });

  test.each([
    {
      name: "a non-object gate statement",
      gate: "humanReviewApproved" as const,
      value: "approved",
    },
    {
      name: "a non-boolean gate verdict",
      gate: "liveSmokePassed" as const,
      value: { verdict: "true", rationale: "The live-smoke matrix passed." },
    },
  ])("$name rejects that gate and marks the record gate-rejected", ({ gate, value }) => {
    const audit = validateDeepEquityOperatorGateRecord(
      validRecord(DIRECT_VALIDATION_PATHS, { [gate]: value }),
      cleanValidationContext(),
    );

    expect(audit.status).toBe("gate-rejected");
    expect(audit.gates[gate].status).toBe("rejected");
    expect(audit.gates[gate].effectiveVerdict).toBe(false);
    expect(audit.gates[gate].rejectionReasons?.map((reason) => reason.code)).toEqual([
      "gate-schema-violation",
    ]);
  });

  test("an unavailable repository HEAD rejects an otherwise valid record", () => {
    const audit = validateDeepEquityOperatorGateRecord(
      validRecord(DIRECT_VALIDATION_PATHS),
      cleanValidationContext({ checkedRepositoryCommit: null }),
    );

    expect(audit.status).toBe("rejected");
    expect(audit.effectiveInputs).toEqual(FALSE_OPERATOR_INPUTS);
    expect(audit.rejectionReasons.map((reason) => reason.code)).toEqual([
      "repository-head-unavailable",
    ]);
  });

  test("normalizes the stated evaluation root before exact comparison", () => {
    const audit = validateDeepEquityOperatorGateRecord(
      validRecord(DIRECT_VALIDATION_PATHS, {}, { evaluationRoot: "evaluation/" }),
      cleanValidationContext(),
    );

    expect(audit.status).toBe("accepted");
    expect(audit.statedEvaluationRoot).toBe("evaluation/");
    expect(audit.checkedEvaluationRoot).toBe("evaluation");
  });

  test("no record supplied fails all three gates and records the distinct state", async () => {
    const paths = await tempApprovalPaths("not-supplied");

    const audit = await readDeepEquityOperatorGateRecord({
      evaluationRoot: paths.root,
      repositoryRoot: paths.repositoryRoot,
    });

    expect(audit.status).toBe("not-supplied");
    expect(audit.sourcePath).toBeNull();
    expect(audit.effectiveInputs).toEqual(FALSE_OPERATOR_INPUTS);
    expect(audit.gates.humanReviewApproved.status).toBe("not-supplied");
  });

  test("an absent record at the supplied path fails closed with a read rejection", async () => {
    const paths = await tempApprovalPaths("absent");

    const audit = await readDeepEquityOperatorGateRecord({
      approvalRecordPath: join(dirname(paths.recordPath), "missing.json"),
      evaluationRoot: paths.root,
      repositoryRoot: paths.repositoryRoot,
    });

    expect(audit.status).toBe("rejected");
    expect(audit.effectiveInputs).toEqual(FALSE_OPERATOR_INPUTS);
    expect(audit.rejectionReasons.map((reason) => reason.code)).toEqual(["read-failure"]);
  });

  test("malformed JSON fails closed and records that parsing failed", async () => {
    const paths = await tempApprovalPaths("malformed");
    await writeFile(paths.recordPath, "{not-json", "utf8");

    const audit = await readDeepEquityOperatorGateRecord({
      approvalRecordPath: paths.recordPath,
      evaluationRoot: paths.root,
      repositoryRoot: paths.repositoryRoot,
    });

    expect(audit.status).toBe("rejected");
    expect(audit.effectiveInputs).toEqual(FALSE_OPERATOR_INPUTS);
    expect(audit.rejectionReasons.map((reason) => reason.code)).toEqual(["invalid-json"]);
  });

  test("an envelope schema violation fails all three gates", async () => {
    const paths = await tempApprovalPaths("schema-invalid");
    await writeRecord(paths.recordPath, validRecord(paths, {}, { statedBy: undefined }));

    const audit = await readDeepEquityOperatorGateRecord({
      approvalRecordPath: paths.recordPath,
      evaluationRoot: paths.root,
      repositoryRoot: paths.repositoryRoot,
    });

    expect(audit.status).toBe("rejected");
    expect(audit.effectiveInputs).toEqual(FALSE_OPERATOR_INPUTS);
    expect(audit.rejectionReasons.map((reason) => reason.code)).toContain("schema-violation");
  });

  test("an authentication claim other than none is a schema violation", async () => {
    const paths = await tempApprovalPaths("authentication");
    await writeRecord(paths.recordPath, validRecord(paths, {}, { authentication: "verified" }));

    const audit = await readDeepEquityOperatorGateRecord({
      approvalRecordPath: paths.recordPath,
      evaluationRoot: paths.root,
      repositoryRoot: paths.repositoryRoot,
    });

    expect(audit.status).toBe("rejected");
    expect(audit.effectiveInputs).toEqual(FALSE_OPERATOR_INPUTS);
    expect(audit.rejectionReasons).toContainEqual({
      code: "schema-violation",
      message: 'authentication must explicitly equal "none".',
    });
  });

  test("an evaluation-root mismatch fails all three gates and records the mismatch", async () => {
    const paths = await tempApprovalPaths("root-mismatch");
    await writeRecord(
      paths.recordPath,
      validRecord(paths, {}, { evaluationRoot: "data/evaluations/a-different-run" }),
    );

    const audit = await readDeepEquityOperatorGateRecord({
      approvalRecordPath: paths.recordPath,
      evaluationRoot: paths.root,
      repositoryRoot: paths.repositoryRoot,
    });

    expect(audit.status).toBe("rejected");
    expect(audit.effectiveInputs).toEqual(FALSE_OPERATOR_INPUTS);
    expect(audit.rejectionReasons.map((reason) => reason.code)).toEqual([
      "evaluation-root-mismatch",
    ]);
  });

  test("a repository-commit mismatch fails all three gates and records the mismatch", async () => {
    const paths = await tempApprovalPaths("commit-mismatch");
    await writeRecord(
      paths.recordPath,
      validRecord(paths, {}, { repositoryCommit: "0".repeat(40) }),
    );

    const audit = await readDeepEquityOperatorGateRecord({
      approvalRecordPath: paths.recordPath,
      evaluationRoot: paths.root,
      repositoryRoot: paths.repositoryRoot,
    });

    expect(audit.status).toBe("rejected");
    expect(audit.effectiveInputs).toEqual(FALSE_OPERATOR_INPUTS);
    expect(audit.rejectionReasons.map((reason) => reason.code)).toEqual([
      "repository-commit-mismatch",
    ]);
  });

  test("an empty per-gate rationale rejects only that gate", async () => {
    const paths = await tempApprovalPaths("empty-rationale");
    await writeRecord(
      paths.recordPath,
      validRecord(paths, {
        humanReviewApproved: { verdict: true, rationale: "   " },
      }),
    );

    const audit = await readDeepEquityOperatorGateRecord({
      approvalRecordPath: paths.recordPath,
      evaluationRoot: paths.root,
      repositoryRoot: paths.repositoryRoot,
    });

    expect(audit.status).toBe("gate-rejected");
    expect(audit.effectiveInputs).toEqual({
      zeroCriticalMaterialEvidenceOmissionsAfterAdjudication: true,
      humanReviewApproved: false,
      liveSmokePassed: true,
    });
    expect(audit.gates.humanReviewApproved.status).toBe("rejected");
  });

  test("a missing per-gate rationale rejects only that gate", async () => {
    const paths = await tempApprovalPaths("missing-rationale");
    await writeRecord(
      paths.recordPath,
      validRecord(paths, {
        liveSmokePassed: { verdict: true },
      }),
    );

    const audit = await readDeepEquityOperatorGateRecord({
      approvalRecordPath: paths.recordPath,
      evaluationRoot: paths.root,
      repositoryRoot: paths.repositoryRoot,
    });

    expect(audit.status).toBe("gate-rejected");
    expect(audit.effectiveInputs).toEqual({
      zeroCriticalMaterialEvidenceOmissionsAfterAdjudication: true,
      humanReviewApproved: true,
      liveSmokePassed: false,
    });
    expect(audit.gates.liveSmokePassed.status).toBe("rejected");
  });

  test("matching bindings and three rationalized true verdicts produce three true inputs", async () => {
    const paths = await tempApprovalPaths("accepted");
    await writeRecord(paths.recordPath, validRecord(paths));

    const audit = await readDeepEquityOperatorGateRecord({
      approvalRecordPath: paths.recordPath,
      evaluationRoot: paths.root,
      repositoryRoot: paths.repositoryRoot,
    });

    expect(audit.status).toBe("accepted");
    expect(audit.authentication).toBe("none");
    expect(audit.checkedRepositoryTree).toEqual({
      status: "approval-record-only",
      dirty: true,
      dirtyPathCount: 1,
      dirtyPathSample: ["operator-approvals/deep-equity/accepted/approval.json"],
      offendingPathCount: 0,
      offendingPathSample: [],
    });
    expect(audit.effectiveInputs).toEqual({
      zeroCriticalMaterialEvidenceOmissionsAfterAdjudication: true,
      humanReviewApproved: true,
      liveSmokePassed: true,
    });
  });

  test("an explicit false verdict is accepted and differs from no record supplied", async () => {
    const paths = await tempApprovalPaths("explicit-false");
    await writeRecord(
      paths.recordPath,
      validRecord(paths, {
        humanReviewApproved: {
          verdict: false,
          rationale: "The operator found an unresolved blinded-review concern.",
        },
      }),
    );

    const [recorded, absent] = await Promise.all([
      readDeepEquityOperatorGateRecord({
        approvalRecordPath: paths.recordPath,
        evaluationRoot: paths.root,
        repositoryRoot: paths.repositoryRoot,
      }),
      readDeepEquityOperatorGateRecord({
        evaluationRoot: paths.root,
        repositoryRoot: paths.repositoryRoot,
      }),
    ]);

    expect(recorded.status).toBe("accepted");
    expect(recorded.gates.humanReviewApproved).toMatchObject({
      status: "accepted",
      statedVerdict: false,
      effectiveVerdict: false,
      rationale: "The operator found an unresolved blinded-review concern.",
    });
    expect(absent.status).toBe("not-supplied");
    expect(absent.gates.humanReviewApproved.status).toBe("not-supplied");
  });

  test("an unrelated dirty path rejects the record and persists bounded tree evidence", async () => {
    const paths = await tempApprovalPaths("dirty-unrelated");
    await writeRecord(paths.recordPath, validRecord(paths));
    await writeFile(join(paths.repositoryRoot, "unrelated.txt"), "uncommitted change\n", "utf8");

    const audit = await readDeepEquityOperatorGateRecord({
      approvalRecordPath: paths.recordPath,
      evaluationRoot: paths.root,
      repositoryRoot: paths.repositoryRoot,
    });

    expect(audit.status).toBe("rejected");
    expect(audit.effectiveInputs).toEqual(FALSE_OPERATOR_INPUTS);
    expect(audit.rejectionReasons).toContainEqual({
      code: "repository-worktree-dirty",
      message:
        "Repository worktree has 1 dirty path(s) other than the approval record. Sample: unrelated.txt.",
    });
    expect(audit.checkedRepositoryTree).toEqual({
      status: "dirty",
      dirty: true,
      dirtyPathCount: 2,
      dirtyPathSample: [
        "operator-approvals/deep-equity/dirty-unrelated/approval.json",
        "unrelated.txt",
      ],
      offendingPathCount: 1,
      offendingPathSample: ["unrelated.txt"],
    });
  });

  test("a record path outside the repository is rejected before reading", async () => {
    const paths = await tempApprovalPaths("outside-repository");
    const outsideRoot = await mkdtemp(join(tmpdir(), "market-bot-operator-gates-outside-"));
    tempRoots.push(outsideRoot);
    const outsidePath = join(outsideRoot, "approval.json");
    await writeRecord(outsidePath, validRecord(paths));

    const audit = await readDeepEquityOperatorGateRecord({
      approvalRecordPath: outsidePath,
      evaluationRoot: paths.root,
      repositoryRoot: paths.repositoryRoot,
    });

    expect(audit.status).toBe("rejected");
    expect(audit.rejectionReasons.map((reason) => reason.code)).toContain(
      "approval-path-outside-repository",
    );
  });

  test("a record path outside the designated directory is rejected before reading", async () => {
    const paths = await tempApprovalPaths("outside-designated");
    const undesignatedPath = join(paths.repositoryRoot, "approval.json");
    await writeRecord(undesignatedPath, validRecord(paths));

    const audit = await readDeepEquityOperatorGateRecord({
      approvalRecordPath: undesignatedPath,
      evaluationRoot: paths.root,
      repositoryRoot: paths.repositoryRoot,
    });

    expect(audit.status).toBe("rejected");
    expect(audit.rejectionReasons.map((reason) => reason.code)).toContain(
      "approval-path-outside-designated-directory",
    );
  });

  test("a designated junction resolving outside the repository is rejected", async () => {
    const paths = await tempApprovalPaths("realpath-outside-repository");
    const outsideRoot = await mkdtemp(join(tmpdir(), "market-bot-operator-gates-target-"));
    tempRoots.push(outsideRoot);
    await writeRecord(join(outsideRoot, "approval.json"), validRecord(paths));
    const linkPath = join(
      paths.repositoryRoot,
      "operator-approvals",
      "deep-equity",
      "outside-link",
    );
    await symlink(outsideRoot, linkPath, process.platform === "win32" ? "junction" : "dir");

    const audit = await readDeepEquityOperatorGateRecord({
      approvalRecordPath: join(linkPath, "approval.json"),
      evaluationRoot: paths.root,
      repositoryRoot: paths.repositoryRoot,
    });

    expect(audit.status).toBe("rejected");
    expect(audit.rejectionReasons.map((reason) => reason.code)).toContain(
      "approval-path-outside-repository",
    );
  });

  test("a designated junction resolving elsewhere in the repository is rejected", async () => {
    const paths = await tempApprovalPaths("realpath-outside-designated");
    const undesignatedDirectory = join(paths.repositoryRoot, "undesignated");
    await mkdir(undesignatedDirectory);
    await writeRecord(join(undesignatedDirectory, "approval.json"), validRecord(paths));
    const linkPath = join(paths.repositoryRoot, "operator-approvals", "deep-equity", "inside-link");
    await symlink(
      undesignatedDirectory,
      linkPath,
      process.platform === "win32" ? "junction" : "dir",
    );

    const audit = await readDeepEquityOperatorGateRecord({
      approvalRecordPath: join(linkPath, "approval.json"),
      evaluationRoot: paths.root,
      repositoryRoot: paths.repositoryRoot,
    });

    expect(audit.status).toBe("rejected");
    expect(audit.rejectionReasons.map((reason) => reason.code)).toContain(
      "approval-path-outside-designated-directory",
    );
  });

  test("a record path under data is rejected without reading it", async () => {
    const paths = await tempApprovalPaths("under-data");

    const audit = await readDeepEquityOperatorGateRecord({
      approvalRecordPath: join(paths.repositoryRoot, "data", "operator-approval.json"),
      evaluationRoot: paths.root,
      repositoryRoot: paths.repositoryRoot,
    });

    expect(audit.status).toBe("rejected");
    expect(audit.effectiveInputs).toEqual(FALSE_OPERATOR_INPUTS);
    expect(audit.rejectionReasons.map((reason) => reason.code)).toEqual([
      "approval-path-under-data",
    ]);
  });
});
