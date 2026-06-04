<script lang="ts">
  import { onMount } from "svelte";
  import { fetchRunDetail, fetchRuns } from "./api";
  import type { RunDetail, RunSummary } from "../types";

  interface TextWithSources {
    readonly text: string;
    readonly sourceIds: readonly string[];
  }

  interface ScenarioView {
    readonly name: string;
    readonly description: string;
    readonly sourceIds: readonly string[];
  }

  interface PredictionView {
    readonly id: string;
    readonly claim: string;
    readonly kind?: string;
    readonly probability?: number;
    readonly horizonTradingDays?: number;
    readonly sourceIds: readonly string[];
  }

  const SECTION_KEYS = [
    ["keyFindings", "Key findings"],
    ["bullCase", "Bull case"],
    ["bearCase", "Bear case"],
    ["risks", "Risks"],
    ["catalysts", "Catalysts"],
  ] as const;

  let runs = $state<readonly RunSummary[]>([]);
  let selectedRunId = $state("");
  let detail = $state<RunDetail | null>(null);
  // oxlint-disable-next-line eslint(prefer-const) -- Svelte bind:value updates this state.
  let query = $state("");
  let error = $state("");
  let loadingRuns = $state(true);
  let loadingDetail = $state(false);

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function readString(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === "string" ? value : undefined;
  }

  function readNumber(record: Record<string, unknown>, key: string): number | undefined {
    const value = record[key];
    return typeof value === "number" ? value : undefined;
  }

  function readSourceIds(record: Record<string, unknown>): readonly string[] {
    const { sourceIds } = record;
    return Array.isArray(sourceIds)
      ? sourceIds.filter((sourceId): sourceId is string => typeof sourceId === "string")
      : [];
  }

  function textItems(
    report: Record<string, unknown> | undefined,
    key: string,
  ): readonly TextWithSources[] {
    const value = report?.[key];
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter((item) => isRecord(item)).flatMap((item) => {
      const text = readString(item, "text");
      return text === undefined ? [] : [{ text, sourceIds: readSourceIds(item) }];
    });
  }

  function scenarios(report: Record<string, unknown> | undefined): readonly ScenarioView[] {
    const value = report?.scenarios;
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter((item) => isRecord(item)).flatMap((item) => {
      const name = readString(item, "name");
      const description = readString(item, "description");
      return name === undefined || description === undefined
        ? []
        : [{ name, description, sourceIds: readSourceIds(item) }];
    });
  }

  function predictions(report: Record<string, unknown> | undefined): readonly PredictionView[] {
    const value = report?.predictions;
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter((item) => isRecord(item)).flatMap((item) => {
      const id = readString(item, "id");
      const claim = readString(item, "claim");
      return id === undefined || claim === undefined
        ? []
        : [
            {
              id,
              claim,
              ...(readString(item, "kind") !== undefined
                ? { kind: readString(item, "kind") as string }
                : {}),
              ...(readNumber(item, "probability") !== undefined
                ? { probability: readNumber(item, "probability") as number }
                : {}),
              ...(readNumber(item, "horizonTradingDays") !== undefined
                ? { horizonTradingDays: readNumber(item, "horizonTradingDays") as number }
                : {}),
              sourceIds: readSourceIds(item),
            },
          ];
    });
  }

  function stringArray(report: Record<string, unknown> | undefined, key: string): readonly string[] {
    const value = report?.[key];
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  }

  function runLabel(run: RunSummary): string {
    const subject = run.symbol ?? run.assetClass ?? "unknown";
    return `${run.jobType ?? "run"} / ${subject}`;
  }

  function formatDate(value: string | undefined): string {
    if (value === undefined) {
      return "unknown time";
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  }

  function matchesQuery(run: RunSummary, text: string): boolean {
    const haystack = [
      run.runId,
      run.jobType,
      run.assetClass,
      run.symbol,
      run.depth,
      run.confidence,
    ]
      .filter((value): value is string => value !== undefined)
      .join(" ")
      .toLowerCase();

    return haystack.includes(text.trim().toLowerCase());
  }

  async function selectRun(runId: string): Promise<void> {
    selectedRunId = runId;
    loadingDetail = true;
    error = "";

    try {
      detail = await fetchRunDetail(runId);
    } catch (caughtError: unknown) {
      detail = null;
      error = caughtError instanceof Error ? caughtError.message : String(caughtError);
    } finally {
      loadingDetail = false;
    }
  }

  onMount(() => {
    void (async () => {
      try {
        runs = await fetchRuns();
        if (runs[0] !== undefined) {
          await selectRun(runs[0].runId);
        }
      } catch (caughtError: unknown) {
        error = caughtError instanceof Error ? caughtError.message : String(caughtError);
      } finally {
        loadingRuns = false;
      }
    })();
  });

  const filteredRuns = $derived(
    query.trim() === "" ? runs : runs.filter((run) => matchesQuery(run, query)),
  );
  const report = $derived(detail?.report);
  const reportSummary = $derived(readString(report ?? {}, "summary") ?? "No summary is available.");
  const scenarioItems = $derived(scenarios(report));
  const forecastItems = $derived(predictions(report));
  const gaps = $derived(stringArray(report, "dataGaps"));
</script>

<main class="shell">
  <aside class="sidebar" aria-label="Run history">
    <div class="brand">
      <p>Market Bot</p>
      <h1>Research Console</h1>
    </div>

    <label class="search">
      <span>Search runs</span>
      <input bind:value={query} placeholder="ticker, asset, job, confidence" />
    </label>

    {#if loadingRuns}
      <p class="muted">Loading run history...</p>
    {:else if filteredRuns.length === 0}
      <p class="muted">No matching runs.</p>
    {:else}
      <div class="run-list">
        {#each filteredRuns as run}
          <button
            class:active={run.runId === selectedRunId}
            type="button"
            onclick={() => void selectRun(run.runId)}
          >
            <span class="run-label">{runLabel(run)}</span>
            <span>{formatDate(run.generatedAt)}</span>
            <span class="metrics">
              {run.findingCount} findings / {run.predictionCount} forecasts / {run.dataGapCount} gaps
            </span>
          </button>
        {/each}
      </div>
    {/if}
  </aside>

  <section class="workspace" aria-live="polite">
    {#if error !== ""}
      <div class="notice">{error}</div>
    {/if}

    {#if loadingDetail}
      <div class="empty">Loading selected run...</div>
    {:else if detail === null}
      <div class="empty">Select a run to inspect the research artifact.</div>
    {:else}
      <header class="report-header">
        <div>
          <p class="eyebrow">{detail.summary.runId}</p>
          <h2>{runLabel(detail.summary)}</h2>
          <p>{formatDate(detail.summary.generatedAt)}</p>
        </div>
        <dl>
          <div>
            <dt>Confidence</dt>
            <dd>{detail.summary.confidence ?? "unknown"}</dd>
          </div>
          <div>
            <dt>Sources</dt>
            <dd>{detail.summary.sourceCount}</dd>
          </div>
          <div>
            <dt>Files</dt>
            <dd>{detail.summary.availableFiles.length}</dd>
          </div>
        </dl>
      </header>

      <article class="report">
        <section class="panel lead">
          <h3>Summary</h3>
          <p>{reportSummary}</p>
        </section>

        {#each SECTION_KEYS as [key, label]}
          {@const items = textItems(report, key)}
          {#if items.length > 0}
            <section class="panel">
              <h3>{label}</h3>
              <ul>
                {#each items as item}
                  <li>
                    <span>{item.text}</span>
                    {#if item.sourceIds.length > 0}
                      <small>{item.sourceIds.join(", ")}</small>
                    {/if}
                  </li>
                {/each}
              </ul>
            </section>
          {/if}
        {/each}

        {#if scenarioItems.length > 0}
          <section class="panel">
            <h3>Scenarios</h3>
            <div class="stack">
              {#each scenarioItems as scenario}
                <div>
                  <strong>{scenario.name}</strong>
                  <p>{scenario.description}</p>
                  {#if scenario.sourceIds.length > 0}
                    <small>{scenario.sourceIds.join(", ")}</small>
                  {/if}
                </div>
              {/each}
            </div>
          </section>
        {/if}

        {#if forecastItems.length > 0}
          <section class="panel">
            <h3>Observable forecasts</h3>
            <div class="stack">
              {#each forecastItems as prediction}
                <div>
                  <strong>{prediction.claim}</strong>
                  <p>
                    {prediction.kind ?? "forecast"}
                    {#if prediction.probability !== undefined}
                      / {Math.round(prediction.probability * 100)}%
                    {/if}
                    {#if prediction.horizonTradingDays !== undefined}
                      / {prediction.horizonTradingDays} trading days
                    {/if}
                  </p>
                  {#if prediction.sourceIds.length > 0}
                    <small>{prediction.sourceIds.join(", ")}</small>
                  {/if}
                </div>
              {/each}
            </div>
          </section>
        {/if}

        {#if gaps.length > 0}
          <section class="panel">
            <h3>Data gaps</h3>
            <ul>
              {#each gaps as gap}
                <li>{gap}</li>
              {/each}
            </ul>
          </section>
        {/if}

        {#if detail.markdown !== undefined}
          <section class="panel raw">
            <h3>Markdown fallback</h3>
            <pre>{detail.markdown}</pre>
          </section>
        {/if}
      </article>
    {/if}
  </section>
</main>

<style>
  :global(:root) {
    color: #1d2522;
    background: #f2efe7;
    font-family:
      "Aptos",
      "Segoe UI",
      system-ui,
      sans-serif;
    font-synthesis: none;
    text-rendering: optimizeLegibility;
  }

  :global(body) {
    min-width: 320px;
    min-height: 100vh;
    margin: 0;
    background:
      linear-gradient(90deg, rgba(29, 37, 34, 0.05) 1px, transparent 1px) 0 0 / 28px 28px,
      #f2efe7;
  }

  :global(button),
  :global(input),
  :global(select) {
    font: inherit;
  }

  .shell {
    display: grid;
    min-height: 100vh;
    grid-template-columns: minmax(280px, 360px) 1fr;
  }

  .sidebar {
    position: sticky;
    top: 0;
    height: 100vh;
    overflow: auto;
    border-right: 1px solid rgba(29, 37, 34, 0.16);
    background: rgba(249, 247, 240, 0.92);
    padding: 24px;
  }

  .brand {
    border-top: 3px solid #1d2522;
    padding-top: 16px;
  }

  .brand p,
  .eyebrow {
    margin: 0 0 10px;
    color: #49645b;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0;
    text-transform: uppercase;
  }

  h1,
  h2,
  h3,
  p {
    margin: 0;
  }

  h1 {
    color: #111715;
    font-size: 30px;
    line-height: 1;
  }

  h2 {
    color: #111715;
    font-size: 34px;
    line-height: 1.08;
  }

  h3 {
    margin-bottom: 14px;
    color: #15201c;
    font-size: 16px;
  }

  .search {
    display: grid;
    gap: 8px;
    margin: 24px 0;
    color: #344640;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
  }

  input {
    min-width: 0;
    border: 1px solid rgba(29, 37, 34, 0.22);
    border-radius: 4px;
    background: #fffdf8;
    color: #1d2522;
    padding: 10px 12px;
    text-transform: none;
  }

  .run-list {
    display: grid;
    gap: 8px;
  }

  .run-list button {
    display: grid;
    gap: 6px;
    width: 100%;
    border: 1px solid rgba(29, 37, 34, 0.14);
    border-left: 4px solid transparent;
    border-radius: 6px;
    background: #fffdf8;
    color: #344640;
    padding: 12px;
    text-align: left;
    cursor: pointer;
  }

  .run-list button:hover,
  .run-list button:focus-visible,
  .run-list button.active {
    border-left-color: #b45f3a;
    outline: none;
  }

  .run-label {
    color: #111715;
    font-weight: 800;
  }

  .metrics,
  small,
  .muted {
    color: #6b746f;
    font-size: 12px;
  }

  .workspace {
    min-width: 0;
    padding: 28px;
  }

  .report-header {
    display: flex;
    gap: 24px;
    align-items: end;
    justify-content: space-between;
    border-bottom: 1px solid rgba(29, 37, 34, 0.18);
    padding-bottom: 20px;
  }

  .report-header p {
    margin-top: 8px;
    color: #53645e;
  }

  dl {
    display: flex;
    gap: 10px;
    margin: 0;
  }

  dt {
    color: #6b746f;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
  }

  dd {
    margin: 3px 0 0;
    color: #111715;
    font-weight: 800;
  }

  dl div {
    min-width: 92px;
    border: 1px solid rgba(29, 37, 34, 0.14);
    border-radius: 6px;
    background: #fffdf8;
    padding: 10px;
  }

  .report {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
    margin-top: 20px;
  }

  .panel {
    border: 1px solid rgba(29, 37, 34, 0.15);
    border-radius: 6px;
    background: rgba(255, 253, 248, 0.76);
    padding: 18px;
  }

  .lead,
  .raw {
    grid-column: 1 / -1;
  }

  .panel p,
  li {
    color: #344640;
    line-height: 1.5;
  }

  ul {
    display: grid;
    gap: 12px;
    margin: 0;
    padding-left: 18px;
  }

  li small {
    display: block;
    margin-top: 4px;
  }

  .stack {
    display: grid;
    gap: 14px;
  }

  .stack strong {
    color: #1d2522;
  }

  .stack p {
    margin-top: 4px;
  }

  pre {
    max-height: 340px;
    overflow: auto;
    margin: 0;
    color: #344640;
    white-space: pre-wrap;
  }

  .notice,
  .empty {
    border: 1px solid rgba(180, 95, 58, 0.34);
    border-radius: 6px;
    background: #fff8f2;
    color: #7c3d23;
    padding: 14px;
  }

  .empty {
    border-color: rgba(29, 37, 34, 0.14);
    background: #fffdf8;
    color: #53645e;
  }

  @media (max-width: 900px) {
    .shell {
      grid-template-columns: 1fr;
    }

    .sidebar {
      position: static;
      height: auto;
      border-right: 0;
      border-bottom: 1px solid rgba(29, 37, 34, 0.16);
    }

    .report-header {
      display: grid;
      align-items: start;
    }

    dl,
    .report {
      grid-template-columns: 1fr;
    }
  }
</style>
