import { link, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

// Pool files are hardlinked into run dirs, so they stay immutable: only new files ("wx"), never in place.
export async function writePooledBody(
  poolDir: string,
  target: string,
  body: string,
  linkFile: typeof link = link,
): Promise<void> {
  const pooled = join(poolDir, basename(target));
  try {
    await linkFile(pooled, target);
    return;
  } catch {
    // Pool miss or a filesystem without hardlinks: fall back to a plain write.
  }
  await writeFile(target, body, { encoding: "utf8", flag: "wx" });
  try {
    await mkdir(poolDir, { recursive: true });
    await linkFile(target, pooled);
  } catch {
    // EEXIST from a concurrent run, EXDEV or EPERM: the run's own copy is already complete.
  }
}
