<script lang="ts">
  import { onMount } from "svelte";
  import {
    createJob,
    fetchCalibration,
    fetchJobs,
    fetchProviderHealth,
    fetchRunDetail,
    fetchRunFile,
    fetchRunSearch,
    fetchRuns,
  } from "./api";
  import DashboardOverview from "./components/dashboard-overview.svelte";
  import type {
    JobFormField,
    SearchFormField,
    Tab,
    View,
  } from "./components/console-types";
  import CalibrationView from "./components/calibration-view.svelte";
  import HealthView from "./components/health-view.svelte";
  import JobsView from "./components/jobs-view.svelte";
  import RunSidebar from "./components/run-sidebar.svelte";
  import RunWorkspace from "./components/run-workspace.svelte";
  import SearchView from "./components/search-view.svelte";
  import type {
    CalibrationDetail,
    ConsoleJob,
    ProviderHealthDetail,
    RunDetail,
    RunSearchResult,
    RunSummary,
  } from "../types";
  import {
    dashboardMetrics,
    filterRuns,
    groupedRunsByType,
    recentRunSummaries,
    runIdFromPathname,
    runPath,
    runTrend,
    VERIFIED_SNAPSHOT_PATH,
    verifiedSnapshotView,
    type SnapshotView,
  } from "./view-model";

  let view = $state<View>("dashboard");
  let runs = $state<readonly RunSummary[]>([]);
  let selectedRunId = $state("");
  let detail = $state<RunDetail | null>(null);
  let snapshot = $state<SnapshotView | null>(null);
  const query = $state({ text: "" });
  let typeFilter = $state("all");
  let error = $state("");
  let loadingRuns = $state(true);
  let loadingDetail = $state(false);
  let activeTab = $state<Tab>("report");
  let highlightSourceId = $state("");
  let fileContent = $state("");
  let selectedFile = $state("");
  let providerHealth = $state<ProviderHealthDetail>({});
  let calibration = $state<CalibrationDetail>({});
  let jobs = $state<readonly ConsoleJob[]>([]);
  let searchResults = $state<readonly RunSearchResult[]>([]);
  let searchLoading = $state(false);
  let searchNotice = $state("");
  let hasSearched = $state(false);
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

  const JOBS_POLL_INTERVAL_MS = 2000;
  const DASHBOARD_RECENT_RUN_LIMIT = 6;

  const filteredRuns = $derived(filterRuns(runs, typeFilter, query.text));
  const runTypes = $derived(groupedRunsByType(runs).map((group) => group.type));
  const metrics = $derived(dashboardMetrics(runs));
  const trend = $derived(runTrend(runs));
  const recentRuns = $derived(recentRunSummaries(runs, DASHBOARD_RECENT_RUN_LIMIT));
  const activeJobCount = $derived(
    jobs.filter((job) => job.status === "running" || job.status === "queued").length,
  );

  function clearSelectedRun(): void {
    selectedRunId = "";
    detail = null;
    snapshot = null;
    loadingDetail = false;
    activeTab = "report";
    selectedFile = "";
    fileContent = "";
    highlightSourceId = "";
  }

  function navigate(nextView: Exclude<View, "run">): void {
    view = nextView;
    clearSelectedRun();
    error = "";
    if (globalThis.location.pathname !== "/") {
      globalThis.history.pushState({}, "", "/");
    }
  }

  async function selectRun(runId: string, nextTab: Tab = "report"): Promise<void> {
    view = "run";
    selectedRunId = runId;
    loadingDetail = true;
    error = "";
    activeTab = nextTab;
    selectedFile = "";
    fileContent = "";
    highlightSourceId = "";

    try {
      const nextDetail = await fetchRunDetail(runId);
      if (selectedRunId === runId) {
        detail = nextDetail;
        void loadSnapshot(nextDetail);
      }
    } catch (caughtError: unknown) {
      if (selectedRunId === runId) {
        view = "dashboard";
        clearSelectedRun();
        error = caughtError instanceof Error ? caughtError.message : String(caughtError);
        if (globalThis.location.pathname !== "/") {
          globalThis.history.replaceState({}, "", "/");
        }
      }
    } finally {
      if (selectedRunId === runId) {
        loadingDetail = false;
      }
    }
  }

  async function loadSnapshot(runDetail: RunDetail): Promise<void> {
    const { runId, jobType, availableFiles } = runDetail.summary;
    snapshot = null;
    if (jobType !== "ticker" || !availableFiles.includes(VERIFIED_SNAPSHOT_PATH)) {
      return;
    }

    try {
      const file = await fetchRunFile(runId, VERIFIED_SNAPSHOT_PATH);
      if (selectedRunId === runId) {
        snapshot = verifiedSnapshotView(file.content) ?? null;
      }
    } catch {
      // The report stands on its own; a missing or malformed snapshot stays hidden.
    }
  }

  async function openRun(runId: string, nextTab: Tab = "report"): Promise<void> {
    const pathname = runPath(runId);
    if (globalThis.location.pathname !== pathname) {
      globalThis.history.pushState({}, "", pathname);
    }

    await selectRun(runId, nextTab);
    globalThis.scrollTo({ top: 0 });
  }

  function handlePopState(): void {
    const runId = runIdFromPathname(globalThis.location.pathname);
    if (runId === undefined) {
      view = "dashboard";
      clearSelectedRun();
      error = "";
      return;
    }

    void selectRun(runId);
  }

  function handleRunKeyNav(event: KeyboardEvent): void {
    if (view !== "dashboard" && view !== "run") {
      return;
    }

    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }

    const { target } = event;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
    ) {
      return;
    }

    if (event.key !== "j" && event.key !== "k") {
      return;
    }

    const list = filteredRuns;
    if (list.length === 0) {
      return;
    }

    const step = event.key === "j" ? 1 : -1;
    const index = list.findIndex((run) => run.runId === selectedRunId);
    let next = Math.min(list.length - 1, Math.max(0, index + step));
    if (index === -1) {
      next = step === 1 ? 0 : list.length - 1;
    }

    const run = list[next];
    if (run !== undefined) {
      void openRun(run.runId);
    }
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
    hasSearched = true;

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
      searchNotice =
        searchResults.length === 0
          ? `No sections match “${searchQuery}”. Search covers findings, cases, risks, catalysts, forecasts and gaps.`
          : "";
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
      if (view === "jobs" || activeJobCount > 0) {
        void refreshJobs().catch(() => {});
      }
    }, JOBS_POLL_INTERVAL_MS);
    globalThis.addEventListener("popstate", handlePopState);
    globalThis.addEventListener("keydown", handleRunKeyNav);

    void (async () => {
      try {
        const initialRunId = runIdFromPathname(globalThis.location.pathname);
        const [nextRuns, nextProviderHealth, nextCalibration, nextJobs] = await Promise.all([
          fetchRuns(),
          fetchProviderHealth(),
          fetchCalibration(),
          fetchJobs(),
        ]);
        runs = nextRuns;
        providerHealth = nextProviderHealth;
        calibration = nextCalibration;
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
      globalThis.removeEventListener("keydown", handleRunKeyNav);
    };
  });
</script>

<div class="flex min-h-screen bg-background text-foreground">
  <RunSidebar
    runs={filteredRuns}
    {runTypes}
    {selectedRunId}
    {loadingRuns}
    {view}
    {activeJobCount}
    queryText={query.text}
    {typeFilter}
    onQueryChange={(value) => (query.text = value)}
    onTypeFilterChange={(value) => (typeFilter = value)}
    onSelectRun={(runId) => void openRun(runId)}
    onNavigate={navigate}
  />

  <main class="min-w-0 flex-1">
    <div class="mx-auto max-w-295 px-4 py-6 lg:px-10 lg:py-7">
      {#if error !== ""}
        <div
          class="mb-4 flex items-start gap-3 rounded-lg border border-[#d9c89a] bg-[#fbf6ea] px-4 py-3"
        >
          <span
            class="mt-px shrink-0 rounded border border-[#d9c89a] bg-[#f5ecd6] px-1.5 py-px font-mono text-[10px] text-[#8a6116]"
          >
            ERROR
          </span>
          <span class="text-[12.5px] leading-normal text-[#4a4334]">{error}</span>
        </div>
      {/if}

      {#if view === "dashboard"}
        <DashboardOverview
          {metrics}
          {trend}
          {recentRuns}
          {loadingRuns}
          onOpenRun={(runId) => void openRun(runId)}
        />
      {:else if view === "run"}
        <RunWorkspace
          {activeTab}
          {detail}
          {snapshot}
          {loadingDetail}
          {selectedFile}
          {fileContent}
          {highlightSourceId}
          onTabChange={(tab) => (activeTab = tab)}
          onLoadFile={(path) => void loadFile(path)}
          onGoHome={() => navigate("dashboard")}
          onHighlightSource={(sourceId) => (highlightSourceId = sourceId)}
        />
      {:else if view === "search"}
        <SearchView
          {searchResults}
          {searchLoading}
          {searchNotice}
          {searchForm}
          {hasSearched}
          onRunSearch={() => void runSearch()}
          onOpenSearchResult={(result) => void openSearchResult(result)}
          onSearchFormChange={updateSearchForm}
        />
      {:else if view === "jobs"}
        <JobsView {jobs} {jobForm} onJobFormChange={updateJobForm} onSubmitJob={() => void submitJob()} />
      {:else if view === "calibration"}
        <CalibrationView {calibration} onNavigate={navigate} />
      {:else}
        <HealthView {providerHealth} />
      {/if}
    </div>
  </main>
</div>
