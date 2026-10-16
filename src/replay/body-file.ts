import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

export async function readRecordedBody(
  dir: string,
  file: string,
  sha256?: string,
): Promise<string> {
  if (isAbsolute(file) || file.split(/[\\/]/u).includes("..")) {
    throw new Error("Unsafe cassette body path");
  }
  const root = await realpath(dir);
  const path = await realpath(join(root, file));
  if (relative(root, path).startsWith("..")) {
    throw new Error("Unsafe cassette body path");
  }
  const body = await readFile(path, "utf8");
  if (
    sha256 !== undefined &&
    new Bun.CryptoHasher("sha256").update(body).digest("hex") !== sha256
  ) {
    throw new Error(`Fixture data cassette body hash mismatch: ${file}`);
  }
  return body;
}
