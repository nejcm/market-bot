import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";

export const EVALS_ROOT = resolve(import.meta.dir, "../../data/evals");

export async function freshEvalDir(label: string, root: string = EVALS_ROOT): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(label)) {
    throw new Error("Unsafe eval label");
  }
  let existing = resolve(root);
  while (!existsSync(existing)) {
    existing = dirname(existing);
  }
  if ((await realpath(existing)) !== existing) {
    throw new Error("Eval root must not use symlinks");
  }
  await mkdir(root, { recursive: true });
  if ((await realpath(root)) !== resolve(root)) {
    throw new Error("Eval root must not use symlinks");
  }
  const dir = join(root, label);
  await mkdir(dir);
  return dir;
}

export async function writeEvalJson(dir: string, name: string, value: unknown): Promise<void> {
  await writeFile(join(dir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
