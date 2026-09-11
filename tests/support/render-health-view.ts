import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Component } from "svelte";
import { compile } from "svelte/compiler";
import { render } from "svelte/server";
import type { ProviderHealthDetail } from "../../app/types";

interface HealthViewProps {
  readonly providerHealth: ProviderHealthDetail;
}

const libRoot = resolve(import.meta.dir, "../../app/client/lib");
Bun.plugin({
  name: "svelte-health-view-test-loader",
  setup(build) {
    build.onResolve({ filter: /^\$lib\//u }, ({ path }) => {
      const candidate = resolve(libRoot, path.slice("$lib/".length));
      if (existsSync(candidate)) {
        return { path: candidate };
      }
      const typescriptCandidate = candidate.endsWith(".js")
        ? `${candidate.slice(0, -3)}.ts`
        : `${candidate}/index.ts`;
      return { path: typescriptCandidate };
    });
    build.onLoad({ filter: /\.svelte$/u }, async ({ path }) => {
      const source = await Bun.file(path).text();
      return {
        contents: compile(source, {
          filename: path,
          generate: "server",
        }).js.code,
        loader: "js",
      };
    });
  },
});

const providerHealth = JSON.parse(await Bun.stdin.text()) as ProviderHealthDetail;
const componentModule =
  (await import("../../app/client/components/health-view.svelte")) as unknown as {
    readonly default: Component<HealthViewProps>;
  };
const result = render(componentModule.default, {
  props: { providerHealth },
});
process.stdout.write(result.body);
