<script lang="ts">
  import { onMount } from "svelte";
  import {
    createJob,
    fetchJobs,
    fetchProviderHealth,
    fetchRunDetail,
    fetchRunFile,
    fetchRuns,
  } from "./api";
  import {
    formatDate,
    jsonBlock,
    matchesQuery,
    predictions,
    runLabel,
    scenarios,
    sources,
    stringArray,
    textItems,
  } from "./view-model";
  import type { ConsoleJob, ProviderHealthDetail, RunDetail, RunSummary } from "../types";

  const SECTION_KEYS = [
    ["keyFindings", "Key findings"],
    ["bullCase", "Bull case"],
    ["bearCase", "Bear case"],
    ["risks", "Risks"],
    ["catalysts", "Catalysts"],
  ] as const;

  const TABS = [
    "report",
    "sources",
    "analytics",
    "trace",
    "files",
    "score",
    "health",
    "jobs",
  ] as const;

  type Tab = (typeof TABS)[number];

  let runs = $state<readonly RunSummary[]>([]);
  let selectedRunId = $state("");
  let detail = $state<RunDetail | null>(null);
  const query = $state({ text: "" });
  let error = $state("");
  let loadingRuns = $state(true);
  let loadingDetail = $state(false);
  let activeTab = $state<Tab>("report");
  let fileContent = $state("");
  let selectedFile = $state("");
  let providerHealth = $state<ProviderHealthDetail>({});
  let jobs = $state<readonly ConsoleJob[]>([]);
  const jobForm = $state({
    jobType: "daily",
    assetClass: "equity",
    symbol: "",
    depth: "brief",
  });

  async function selectRun(runId: string): Promise<void> {
    selectedRunId = runId;
    loadingDetail = true;
    error = "";
    activeTab = "report";
    selectedFile = "";
    fileContent = "";

    try {
      detail = await fetchRunDetail(runId);
    } catch (caughtError: unknown) {
      detail = null;
      error = caughtError instanceof Error ? caughtError.message : String(caughtError);
    } finally {
      loadingDetail = false;
    }
  }

  async function loadFile(path: string): Promise<void> {
    if (detail === null) {
      return;
    }

    selectedFile = path;
    fileContent = "Loading file...";
    error = "";

    try {
      const file = await fetchRunFile(detail.summary.runId, path);
      fileContent = file.content;
    } catch (caughtError: unknown) {
      fileContent = "";
      error = caughtError instanceof Error ? caughtError.message : String(caughtError);
    }
  }

  async function refreshJobs(): Promise<void> {
    jobs = await fetchJobs();
  }

  async function submitJob(): Promise<void> {
    error = "";

    try {
      await createJob({
        jobType: jobForm.jobType,
        assetClass: jobForm.assetClass,
        symbol: jobForm.symbol,
        depth: jobForm.depth,
      });
      await refreshJobs();
      activeTab = "jobs";
    } catch (caughtError: unknown) {
      error = caughtError instanceof Error ? caughtError.message : String(caughtError);
    }
  }

  onMount(() => {
    const interval = setInterval(() => {
      if (activeTab === "jobs") {
        void refreshJobs().catch(() => {});
      }
    }, 2000);

    void (async () => {
      try {
        runs = await fetchRuns();
        providerHealth = await fetchProviderHealth();
        await refreshJobs();
        if (runs[0] !== undefined) {
          await selectRun(runs[0].runId);
        }
      } catch (caughtError: unknown) {
        error = caughtError instanceof Error ? caughtError.message : String(caughtError);
      } finally {
        loadingRuns = false;
      }
    })();

    return () => clearInterval(interval);
  });

  const filteredRuns = $derived(
    query.text.trim() === "" ? runs : runs.filter((run) => matchesQuery(run, query.text)),
  );
  const report = $derived(detail?.report);
  const reportSummary = $derived(
    typeof report?.summary === "string" ? report.summary : "No summary is available.",
  );
  const scenarioItems = $derived(scenarios(report));
  const forecastItems = $derived(predictions(report));
  const sourceItems = $derived(sources(report));
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
      <input bind:value={query.text} placeholder="ticker, asset, job, confidence" />
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

      <nav class="tabs" aria-label="Run artifact views">
        {#each TABS as tab}
          <button class:active={activeTab === tab} type="button" onclick={() => (activeTab = tab)}>
            {tab}
          </button>
        {/each}
      </nav>

      {#if activeTab === "report"}
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
      {:else if activeTab === "sources"}
        <section class="panel wide">
          <h3>Sources</h3>
          <div class="table">
            {#each sourceItems as source}
              <div class="row">
                <strong>{source.id}</strong>
                <span>{source.title}</span>
                <small>{source.kind ?? "source"} {source.provider ?? ""}</small>
                {#if source.url !== undefined}
                  <a href={source.url} target="_blank" rel="noreferrer">Open</a>
                {/if}
              </div>
            {/each}
          </div>
        </section>
      {:else if activeTab === "analytics"}
        <section class="panel wide raw">
          <h3>Analytics</h3>
          <pre>{jsonBlock(detail.analytics)}</pre>
        </section>
      {:else if activeTab === "trace"}
        <section class="panel wide raw">
          <h3>Trace / logs</h3>
          <pre>{jsonBlock(detail.trace)}</pre>
        </section>
      {:else if activeTab === "files"}
        <section class="panel wide">
          <h3>Files</h3>
          <div class="file-grid">
            <div class="file-list">
              {#each detail.summary.availableFiles as file}
                <button
                  class:active={selectedFile === file}
                  type="button"
                  onclick={() => void loadFile(file)}
                >
                  {file}
                </button>
              {/each}
            </div>
            <pre>{fileContent === "" ? "Select a file." : fileContent}</pre>
          </div>
        </section>
      {:else if activeTab === "score"}
        <section class="panel wide raw">
          <h3>Score</h3>
          <pre>{jsonBlock(detail.score)}</pre>
        </section>
      {:else if activeTab === "health"}
        <section class="panel wide raw">
          <h3>Provider Health</h3>
          <pre>{jsonBlock(providerHealth.summary)}</pre>
          {#if providerHealth.markdown !== undefined}
            <pre>{providerHealth.markdown}</pre>
          {/if}
        </section>
      {:else if activeTab === "jobs"}
        <section class="panel wide">
          <h3>Jobs</h3>
          <form class="job-form" onsubmit={(event) => { event.preventDefault(); void submitJob(); }}>
            <label>
              Job
              <select bind:value={jobForm.jobType}>
                <option value="daily">daily</option>
                <option value="weekly">weekly</option>
                <option value="ticker">ticker</option>
                <option value="alpha-search">alpha-search</option>
                <option value="score">score</option>
                <option value="calibration">calibration</option>
                <option value="cache-prune">cache prune</option>
                <option value="provider-health">provider health</option>
              </select>
            </label>
            {#if jobForm.jobType === "daily" || jobForm.jobType === "weekly" || jobForm.jobType === "ticker"}
              <label>
                Asset
                <select bind:value={jobForm.assetClass}>
                  <option value="equity">equity</option>
                  <option value="crypto">crypto</option>
                </select>
              </label>
            {/if}
            {#if jobForm.jobType === "ticker"}
              <label>
                Symbol
                <input bind:value={jobForm.symbol} placeholder="AAPL" />
              </label>
            {/if}
            {#if jobForm.jobType === "daily" || jobForm.jobType === "weekly" || jobForm.jobType === "ticker" || jobForm.jobType === "alpha-search"}
              <label>
                Depth
                <select bind:value={jobForm.depth}>
                  <option value="brief">brief</option>
                  <option value="deep">deep</option>
                </select>
              </label>
            {/if}
            <button type="submit">Queue job</button>
          </form>

          <div class="job-list">
            {#if jobs.length === 0}
              <p class="muted">No jobs queued yet.</p>
            {:else}
              {#each jobs as job}
                <div class="job-row">
                  <strong>{job.label}</strong>
                  <span class:running={job.status === "running"}>{job.status}</span>
                  <small>{formatDate(job.createdAt)}</small>
                  {#if job.outputRunPath !== undefined}
                    <small>{job.outputRunPath}</small>
                  {/if}
                  {#if job.stdout !== "" || job.stderr !== ""}
                    <pre>{job.stdout}{job.stderr}</pre>
                  {/if}
                </div>
              {/each}
            {/if}
          </div>
        </section>
      {/if}
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

  .job-form {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: end;
    margin-bottom: 18px;
  }

  .job-form label {
    display: grid;
    gap: 6px;
    color: #344640;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
  }

  .job-form button {
    border: 1px solid #1d2522;
    border-radius: 4px;
    background: #1d2522;
    color: #fffdf8;
    padding: 9px 12px;
    cursor: pointer;
  }

  .job-list {
    display: grid;
    gap: 10px;
  }

  .job-row {
    display: grid;
    gap: 6px;
    border: 1px solid rgba(29, 37, 34, 0.14);
    border-radius: 6px;
    background: #fffdf8;
    padding: 12px;
  }

  .job-row span {
    width: fit-content;
    border: 1px solid rgba(29, 37, 34, 0.16);
    border-radius: 999px;
    padding: 3px 8px;
    color: #344640;
    font-size: 12px;
    font-weight: 700;
  }

  .job-row span.running {
    border-color: #b45f3a;
    color: #7c3d23;
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

  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 18px;
  }

  .tabs button,
  .file-list button {
    border: 1px solid rgba(29, 37, 34, 0.16);
    border-radius: 4px;
    background: #fffdf8;
    color: #344640;
    padding: 8px 10px;
    cursor: pointer;
    text-transform: capitalize;
  }

  .tabs button:hover,
  .tabs button:focus-visible,
  .tabs button.active,
  .file-list button:hover,
  .file-list button:focus-visible,
  .file-list button.active {
    border-color: #b45f3a;
    color: #111715;
    outline: none;
  }

  .panel {
    border: 1px solid rgba(29, 37, 34, 0.15);
    border-radius: 6px;
    background: rgba(255, 253, 248, 0.76);
    padding: 18px;
  }

  .lead,
  .raw,
  .wide {
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

  .table {
    display: grid;
    gap: 8px;
  }

  .row {
    display: grid;
    grid-template-columns: minmax(120px, 0.8fr) minmax(220px, 2fr) minmax(120px, 1fr) auto;
    gap: 12px;
    align-items: center;
    border-bottom: 1px solid rgba(29, 37, 34, 0.1);
    padding: 10px 0;
  }

  a {
    color: #8f4b2d;
    font-weight: 700;
  }

  .file-grid {
    display: grid;
    grid-template-columns: minmax(200px, 280px) 1fr;
    gap: 14px;
  }

  .file-list {
    display: grid;
    align-content: start;
    gap: 6px;
  }

  .file-list button {
    overflow-wrap: anywhere;
    text-align: left;
    text-transform: none;
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

    .row,
    .file-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
