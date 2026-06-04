<script lang="ts">
  import { onMount } from "svelte";
  import { AlertCircle, Clock } from "@lucide/svelte";
  import { Badge } from "$lib/components/ui/badge";
  import {
    createJob,
    fetchJobs,
    fetchProviderHealth,
    fetchRunDetail,
    fetchRunFile,
    fetchRunSearch,
    fetchRuns,
  } from "./api";
  import DashboardOverview from "./components/dashboard-overview.svelte";
  import type { JobFormField, SearchFormField, Tab } from "./components/console-types";
  import RunSidebar from "./components/run-sidebar.svelte";
  import RunWorkspace from "./components/run-workspace.svelte";
  import type {
    ConsoleJob,
    ProviderHealthDetail,
    RunDetail,
    RunSearchResult,
    RunSummary,
  } from "../types";
  import {
    dashboardMetrics,
    formatDate,
    matchesQuery,
    recentRunSummaries,
    runIdFromPathname,
    runLabel,
    runPath,
    runTrend,
  } from "./view-model";

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
  let searchResults = $state<readonly RunSearchResult[]>([]);
  let searchLoading = $state(false);
  let searchNotice = $state("");
  const searchForm = $state({
    query: "",
    symbol: "",
    assetClass: "",
    jobType: "",
    from: "",
    to: "",
  });
  const jobForm = $state({
    jobType: "daily",
    assetClass: "equity",
    symbol: "",
    depth: "brief",
  });

  const filteredRuns = $derived(
    query.text.trim() === "" ? runs : runs.filter((run) => matchesQuery(run, query.text)),
  );
  const metrics = $derived(dashboardMetrics(runs));
  const trend = $derived(runTrend(runs));
  const recentRuns = $derived(recentRunSummaries(runs));
  const JOBS_POLL_INTERVAL_MS = 2000;

  function clearSelectedRun(): void {
    selectedRunId = "";
    detail = null;
    loadingDetail = false;
    activeTab = "report";
    selectedFile = "";
    fileContent = "";
  }

  async function selectRun(runId: string, nextTab: Tab = "report"): Promise<void> {
    selectedRunId = runId;
    loadingDetail = true;
    error = "";
    activeTab = nextTab;
    selectedFile = "";
    fileContent = "";

    try {
      const nextDetail = await fetchRunDetail(runId);
      if (selectedRunId === runId) {
        detail = nextDetail;
      }
    } catch (caughtError: unknown) {
      if (selectedRunId === runId) {
        clearSelectedRun();
        error = caughtError instanceof Error ? caughtError.message : String(caughtError);
      }
    } finally {
      if (selectedRunId === runId) {
        loadingDetail = false;
      }
    }
  }

  async function openRun(runId: string, nextTab: Tab = "report"): Promise<void> {
    const pathname = runPath(runId);
    if (globalThis.location.pathname !== pathname) {
      globalThis.history.pushState({}, "", pathname);
    }

    await selectRun(runId, nextTab);
  }

  function handlePopState(): void {
    const runId = runIdFromPathname(globalThis.location.pathname);
    if (runId === undefined) {
      clearSelectedRun();
      error = "";
      return;
    }

    void selectRun(runId);
  }

  function tabForSearchResult(result: RunSearchResult): Tab {
    return result.section === "sources" ? "sources" : "report";
  }

  async function openSearchResult(result: RunSearchResult): Promise<void> {
    await openRun(result.run.runId, tabForSearchResult(result));
  }

  async function runSearch(): Promise<void> {
    const searchQuery = searchForm.query.trim();
    searchNotice = "";
    error = "";

    if (searchQuery === "") {
      searchResults = [];
      searchNotice = "Enter a search query.";
      return;
    }

    searchLoading = true;
    try {
      searchResults = await fetchRunSearch({
        query: searchQuery,
        symbol: searchForm.symbol,
        assetClass: searchForm.assetClass,
        jobType: searchForm.jobType,
        from: searchForm.from,
        to: searchForm.to,
      });
      searchNotice = searchResults.length === 0 ? "No matching report sections." : "";
    } catch (caughtError: unknown) {
      searchResults = [];
      error = caughtError instanceof Error ? caughtError.message : String(caughtError);
    } finally {
      searchLoading = false;
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

  function updateSearchForm(field: SearchFormField, value: string): void {
    searchForm[field] = value;
  }

  function updateJobForm(field: JobFormField, value: string): void {
    jobForm[field] = value;
  }

  onMount(() => {
    const interval = setInterval(() => {
      if (activeTab === "jobs") {
        void refreshJobs().catch(() => {});
      }
    }, JOBS_POLL_INTERVAL_MS);
    globalThis.addEventListener("popstate", handlePopState);

    void (async () => {
      try {
        const initialRunId = runIdFromPathname(globalThis.location.pathname);
        const [nextRuns, nextProviderHealth, nextJobs] = await Promise.all([
          fetchRuns(),
          fetchProviderHealth(),
          fetchJobs(),
        ]);
        runs = nextRuns;
        providerHealth = nextProviderHealth;
        jobs = nextJobs;
        if (initialRunId !== undefined) {
          await selectRun(initialRunId);
        }
      } catch (caughtError: unknown) {
        error = caughtError instanceof Error ? caughtError.message : String(caughtError);
      } finally {
        loadingRuns = false;
      }
    })();

    return () => {
      clearInterval(interval);
      globalThis.removeEventListener("popstate", handlePopState);
    };
  });
</script>

<main class="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(8,145,178,0.16),transparent_32rem),linear-gradient(180deg,rgba(240,249,255,0.72),rgba(236,254,255,0.38))]">
  <div class="flex min-h-screen">
    <RunSidebar
      runs={filteredRuns}
      {selectedRunId}
      {loadingRuns}
      queryText={query.text}
      onQueryChange={(value) => (query.text = value)}
      onSelectRun={(runId) => void openRun(runId)}
    />

    <section class="min-w-0 flex-1">
      <div class="mx-auto max-w-[1500px] px-3 py-4 lg:px-6 lg:py-6">
        <header class="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div class="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-cyan-800">
              <span class="h-2 w-2 rounded-full bg-cyan-500"></span>
              Research-only dashboard
            </div>
            <h2 class="mt-1 text-2xl font-semibold tracking-normal text-foreground">
              Research Console App
            </h2>
          </div>
          <Badge variant="outline" class="border-cyan-700/30 bg-cyan-100/70 text-cyan-900">
            {runs.length} stored runs
          </Badge>
        </header>

        {#if error !== ""}
          <div class="mb-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle class="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        {/if}

        {#if selectedRunId === ""}
          <DashboardOverview {metrics} {trend} />

          <section class="mt-4">
            <div class="mb-3 flex items-center justify-between gap-3">
              <h3 class="text-base font-semibold tracking-normal text-foreground">Recent runs</h3>
              <Badge variant="outline" class="border-cyan-700/30 bg-cyan-100/70 text-cyan-900">
                Last {recentRuns.length}
              </Badge>
            </div>

            {#if loadingRuns}
              <div class="rounded-md border border-cyan-900/10 bg-card/90 p-5 text-sm text-muted-foreground">
                Loading recent runs...
              </div>
            {:else if recentRuns.length === 0}
              <div class="rounded-md border border-cyan-900/10 bg-card/90 p-5 text-sm text-muted-foreground">
                No stored runs yet.
              </div>
            {:else}
              <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                {#each recentRuns as run}
                  <button
                    class="min-h-36 rounded-md border border-cyan-900/10 bg-card/90 p-4 text-left shadow-sm transition hover:border-cyan-500/45 hover:bg-cyan-50/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-700/35"
                    type="button"
                    onclick={() => void openRun(run.runId)}
                  >
                    <span class="block truncate text-sm font-semibold text-foreground">{runLabel(run)}</span>
                    <span class="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock class="size-3" />
                      {formatDate(run.generatedAt)}
                    </span>
                    <span class="mt-4 grid grid-cols-3 gap-2 text-center text-xs">
                      <span class="rounded-md border bg-cyan-50/60 px-2 py-2">
                        <span class="block font-semibold text-foreground">{run.sourceCount}</span>
                        <span class="text-muted-foreground">sources</span>
                      </span>
                      <span class="rounded-md border bg-cyan-50/60 px-2 py-2">
                        <span class="block font-semibold text-foreground">{run.predictionCount}</span>
                        <span class="text-muted-foreground">forecasts</span>
                      </span>
                      <span class="rounded-md border bg-cyan-50/60 px-2 py-2">
                        <span class="block font-semibold text-foreground">{run.dataGapCount}</span>
                        <span class="text-muted-foreground">gaps</span>
                      </span>
                    </span>
                  </button>
                {/each}
              </div>
            {/if}
          </section>
        {:else}
          <div class="mt-4">
            <RunWorkspace
              {activeTab}
              {detail}
              {loadingDetail}
              {selectedFile}
              {fileContent}
              {providerHealth}
              {jobs}
              {searchResults}
              {searchLoading}
              {searchNotice}
              {searchForm}
              {jobForm}
              onTabChange={(tab) => (activeTab = tab)}
              onLoadFile={(path) => void loadFile(path)}
              onRunSearch={() => void runSearch()}
              onOpenSearchResult={(result) => void openSearchResult(result)}
              onSearchFormChange={updateSearchForm}
              onJobFormChange={updateJobForm}
              onSubmitJob={() => void submitJob()}
            />
          </div>
        {/if}
      </div>
    </section>
  </div>
</main>
