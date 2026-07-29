import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { readCodeVersion } from "../../src/code-version";
import { isRecord, readString } from "../../src/guards";

export const DEEP_EQUITY_OPERATOR_GATE_RECORD_TYPE =
  "unauthenticated-human-stated-deep-equity-gate-verdicts";

export const DEEP_EQUITY_OPERATOR_GATE_KEYS = [
  "zeroCriticalMaterialEvidenceOmissionsAfterAdjudication",
  "humanReviewApproved",
  "liveSmokePassed",
] as const;

export type DeepEquityOperatorGateKey = (typeof DEEP_EQUITY_OPERATOR_GATE_KEYS)[number];

export interface DeepEquityOperatorGateEffectiveInputs {
  readonly zeroCriticalMaterialEvidenceOmissionsAfterAdjudication: boolean;
  readonly humanReviewApproved: boolean;
  readonly liveSmokePassed: boolean;
}

export interface DeepEquityOperatorGateRejection {
  readonly code:
    | "approval-path-outside-repository"
    | "approval-path-outside-designated-directory"
    | "approval-path-under-data"
    | "invalid-json"
    | "read-failure"
    | "repository-head-unavailable"
    | "repository-index-flags-set"
    | "repository-worktree-dirty"
    | "repository-worktree-status-unavailable"
    | "schema-violation"
    | "evaluation-root-mismatch"
    | "repository-commit-mismatch"
    | "gate-schema-violation";
  readonly message: string;
}

export interface DeepEquityRepositoryTreeAudit {
  readonly status: "clean" | "approval-record-only" | "dirty" | "index-flags-set" | "unavailable";
  readonly dirty: boolean;
  readonly dirtyPathCount: number;
  readonly dirtyPathSample: readonly string[];
  readonly offendingPathCount: number;
  readonly offendingPathSample: readonly string[];
  readonly indexFlaggedPathCount: number;
  readonly indexFlaggedPathSample: readonly string[];
}

export interface DeepEquityOperatorGateAudit {
  readonly status: "not-supplied" | "rejected" | "gate-rejected" | "accepted";
  readonly recordType: typeof DEEP_EQUITY_OPERATOR_GATE_RECORD_TYPE;
  readonly authentication: "none";
  readonly authenticationNotice: string;
  readonly sourcePath: string | null;
  readonly checkedEvaluationRoot: string;
  readonly checkedRepositoryCommit: string | null;
  readonly checkedRepositoryTree: DeepEquityRepositoryTreeAudit;
  readonly rejectionReasons: readonly DeepEquityOperatorGateRejection[];
  readonly statedBy?: string;
  readonly statedOn?: string;
  readonly statedEvaluationRoot?: string;
  readonly statedRepositoryCommit?: string;
  readonly gates: Readonly<
    Record<
      DeepEquityOperatorGateKey,
      {
        readonly status: "not-supplied" | "record-rejected" | "rejected" | "accepted";
        readonly statedVerdict?: boolean;
        readonly effectiveVerdict: boolean;
        readonly rationale?: string;
        readonly rejectionReasons?: readonly DeepEquityOperatorGateRejection[];
      }
    >
  >;
  readonly effectiveInputs: DeepEquityOperatorGateEffectiveInputs;
}

interface ValidatedRecordEnvelope {
  readonly evaluationRoot: string;
  readonly repositoryCommit: string;
  readonly statedBy: string;
  readonly statedOn: string;
  readonly statedVerdicts: Record<string, unknown>;
}

export interface DeepEquityOperatorGateValidationContext {
  readonly sourcePath: string | null;
  readonly checkedEvaluationRoot: string;
  readonly checkedRepositoryCommit: string | null;
  readonly checkedRepositoryTree: DeepEquityRepositoryTreeAudit;
  readonly repositoryRoot: string;
}

const AUTHENTICATION_NOTICE =
  "This record contains human-stated verdicts only; it has no cryptographic signature or verified identity.";
const FULL_GIT_COMMIT = /^[0-9a-f]{40}$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const DIRTY_PATH_SAMPLE_LIMIT = 5;

function falseEffectiveInputs(): DeepEquityOperatorGateEffectiveInputs {
  return {
    zeroCriticalMaterialEvidenceOmissionsAfterAdjudication: false,
    humanReviewApproved: false,
    liveSmokePassed: false,
  };
}

function uniformGateAudits(
  status: "not-supplied" | "record-rejected",
): DeepEquityOperatorGateAudit["gates"] {
  return {
    zeroCriticalMaterialEvidenceOmissionsAfterAdjudication: {
      status,
      effectiveVerdict: false,
    },
    humanReviewApproved: { status, effectiveVerdict: false },
    liveSmokePassed: { status, effectiveVerdict: false },
  };
}

function baseAudit(
  context: DeepEquityOperatorGateValidationContext,
): Pick<
  DeepEquityOperatorGateAudit,
  | "recordType"
  | "authentication"
  | "authenticationNotice"
  | "sourcePath"
  | "checkedEvaluationRoot"
  | "checkedRepositoryCommit"
  | "checkedRepositoryTree"
> {
  return {
    recordType: DEEP_EQUITY_OPERATOR_GATE_RECORD_TYPE,
    authentication: "none",
    authenticationNotice: AUTHENTICATION_NOTICE,
    sourcePath: context.sourcePath,
    checkedEvaluationRoot: context.checkedEvaluationRoot,
    checkedRepositoryCommit: context.checkedRepositoryCommit,
    checkedRepositoryTree: context.checkedRepositoryTree,
  };
}

function repositoryTreeRejections(
  context: DeepEquityOperatorGateValidationContext,
): readonly DeepEquityOperatorGateRejection[] {
  const tree = context.checkedRepositoryTree;
  if (tree.status === "unavailable") {
    return [
      {
        code: "repository-worktree-status-unavailable",
        message: "Repository worktree status could not be resolved at evaluation time.",
      },
    ];
  }
  const rejections: DeepEquityOperatorGateRejection[] = [];
  if (tree.offendingPathCount > 0) {
    const sample =
      tree.offendingPathSample.length === 0
        ? ""
        : ` Sample: ${tree.offendingPathSample.join(", ")}.`;
    rejections.push({
      code: "repository-worktree-dirty",
      message: `Repository worktree has ${String(tree.offendingPathCount)} dirty path(s) other than the approval record.${sample}`,
    });
  }
  if (tree.indexFlaggedPathCount > 0) {
    const sample =
      tree.indexFlaggedPathSample.length === 0
        ? ""
        : ` Sample: ${tree.indexFlaggedPathSample.join(", ")}.`;
    rejections.push({
      code: "repository-index-flags-set",
      message: `Repository index has ${String(tree.indexFlaggedPathCount)} tracked path(s) with non-default flags.${sample}`,
    });
  }
  return rejections;
}

function rejectedAudit(
  context: DeepEquityOperatorGateValidationContext,
  rejectionReasons: readonly DeepEquityOperatorGateRejection[],
  envelope?: ValidatedRecordEnvelope,
): DeepEquityOperatorGateAudit {
  const allRejectionReasons = [...rejectionReasons, ...repositoryTreeRejections(context)];
  return {
    status: "rejected",
    ...baseAudit(context),
    rejectionReasons: allRejectionReasons,
    ...(envelope === undefined
      ? {}
      : {
          statedBy: envelope.statedBy,
          statedOn: envelope.statedOn,
          statedEvaluationRoot: envelope.evaluationRoot,
          statedRepositoryCommit: envelope.repositoryCommit,
        }),
    gates: uniformGateAudits("record-rejected"),
    effectiveInputs: falseEffectiveInputs(),
  };
}

function validIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validateEnvelope(value: unknown): {
  readonly envelope?: ValidatedRecordEnvelope;
  readonly rejectionReasons: readonly DeepEquityOperatorGateRejection[];
} {
  if (!isRecord(value)) {
    return {
      rejectionReasons: [
        { code: "schema-violation", message: "The approval record must be a JSON object." },
      ],
    };
  }
  const rejectionReasons: DeepEquityOperatorGateRejection[] = [];
  if (value.schemaVersion !== 1) {
    rejectionReasons.push({
      code: "schema-violation",
      message: "schemaVersion must equal 1.",
    });
  }
  if (value.recordType !== DEEP_EQUITY_OPERATOR_GATE_RECORD_TYPE) {
    rejectionReasons.push({
      code: "schema-violation",
      message: `recordType must equal ${DEEP_EQUITY_OPERATOR_GATE_RECORD_TYPE}.`,
    });
  }
  if (value.authentication !== "none") {
    rejectionReasons.push({
      code: "schema-violation",
      message: 'authentication must explicitly equal "none".',
    });
  }
  const evaluationRoot = readString(value, "evaluationRoot");
  if (evaluationRoot === undefined) {
    rejectionReasons.push({
      code: "schema-violation",
      message: "evaluationRoot must be a non-empty string.",
    });
  }
  const repositoryCommit = readString(value, "repositoryCommit");
  if (repositoryCommit === undefined || !FULL_GIT_COMMIT.test(repositoryCommit)) {
    rejectionReasons.push({
      code: "schema-violation",
      message: "repositoryCommit must be a full lowercase 40-character Git commit.",
    });
  }
  const statedBy = readString(value, "statedBy");
  if (statedBy === undefined) {
    rejectionReasons.push({
      code: "schema-violation",
      message: "statedBy must be a non-empty operator identifier.",
    });
  }
  const statedOn = readString(value, "statedOn");
  if (statedOn === undefined || !validIsoDate(statedOn)) {
    rejectionReasons.push({
      code: "schema-violation",
      message: "statedOn must be a valid ISO calendar date in YYYY-MM-DD form.",
    });
  }
  if (!isRecord(value.statedVerdicts)) {
    rejectionReasons.push({
      code: "schema-violation",
      message: "statedVerdicts must be an object with one entry per operator gate.",
    });
  }
  if (
    rejectionReasons.length > 0 ||
    evaluationRoot === undefined ||
    repositoryCommit === undefined ||
    statedBy === undefined ||
    statedOn === undefined ||
    !isRecord(value.statedVerdicts)
  ) {
    return { rejectionReasons };
  }
  return {
    envelope: {
      evaluationRoot,
      repositoryCommit,
      statedBy,
      statedOn,
      statedVerdicts: value.statedVerdicts,
    },
    rejectionReasons: [],
  };
}

function validateGate(
  statedVerdicts: Record<string, unknown>,
  gate: DeepEquityOperatorGateKey,
): DeepEquityOperatorGateAudit["gates"][DeepEquityOperatorGateKey] {
  const value = statedVerdicts[gate];
  const rejectionReasons: DeepEquityOperatorGateRejection[] = [];
  if (!isRecord(value)) {
    rejectionReasons.push({
      code: "gate-schema-violation",
      message: `${gate} must be an object.`,
    });
    return { status: "rejected", effectiveVerdict: false, rejectionReasons };
  }
  const statedVerdict = typeof value.verdict === "boolean" ? value.verdict : undefined;
  if (statedVerdict === undefined) {
    rejectionReasons.push({
      code: "gate-schema-violation",
      message: `${gate}.verdict must be boolean.`,
    });
  }
  const rationale = readString(value, "rationale");
  if (rationale === undefined) {
    rejectionReasons.push({
      code: "gate-schema-violation",
      message: `${gate}.rationale must be a non-empty human-authored string.`,
    });
  }
  if (rejectionReasons.length > 0 || statedVerdict === undefined || rationale === undefined) {
    return {
      status: "rejected",
      ...(statedVerdict === undefined ? {} : { statedVerdict }),
      effectiveVerdict: false,
      rejectionReasons,
    };
  }
  return {
    status: "accepted",
    statedVerdict,
    effectiveVerdict: statedVerdict,
    rationale,
  };
}

export function validateDeepEquityOperatorGateRecord(
  value: unknown,
  context: DeepEquityOperatorGateValidationContext,
): DeepEquityOperatorGateAudit {
  const validated = validateEnvelope(value);
  if (validated.envelope === undefined) {
    return rejectedAudit(context, validated.rejectionReasons);
  }
  const { envelope } = validated;
  const bindingRejections: DeepEquityOperatorGateRejection[] = [];
  const statedEvaluationRoot = deepEquityEvaluationRootIdentifier(
    envelope.evaluationRoot,
    context.repositoryRoot,
  );
  if (statedEvaluationRoot !== context.checkedEvaluationRoot) {
    bindingRejections.push({
      code: "evaluation-root-mismatch",
      message: `The stated evaluation root does not match ${context.checkedEvaluationRoot}.`,
    });
  }
  if (context.checkedRepositoryCommit === null) {
    bindingRejections.push({
      code: "repository-head-unavailable",
      message: "Repository HEAD could not be resolved at evaluation time.",
    });
  } else if (envelope.repositoryCommit !== context.checkedRepositoryCommit) {
    bindingRejections.push({
      code: "repository-commit-mismatch",
      message: `The stated repository commit does not match evaluation-time HEAD ${context.checkedRepositoryCommit}.`,
    });
  }
  if (bindingRejections.length > 0 || repositoryTreeRejections(context).length > 0) {
    return rejectedAudit(context, bindingRejections, envelope);
  }
  const gates = {
    zeroCriticalMaterialEvidenceOmissionsAfterAdjudication: validateGate(
      envelope.statedVerdicts,
      "zeroCriticalMaterialEvidenceOmissionsAfterAdjudication",
    ),
    humanReviewApproved: validateGate(envelope.statedVerdicts, "humanReviewApproved"),
    liveSmokePassed: validateGate(envelope.statedVerdicts, "liveSmokePassed"),
  };
  const hasRejectedGate = Object.values(gates).some((gate) => gate.status === "rejected");
  return {
    status: hasRejectedGate ? "gate-rejected" : "accepted",
    ...baseAudit(context),
    rejectionReasons: [],
    statedBy: envelope.statedBy,
    statedOn: envelope.statedOn,
    statedEvaluationRoot: envelope.evaluationRoot,
    statedRepositoryCommit: envelope.repositoryCommit,
    gates,
    effectiveInputs: {
      zeroCriticalMaterialEvidenceOmissionsAfterAdjudication:
        gates.zeroCriticalMaterialEvidenceOmissionsAfterAdjudication.effectiveVerdict,
      humanReviewApproved: gates.humanReviewApproved.effectiveVerdict,
      liveSmokePassed: gates.liveSmokePassed.effectiveVerdict,
    },
  };
}

function isWithin(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

function slashPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function gitNulPaths(args: readonly string[], repositoryRoot: string): readonly string[] | null {
  try {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: repositoryRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      return null;
    }
    return new TextDecoder()
      .decode(result.stdout)
      .split("\0")
      .filter((path) => path !== "")
      .map((path) => slashPath(path));
  } catch {
    return null;
  }
}

function readRepositoryTreeAudit(
  repositoryRoot: string,
  approvalRecordPath: string | null,
  codeVersionDirty: boolean,
): DeepEquityRepositoryTreeAudit {
  const trackedPaths = gitNulPaths(
    ["diff", "--name-only", "--no-renames", "-z", "HEAD", "--"],
    repositoryRoot,
  );
  const untrackedPaths = gitNulPaths(
    ["ls-files", "--others", "--exclude-standard", "-z"],
    repositoryRoot,
  );
  const indexEntries = gitNulPaths(["ls-files", "-v", "-z"], repositoryRoot);
  if (trackedPaths === null || untrackedPaths === null || indexEntries === null) {
    return {
      status: "unavailable",
      dirty: codeVersionDirty,
      dirtyPathCount: 0,
      dirtyPathSample: [],
      offendingPathCount: 0,
      offendingPathSample: [],
      indexFlaggedPathCount: 0,
      indexFlaggedPathSample: [],
    };
  }
  const indexFlaggedPaths = indexEntries
    .filter((entry) => !entry.startsWith("H "))
    .map((entry) => entry.slice(2))
    .toSorted();
  const dirtyPaths = [...new Set([...trackedPaths, ...untrackedPaths])].toSorted();
  if (codeVersionDirty !== dirtyPaths.length > 0) {
    return {
      status: "unavailable",
      dirty: codeVersionDirty,
      dirtyPathCount: dirtyPaths.length,
      dirtyPathSample: dirtyPaths.slice(0, DIRTY_PATH_SAMPLE_LIMIT),
      offendingPathCount: dirtyPaths.length,
      offendingPathSample: dirtyPaths.slice(0, DIRTY_PATH_SAMPLE_LIMIT),
      indexFlaggedPathCount: indexFlaggedPaths.length,
      indexFlaggedPathSample: indexFlaggedPaths.slice(0, DIRTY_PATH_SAMPLE_LIMIT),
    };
  }
  const offendingPaths =
    approvalRecordPath === null
      ? dirtyPaths
      : dirtyPaths.filter((path) => path !== approvalRecordPath);
  let status: DeepEquityRepositoryTreeAudit["status"] = "dirty";
  if (dirtyPaths.length === 0) {
    status = "clean";
  } else if (offendingPaths.length === 0) {
    status = "approval-record-only";
  }
  if (indexFlaggedPaths.length > 0 && offendingPaths.length === 0) {
    status = "index-flags-set";
  }
  return {
    status,
    dirty: dirtyPaths.length > 0,
    dirtyPathCount: dirtyPaths.length,
    dirtyPathSample: dirtyPaths.slice(0, DIRTY_PATH_SAMPLE_LIMIT),
    offendingPathCount: offendingPaths.length,
    offendingPathSample: offendingPaths.slice(0, DIRTY_PATH_SAMPLE_LIMIT),
    indexFlaggedPathCount: indexFlaggedPaths.length,
    indexFlaggedPathSample: indexFlaggedPaths.slice(0, DIRTY_PATH_SAMPLE_LIMIT),
  };
}

export function deepEquityEvaluationRootIdentifier(
  evaluationRoot: string,
  repositoryRoot: string = process.cwd(),
): string {
  const absoluteRepositoryRoot = resolve(repositoryRoot);
  const absoluteEvaluationRoot = resolve(absoluteRepositoryRoot, evaluationRoot);
  if (isWithin(absoluteRepositoryRoot, absoluteEvaluationRoot)) {
    return slashPath(relative(absoluteRepositoryRoot, absoluteEvaluationRoot));
  }
  return slashPath(absoluteEvaluationRoot);
}

export async function readDeepEquityOperatorGateRecord(input: {
  readonly approvalRecordPath?: string;
  readonly evaluationRoot: string;
  readonly repositoryRoot?: string;
}): Promise<DeepEquityOperatorGateAudit> {
  const repositoryRoot = resolve(input.repositoryRoot ?? process.cwd());
  const checkedEvaluationRoot = deepEquityEvaluationRootIdentifier(
    input.evaluationRoot,
    repositoryRoot,
  );
  const codeVersion = readCodeVersion(repositoryRoot);
  const checkedRepositoryCommit = codeVersion.commit ?? null;
  const absoluteSourcePath =
    input.approvalRecordPath === undefined
      ? null
      : resolve(repositoryRoot, input.approvalRecordPath);
  const relativeSourcePath =
    absoluteSourcePath === null ? null : slashPath(relative(repositoryRoot, absoluteSourcePath));
  const checkedRepositoryTree = readRepositoryTreeAudit(
    repositoryRoot,
    relativeSourcePath,
    codeVersion.dirty,
  );
  if (input.approvalRecordPath === undefined) {
    const context = {
      sourcePath: null,
      checkedEvaluationRoot,
      checkedRepositoryCommit,
      checkedRepositoryTree,
      repositoryRoot,
    };
    return {
      status: "not-supplied",
      ...baseAudit(context),
      rejectionReasons: [],
      gates: uniformGateAudits("not-supplied"),
      effectiveInputs: falseEffectiveInputs(),
    };
  }

  if (absoluteSourcePath === null || relativeSourcePath === null) {
    throw new Error("approval record path resolution invariant failed");
  }
  const context: DeepEquityOperatorGateValidationContext = {
    sourcePath: relativeSourcePath,
    checkedEvaluationRoot,
    checkedRepositoryCommit,
    checkedRepositoryTree,
    repositoryRoot,
  };
  if (!isWithin(repositoryRoot, absoluteSourcePath)) {
    return rejectedAudit(context, [
      {
        code: "approval-path-outside-repository",
        message: "The approval record path must be inside the repository.",
      },
    ]);
  }
  if (relativeSourcePath === "data" || relativeSourcePath.startsWith("data/")) {
    return rejectedAudit(context, [
      {
        code: "approval-path-under-data",
        message: "The approval record path must not be under data/.",
      },
    ]);
  }
  if (!relativeSourcePath.startsWith("operator-approvals/deep-equity/")) {
    return rejectedAudit(context, [
      {
        code: "approval-path-outside-designated-directory",
        message: "The approval record must be under operator-approvals/deep-equity/.",
      },
    ]);
  }

  let serialized = "";
  try {
    const [realRepositoryRoot, realSourcePath] = await Promise.all([
      realpath(repositoryRoot),
      realpath(absoluteSourcePath),
    ]);
    if (!isWithin(realRepositoryRoot, realSourcePath)) {
      return rejectedAudit(context, [
        {
          code: "approval-path-outside-repository",
          message: "The approval record resolves outside the repository.",
        },
      ]);
    }
    const realRelativeSourcePath = slashPath(relative(realRepositoryRoot, realSourcePath));
    if (
      realRelativeSourcePath === "data" ||
      realRelativeSourcePath.startsWith("data/") ||
      !realRelativeSourcePath.startsWith("operator-approvals/deep-equity/")
    ) {
      return rejectedAudit(context, [
        {
          code: "approval-path-outside-designated-directory",
          message:
            "The approval record must resolve under operator-approvals/deep-equity/ and outside data/.",
        },
      ]);
    }
    serialized = await readFile(realSourcePath, "utf8");
  } catch (error) {
    return rejectedAudit(context, [
      {
        code: "read-failure",
        message: `The approval record could not be read: ${error instanceof Error ? error.message : String(error)}`,
      },
    ]);
  }

  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    return rejectedAudit(context, [
      {
        code: "invalid-json",
        message: `The approval record is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      },
    ]);
  }
  return validateDeepEquityOperatorGateRecord(parsed, context);
}
