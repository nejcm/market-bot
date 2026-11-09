import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fsp from "node:fs/promises";
import { link, mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishRunArtifacts, writeFileAtomic } from "../src/artifacts";

const dirs: string[] = [];
const restores: (() => void)[] = [];
const realOpen = fsp.open;
const realRename = fsp.rename;

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "market-bot-atomic-")));
  dirs.push(dir);
  return dir;
}

function setPlatform(platform: NodeJS.Platform): void {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  restores.push(() => {
    if (original !== undefined) {
      Object.defineProperty(process, "platform", original);
    }
  });
}

type FsOp = "open" | "sync" | "rename";

// Records open/sync/close/rename against the real fs; `inject` returns an errno code to throw.
function traceFs(
  root: string,
  inject: (op: FsOp, path: string) => string | undefined = () => undefined,
) {
  const events: string[] = [];
  let openHandles = 0;
  let maxOpenHandles = 0;
  const name = (path: string): string =>
    path.replace(root, "").replace(/\.[0-9a-f-]{36}\.tmp$/u, ".tmp") || "/";
  const fail = (op: FsOp, path: string): void => {
    const code = inject(op, name(path));
    if (code !== undefined) {
      throw Object.assign(new Error(`${code}: ${op} ${path}`), { code });
    }
  };
  const openSpy = spyOn(fsp, "open").mockImplementation((async (
    path: Parameters<typeof realOpen>[0],
    flags?: Parameters<typeof realOpen>[1],
  ) => {
    const target = String(path);
    events.push(`open ${name(target)}`);
    fail("open", target);
    const handle = await realOpen(path, flags);
    openHandles += 1;
    maxOpenHandles = Math.max(maxOpenHandles, openHandles);
    const sync = handle.sync.bind(handle);
    const close = handle.close.bind(handle);
    handle.sync = async () => {
      events.push(`sync ${name(target)}`);
      fail("sync", target);
      await sync();
    };
    handle.close = async () => {
      events.push(`close ${name(target)}`);
      openHandles -= 1;
      await close();
    };
    return handle;
  }) as typeof realOpen);
  const renameSpy = spyOn(fsp, "rename").mockImplementation(async (from, to) => {
    events.push(`rename ${name(String(from))} ${name(String(to))}`);
    fail("rename", String(to));
    await realRename(from, to);
  });
  restores.push(() => {
    openSpy.mockRestore();
    renameSpy.mockRestore();
  });
  return { events, openHandles: () => openHandles, maxOpenHandles: () => maxOpenHandles };
}

afterEach(async () => {
  for (const restore of restores.splice(0).toReversed()) {
    restore();
  }
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("writeFileAtomic", () => {
  test("renames a new file over the target and leaves no temp file", async () => {
    const dir = await tempDir();
    const target = join(dir, "summary.json");
    await writeFileAtomic(target, "old");
    await link(target, join(dir, "summary.link"));

    await writeFileAtomic(target, "new");

    expect(await readFile(target, "utf8")).toBe("new");
    expect(await readFile(join(dir, "summary.link"), "utf8")).toBe("old");
    const entries = await readdir(dir);
    expect(entries.toSorted()).toEqual(["summary.json", "summary.link"]);
  });

  test("syncs and closes the temp file before the rename, then syncs the directory", async () => {
    const dir = await tempDir();
    const fs = traceFs(dir);

    await writeFileAtomic(join(dir, "a.json"), "x");

    expect(fs.events).toEqual([
      "open /a.json.tmp",
      "sync /a.json.tmp",
      "close /a.json.tmp",
      "rename /a.json.tmp /a.json",
      "open /",
      "sync /",
      "close /",
    ]);
    expect(fs.openHandles()).toBe(0);
  });

  test("closes the handle, removes the temp file and rethrows when the file sync fails", async () => {
    const dir = await tempDir();
    const fs = traceFs(dir, (op, path) =>
      op === "sync" && path.endsWith(".tmp") ? "EIO" : undefined,
    );

    await expect(writeFileAtomic(join(dir, "a.json"), "x")).rejects.toMatchObject({ code: "EIO" });

    expect(fs.events).toEqual(["open /a.json.tmp", "sync /a.json.tmp", "close /a.json.tmp"]);
    expect(await readdir(dir)).toEqual([]);
  });

  test("rejects a write into a missing directory without leaving a temp file", async () => {
    const dir = await tempDir();
    await expect(writeFileAtomic(join(dir, "missing", "a.json"), "x")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readdir(dir)).toEqual([]);
  });

  test("tolerates a directory fsync the filesystem does not support", async () => {
    const dir = await tempDir();
    setPlatform("linux");
    const fs = traceFs(dir, (op, path) => (op === "sync" && path === "/" ? "EINVAL" : undefined));

    await writeFileAtomic(join(dir, "a.json"), "x");

    expect(await readFile(join(dir, "a.json"), "utf8")).toBe("x");
    expect(fs.events.at(-1)).toBe("close /");
  });

  test("propagates directory permission failures outside Windows", async () => {
    const dir = await tempDir();
    setPlatform("linux");
    traceFs(dir, (op, path) => (op === "sync" && path === "/" ? "EPERM" : undefined));
    await expect(writeFileAtomic(join(dir, "a.json"), "x")).rejects.toMatchObject({
      code: "EPERM",
    });

    restores
      .splice(0)
      .toReversed()
      .forEach((restore) => restore());
    setPlatform("linux");
    traceFs(dir, (op, path) => (op === "open" && path === "/" ? "EACCES" : undefined));
    await expect(writeFileAtomic(join(dir, "b.json"), "x")).rejects.toMatchObject({
      code: "EACCES",
    });
  });

  test("tolerates Windows refusing directory handles", async () => {
    const dir = await tempDir();
    setPlatform("win32");
    traceFs(dir, (op, path) => (op === "sync" && path === "/" ? "EPERM" : undefined));

    await writeFileAtomic(join(dir, "a.json"), "x");

    expect(await readFile(join(dir, "a.json"), "utf8")).toBe("x");
  });
});

describe("publishRunArtifacts", () => {
  test("publishes the staged tree whole and removes the stage", async () => {
    const root = await tempDir();
    const runsDir = join(root, "runs");

    const published = await publishRunArtifacts(runsDir, "run-1", async (staged) => {
      await writeFileAtomic(join(staged.runDir, "report.json"), "{}\n");
      await writeFileAtomic(join(staged.normalizedDir, "evidence.json"), "[]\n");
    });

    expect(published.runDir).toBe(join(runsDir, "run-1"));
    expect(await readFile(join(published.normalizedDir, "evidence.json"), "utf8")).toBe("[]\n");
    const rawDir = await stat(published.rawDir);
    expect(rawDir.isDirectory()).toBe(true);
    expect(await readdir(root)).toEqual(["runs"]);
  });

  test("syncs the staged tree one handle at a time before the rename, then both parents", async () => {
    const root = await tempDir();
    const runsDir = join(root, "runs");
    const fs = traceFs(root);

    await publishRunArtifacts(runsDir, "run-1", async (staged) => {
      await Promise.all(
        ["a.json", "b.json", "c.json"].map((file) =>
          realOpen(join(staged.rawDir, file), "w").then(async (handle) => handle.close()),
        ),
      );
    });

    const stage = "/.runs-run-1.partial";
    const publish = fs.events.indexOf(`rename ${stage} /runs/run-1`);
    const before = fs.events.slice(0, publish);
    for (const path of ["/raw/a.json", "/raw/b.json", "/raw/c.json", "/raw", "/normalized", ""]) {
      expect(before).toContain(`sync ${stage}${path}`);
    }
    expect(fs.events.slice(publish + 1).filter((event) => event.startsWith("sync"))).toEqual(
      expect.arrayContaining(["sync /runs", "sync /"]),
    );
    expect(fs.maxOpenHandles()).toBe(1);
    expect(fs.openHandles()).toBe(0);
  });

  test("does not publish when a staged file fails to sync", async () => {
    const root = await tempDir();
    const runsDir = join(root, "runs");
    traceFs(root, (op, path) =>
      op === "sync" && path.endsWith("/report.json") ? "EIO" : undefined,
    );

    await expect(
      publishRunArtifacts(runsDir, "run-1", async (staged) => {
        const handle = await realOpen(join(staged.runDir, "report.json"), "w");
        await handle.close();
      }),
    ).rejects.toMatchObject({ code: "EIO" });

    expect(await readdir(runsDir)).toEqual([]);
  });
});
