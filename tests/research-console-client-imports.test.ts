import { expect, test } from "bun:test";
import { isBuiltin } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { compile } from "svelte/compiler";

test("Console runtime imports stay outside replay and Node modules", async () => {
  const root = resolve(import.meta.dir, "..");
  const client = resolve(root, "app/client");
  const pending = [...new Bun.Glob("**/*.{ts,svelte}").scanSync({ cwd: client, absolute: true })];
  const visited = new Set<string>();
  const violations: string[] = [];
  const transpiler = new Bun.Transpiler({ loader: "ts" });

  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);
    const source = await Bun.file(file).text();
    const code = file.endsWith(".svelte")
      ? compile(source, { filename: file, generate: "client" }).js.code
      : source;
    for (const { path } of transpiler.scanImports(code)) {
      if (path.startsWith("node:") || isBuiltin(path)) {
        violations.push(`${relative(root, file)} -> ${path}`);
        continue;
      }
      if (!path.startsWith(".") && !path.startsWith("$lib/")) {
        continue;
      }
      const dependency = Bun.resolveSync(
        path.startsWith("$lib/") ? resolve(client, "lib", path.slice(5)) : path,
        dirname(file),
      );
      const name = relative(root, dependency);
      if (name.startsWith("src/replay/")) {
        violations.push(`${relative(root, file)} -> ${name}`);
      } else if (/\.(ts|js|svelte)$/u.test(dependency)) {
        pending.push(dependency);
      }
    }
  }

  expect(violations).toEqual([]);
});
