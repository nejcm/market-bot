import { afterAll, expect, test } from "bun:test";
import type { link } from "node:fs/promises";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePooledBody } from "../src/replay/body-pool";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});
async function setup(): Promise<{ readonly pool: string; readonly staged: string }> {
  const root = await mkdtemp(join(tmpdir(), "market-bot-body-pool-"));
  roots.push(root);
  const staged = join(root, "run", "replay", "bodies");
  await mkdir(staged, { recursive: true });
  return { pool: join(root, "replay-bodies"), staged };
}

test("a pool miss writes the run copy and seeds the pool with the same inode", async () => {
  const { pool, staged } = await setup();
  await writePooledBody(pool, join(staged, "abc.txt"), "body");
  expect(await readFile(join(staged, "abc.txt"), "utf8")).toBe("body");
  expect((await stat(join(pool, "abc.txt"))).ino).toBe((await stat(join(staged, "abc.txt"))).ino);
});

test("a pool hit links the pooled file instead of writing", async () => {
  const { pool, staged } = await setup();
  await mkdir(pool);
  await writeFile(join(pool, "abc.txt"), "pooled");
  await writePooledBody(pool, join(staged, "abc.txt"), "pooled");
  expect((await stat(join(staged, "abc.txt"))).ino).toBe((await stat(join(pool, "abc.txt"))).ino);
});

test("a concurrent run seeding the pool first leaves both copies intact", async () => {
  const { pool, staged } = await setup();
  const other = join(staged, "..", "other");
  await mkdir(other);
  await Promise.all([
    writePooledBody(pool, join(staged, "abc.txt"), "body"),
    writePooledBody(pool, join(other, "abc.txt"), "body"),
  ]);
  expect(await readFile(join(staged, "abc.txt"), "utf8")).toBe("body");
  expect(await readFile(join(other, "abc.txt"), "utf8")).toBe("body");
  expect(await readdir(pool)).toEqual(["abc.txt"]);
});

const refuseLink: typeof link = async () => {
  throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
};

test("a filesystem that refuses hardlinks falls back to a plain write", async () => {
  const { pool, staged } = await setup();
  await mkdir(pool);
  await writeFile(join(pool, "abc.txt"), "body");
  await writePooledBody(pool, join(staged, "abc.txt"), "body", refuseLink);
  expect(await readFile(join(staged, "abc.txt"), "utf8")).toBe("body");
  expect((await stat(join(staged, "abc.txt"))).ino).not.toBe(
    (await stat(join(pool, "abc.txt"))).ino,
  );
});
