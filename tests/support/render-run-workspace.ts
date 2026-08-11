import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Component } from "svelte";
import { compile } from "svelte/compiler";
import { render } from "svelte/server";
import type { RunDetail } from "../../app/types";
import type { ReportDetail } from "../../app/client/app-settings";

type Tab = "report" | "sources" | "data" | "files" | "chat";

interface RunWorkspaceComponentProps {
  readonly activeTab: Tab;
  readonly reportDetail: ReportDetail;
  readonly showSources: boolean;
  readonly detail: RunDetail;
  readonly loadingDetail: false;
  readonly selectedFile: string;
  readonly fileContent: string;
  readonly highlightSourceId: string;
  readonly onTabChange: () => void;
  readonly onLoadFile: () => void;
  readonly onGoHome: () => void;
  readonly onHighlightSource: () => void;
  readonly onOpenInstrument: () => void;
}

const libRoot = resolve(import.meta.dir, "../../app/client/lib");
Bun.plugin({
  name: "svelte-server-test-loader",
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
      const source = path.endsWith("run-chat.svelte") ? "<div></div>" : await Bun.file(path).text();
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

const detail = JSON.parse(await Bun.stdin.text()) as RunDetail;
const reportDetail: ReportDetail = Bun.argv[2] === "advanced" ? "advanced" : "simple";
const TABS: readonly Tab[] = ["report", "sources", "data", "files", "chat"];
const activeTab: Tab = TABS.find((tab) => tab === Bun.argv[3]) ?? "report";
const showSources = Bun.argv[4] === "sources";
const componentModule =
  (await import("../../app/client/components/run-workspace.svelte")) as unknown as {
    readonly default: Component<RunWorkspaceComponentProps>;
  };
const result = render(componentModule.default, {
  props: {
    activeTab,
    reportDetail,
    showSources,
    detail,
    loadingDetail: false,
    selectedFile: "",
    fileContent: "",
    highlightSourceId: "",
    onTabChange: () => {},
    onLoadFile: () => {},
    onGoHome: () => {},
    onHighlightSource: () => {},
    onOpenInstrument: () => {},
  },
});
process.stdout.write(result.body);
