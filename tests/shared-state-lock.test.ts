import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock, withSharedStateLock } from "../src/shared-state-lock";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function lockPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "market-bot-lock-"));
  tempDirs.push(dir);
  return join(dir, "test.lock");
}

describe("withFileLock", () => {
  test("returns the result and releases for the next holder", async () => {
    const path = await lockPath();
    expect(await withFileLock(path, () => Promise.resolve(1))).toBe(1);
    expect(await withFileLock(path, () => Promise.resolve(2))).toBe(2);
  });

  test("releases when the locked work throws", async () => {
    const path = await lockPath();
    await expect(withFileLock(path, () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    expect(await withFileLock(path, () => Promise.resolve("next"))).toBe("next");
  });

  test("a contending holder waits until the first releases", async () => {
    const path = await lockPath();
    const events: string[] = [];
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    const first = withFileLock(path, async () => {
      events.push("first:start");
      await released;
      events.push("first:end");
    });
    await Bun.sleep(20);
    const second = withFileLock(path, async () => {
      events.push("second:start");
    });
    await Bun.sleep(150);
    expect(events).toEqual(["first:start"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  test("a lock held by a killed process is recovered", async () => {
    const path = await lockPath();
    const holder = Bun.spawn(
      [
        "bun",
        "-e",
        `const { Database } = require("bun:sqlite"); new Database(${JSON.stringify(path)}).exec("BEGIN EXCLUSIVE"); console.log("held"); setInterval(() => {}, 1000);`,
      ],
      { stdout: "pipe" },
    );
    await holder.stdout.getReader().read();
    let acquired = false;
    const waiting = withFileLock(path, () => {
      acquired = true;
      return Promise.resolve();
    });
    await Bun.sleep(150);
    expect(acquired).toBe(false);
    holder.kill(9);
    await holder.exited;
    await waiting;
    expect(acquired).toBe(true);
  });
});

describe("withSharedStateLock", () => {
  test("locks a file in the data root, not the runs dir", async () => {
    const root = await mkdtemp(join(tmpdir(), "market-bot-lock-root-"));
    tempDirs.push(root);
    await withSharedStateLock(join(root, "runs"), () => Promise.resolve());
    expect(await readdir(root)).toEqual(["shared-state.lock"]);
  });
});
