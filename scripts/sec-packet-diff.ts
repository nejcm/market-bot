import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isRecord } from "../src/guards";

type Slots = Record<string, string>;

interface FilingSlots {
  readonly cachedDate: string;
  readonly form: string;
  readonly slots: Slots;
}

const PACKET_LABELS = ["Business", "Risk Factors", "MD&A", "Segments", "Notes"];

export function packetSlots(packet: string | undefined): Slots {
  const slots: Slots = {};
  if (packet === undefined) {
    return slots;
  }
  const marker = new RegExp(`(?:^|\\n\\n)\\[(${PACKET_LABELS.join("|")})\\] `, "gu");
  const starts = [...packet.matchAll(marker)];
  for (const [index, match] of starts.entries()) {
    const end = starts[index + 1]?.index ?? packet.length;
    slots[match[1]!] = packet.slice(match.index + match[0].length, end);
  }
  return slots;
}

// Stands in for the submissions reportDate, which the cached filing text does not carry.
export function latestContextEnd(html: string): string | undefined {
  return [...html.matchAll(/<(?:xbrli:)?endDate>\s*(\d{4}-\d{2}-\d{2})/gu)]
    .map((match) => match[1]!)
    .toSorted()
    .at(-1);
}

async function readFilingText(
  path: string,
): Promise<{ cacheKey: string; cachedDate: string; payload: string } | undefined> {
  const entry: unknown = await Bun.file(path)
    .json()
    .catch(() => undefined);
  return isRecord(entry) &&
    entry.adapter === "sec-filing-text" &&
    typeof entry.cacheKey === "string" &&
    typeof entry.cachedDate === "string" &&
    typeof entry.payload === "string"
    ? { cacheKey: entry.cacheKey, cachedDate: entry.cachedDate, payload: entry.payload }
    : undefined;
}

// Runs against whichever src/ sits beside this file, so the same code serves a base worktree.
async function extract(cacheDir: string): Promise<Record<string, FilingSlots>> {
  const text = await import("../src/sources/sec-filing-text");
  const sweep = await import("./sec-cache-sweep");
  const facts: Record<string, unknown> = await import("../src/sources/sec-segment-facts");
  const segments: Record<string, unknown> =
    await import("../src/sources/extended-evidence/segment-results").catch(() => ({}));
  const geography: Record<string, unknown> =
    await import("../src/sources/extended-evidence/geographic-revenue").catch(() => ({}));
  const factFns = ["secSegmentFactMetrics", "secGeographyFactMetrics"]
    .map((name) => facts[name])
    .filter((fn) => typeof fn === "function") as ((
    html: string,
    end: string | undefined,
  ) => Record<string, number | string>)[];
  const sectionFns = [
    ["segment-results", segments.segmentResultsSection],
    ["geographic-revenue", geography.geographicRevenueSection],
  ].filter(([, fn]) => typeof fn === "function") as [
    string,
    (s: string, i: unknown[]) => unknown,
  ][];
  const newest = new Map<string, { readonly path: string; readonly cachedDate: string }>();
  for await (const relative of new Bun.Glob("*/*.json").scan(cacheDir)) {
    const path = join(cacheDir, relative);
    // oxlint-disable-next-line no-await-in-loop -- Sequential reads bound filing-text memory.
    const entry = await readFilingText(path);
    const previous = entry === undefined ? undefined : newest.get(entry.cacheKey);
    if (entry !== undefined && (previous === undefined || entry.cachedDate > previous.cachedDate)) {
      newest.set(entry.cacheKey, { path, cachedDate: entry.cachedDate });
    }
  }
  const filings: Record<string, FilingSlots> = {};
  for (const [cacheKey, { path, cachedDate }] of newest) {
    // oxlint-disable-next-line no-await-in-loop -- Sequential reads bound filing-text memory.
    const { payload } = (await readFilingText(path))!;
    const normalized = text.normalizeFilingText(payload);
    const form = sweep.inferFilingForm(normalized);
    if (form !== "10-K" && form !== "10-Q" && form !== "20-F") {
      continue;
    }
    const slots = packetSlots(text.secFilingSectionPacket(normalized, form).packet);
    const reportDate = latestContextEnd(payload);
    const item = {
      category: "sec-edgar",
      title: "packet-diff",
      summary: "",
      sourceIds: [],
      observedAt: cachedDate,
      metrics: Object.assign(
        { form, ...(reportDate === undefined ? {} : { reportDate, filingDate: reportDate }) },
        ...factFns.map((fn) => fn(payload, reportDate)),
      ),
    };
    for (const [slot, fn] of sectionFns) {
      const result = fn("DIFF", [item]);
      if (result !== undefined) {
        slots[slot] = JSON.stringify(result, null, 1);
      }
    }
    filings[cacheKey.slice(0, 16)] = { cachedDate, form, slots };
  }
  return filings;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${err.trim()}`);
  }
  return out.trim();
}

async function extractAt(
  rev: string,
  repo: string,
  cacheDir: string,
  work: string,
): Promise<Record<string, FilingSlots>> {
  const tree = join(work, `tree-${rev.replaceAll(/[^\w.-]/gu, "_")}`);
  await git(repo, "worktree", "add", "--detach", "--quiet", tree, rev);
  try {
    await symlink(join(repo, "node_modules"), join(tree, "node_modules"));
    await Bun.write(join(tree, "scripts/sec-packet-diff.ts"), Bun.file(import.meta.path));
    const out = join(work, `${rev.replaceAll(/[^\w.-]/gu, "_")}.json`);
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        join(tree, "scripts/sec-packet-diff.ts"),
        "--emit",
        out,
        "--cache-dir",
        cacheDir,
      ],
      { stdout: "inherit", stderr: "inherit" },
    );
    if ((await proc.exited) !== 0) {
      throw new Error(`Extraction at ${rev} failed`);
    }
    return (await Bun.file(out).json()) as Record<string, FilingSlots>;
  } finally {
    await git(repo, "worktree", "remove", "--force", tree);
  }
}

function head(value: string | undefined, chars: number): string {
  return value === undefined ? "(absent)" : value.slice(0, chars).replaceAll(/\s+/gu, " ");
}

export function diffSlots(
  base: Record<string, FilingSlots>,
  target: Record<string, FilingSlots>,
  chars = 160,
): string {
  const bySlot = new Map<string, string[]>();
  for (const [hash, after] of Object.entries(target)) {
    const before = base[hash]?.slots ?? {};
    for (const slot of new Set([...Object.keys(before), ...Object.keys(after.slots)])) {
      if (before[slot] === after.slots[slot]) {
        continue;
      }
      const lines = bySlot.get(slot) ?? [];
      lines.push(
        `  ${hash} ${after.form} ${after.cachedDate} (${String(before[slot]?.length ?? 0)} -> ${String(after.slots[slot]?.length ?? 0)} chars)\n` +
          `    - ${head(before[slot], chars)}\n    + ${head(after.slots[slot], chars)}`,
      );
      bySlot.set(slot, lines);
    }
  }
  const total = Object.keys(target).length;
  const sections = [...bySlot]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(
      ([slot, lines]) =>
        `${slot}: ${String(lines.length)}/${String(total)} filings changed${Object.values(base).some((filing) => filing.slots[slot] !== undefined) ? "" : " (slot absent at base)"}\n${lines.join("\n")}`,
    );
  return `${sections.length === 0 ? `No slot changes across ${String(total)} filings.` : sections.join("\n\n")}\n`;
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      base: { type: "string" },
      head: { type: "string" },
      "cache-dir": { type: "string", default: "data/cache" },
      "out-dir": { type: "string" },
      chars: { type: "string", default: "160" },
      emit: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const cacheDir = resolve(values["cache-dir"]!);
  if (values.emit !== undefined) {
    await writeFile(values.emit, JSON.stringify(await extract(cacheDir)));
  } else {
    if (values.base === undefined) {
      throw new Error("Usage: sweep:packets -- --base <rev> [--head <rev>] [--out-dir <dir>]");
    }
    const repo = await git(import.meta.dir, "rev-parse", "--show-toplevel");
    const work = await mkdtemp(join(tmpdir(), "market-bot-packet-diff-"));
    try {
      const base = await extractAt(values.base, repo, cacheDir, work);
      const target =
        values.head === undefined
          ? await extract(cacheDir)
          : await extractAt(values.head, repo, cacheDir, work);
      const report = diffSlots(base, target, Number(values.chars));
      const outDir = values["out-dir"] === undefined ? work : resolve(values["out-dir"]);
      if (outDir === cacheDir || outDir.startsWith(`${cacheDir}/`)) {
        throw new Error("Diff output must be outside the cache directory");
      }
      await mkdir(outDir, { recursive: true });
      const path = join(outDir, "packet-diff.txt");
      await writeFile(path, report);
      await writeFile(join(outDir, "packet-diff.json"), JSON.stringify({ base, target }));
      process.stdout.write(
        `${report
          .split("\n")
          .filter((line) => /^\S/u.test(line))
          .join("\n")}\nFull diff: ${path}\n`,
      );
    } finally {
      if (values["out-dir"] !== undefined) {
        await rm(work, { recursive: true, force: true });
      }
    }
  }
}
