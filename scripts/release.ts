import { readFileSync, writeFileSync } from "node:fs";

type Bump = "major" | "minor" | "patch";

interface ReleaseCommit {
  readonly hash: string;
  readonly subject: string;
  readonly body: string;
}

interface ParsedCommit {
  readonly type: string;
  readonly scope?: string;
  readonly description: string;
  readonly hash: string;
  readonly breaking: boolean;
}

const HEADER = /^(\w+)(?:\(([^)]+)\))?(!)?: (.+)$/u;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/mu;
const SECTION_TITLES: Readonly<Record<string, string>> = {
  feat: "Features",
  fix: "Bug Fixes",
  perf: "Performance",
};

function parseCommit(commit: ReleaseCommit): ParsedCommit | undefined {
  const match = HEADER.exec(commit.subject);
  if (match === null) {
    return undefined;
  }
  const [, type = "", scope, bang, description = ""] = match;
  const breaking = bang === "!" || BREAKING_FOOTER.test(commit.body);
  if (!breaking && SECTION_TITLES[type] === undefined) {
    return undefined;
  }
  return {
    type,
    ...(scope !== undefined ? { scope } : {}),
    description,
    hash: commit.hash,
    breaking,
  };
}

export function releasableCommits(commits: readonly ReleaseCommit[]): readonly ParsedCommit[] {
  return commits.flatMap((commit) => parseCommit(commit) ?? []);
}

export function bumpFor(commits: readonly ParsedCommit[]): Bump | undefined {
  if (commits.some((commit) => commit.breaking)) {
    return "major";
  }
  if (commits.some((commit) => commit.type === "feat")) {
    return "minor";
  }
  return commits.length > 0 ? "patch" : undefined;
}

export function nextVersion(version: string, bump: Bump): string {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  if (bump === "major") {
    return `${major + 1}.0.0`;
  }
  return bump === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

export function renderSection(input: {
  readonly version: string;
  readonly date: string;
  readonly compareUrl: string;
  readonly commitUrl: string;
  readonly commits: readonly ParsedCommit[];
}): string {
  const entry = (commit: ParsedCommit): string => {
    const scope = commit.scope !== undefined ? `**${commit.scope}:** ` : "";
    const short = commit.hash.slice(0, 7);
    return `- ${scope}${commit.description} ([${short}](${input.commitUrl}/${commit.hash}))`;
  };
  const groups: [string, readonly ParsedCommit[]][] = [
    ["Breaking Changes", input.commits.filter((commit) => commit.breaking)],
    ...Object.entries(SECTION_TITLES).map(([type, title]): [string, readonly ParsedCommit[]] => [
      title,
      input.commits.filter((commit) => commit.type === type && !commit.breaking),
    ]),
  ];
  const body = groups
    .filter(([, commits]) => commits.length > 0)
    .map(
      ([title, commits]) => `### ${title}\n\n${commits.map((commit) => entry(commit)).join("\n")}`,
    );
  return [`## [${input.version}](${input.compareUrl}) (${input.date})`, ...body].join("\n\n");
}

function git(args: readonly string[]): string {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

function readCommitsSince(tag: string): readonly ReleaseCommit[] {
  const log = git(["log", `${tag}..HEAD`, "--format=%H%x1f%s%x1f%b%x1e"]);
  return log
    .split("\u001E")
    .map((record) => record.trim())
    .filter((record) => record !== "")
    .map((record) => {
      const [hash = "", subject = "", body = ""] = record.split("\u001F");
      return { hash, subject, body };
    });
}

function latestTag(): string {
  try {
    return git(["describe", "--tags", "--abbrev=0", "--match", "v*"]);
  } catch {
    throw new Error("No v* tag found. Create the baseline first: git tag -a v<version> <commit>");
  }
}

function release(dryRun: boolean): void {
  const tag = latestTag();
  const commits = releasableCommits(readCommitsSince(tag));
  const bump = bumpFor(commits);
  if (bump === undefined) {
    process.stdout.write(`No releasable commits since ${tag}.\n`);
    return;
  }

  const packageJson = readFileSync("package.json", "utf8");
  const pkg = JSON.parse(packageJson) as { version: string; repository: { url: string } };
  const version = nextVersion(pkg.version, bump);
  const repoUrl = pkg.repository.url.replace(/^git\+/u, "").replace(/\.git$/u, "");
  const section = renderSection({
    version,
    date: new Date().toISOString().slice(0, 10),
    compareUrl: `${repoUrl}/compare/${tag}...v${version}`,
    commitUrl: `${repoUrl}/commit`,
    commits,
  });
  process.stdout.write(`${tag} -> v${version} (${bump})\n\n${section}\n`);
  if (dryRun) {
    return;
  }

  writeFileSync("package.json", packageJson.replace(/("version":\s*")[^"]+"/u, `$1${version}"`));
  let changelog = "# Changelog\n";
  try {
    changelog = readFileSync("CHANGELOG.md", "utf8");
  } catch {
    // First release: start a new file
  }
  const header = "# Changelog\n";
  const rest = changelog.startsWith(header) ? changelog.slice(header.length) : changelog;
  writeFileSync(
    "CHANGELOG.md",
    `${header}\n${section}\n${rest === "" ? "" : `\n${rest.trimStart()}`}`,
  );

  git(["add", "package.json", "CHANGELOG.md"]);
  git(["commit", "-m", `chore(release): v${version}`]);
  git(["tag", "-a", `v${version}`, "-m", `v${version}`]);
}

if (import.meta.main) {
  release(process.argv.includes("--dry-run"));
}
