<script lang="ts">
  import { onMount } from "svelte";
  import {
    addPin,
    addWatchlistItem,
    fetchAlphaCohorts,
    createJob,
    createWatchlist,
    deleteWatchlist,
    fetchCalibration,
    fetchInstrumentTimeline,
    fetchJobs,
    fetchPins,
    fetchProviderHealth,
    fetchRunDetail,
    fetchRunFile,
    fetchRunSearch,
    fetchRuns,
    fetchWatchlistDetail,
    fetchWatchlists,
    refreshInstrumentProfile,
    removePin,
    removeWatchlistItem,
    renameWatchlist,
    reorderWatchlist,
  } from "./api";
  import { appSettings, setReportDetail, setShowSources, setStaleAfterDays } from "./app-settings.svelte";
  import DashboardOverview from "./components/dashboard-overview.svelte";
  import AlphaCohortsView from "./components/alpha-cohorts-view.svelte";
  import type { JobFormField, SearchFormField, Tab, View } from "./components/console-types";
  import CalibrationView from "./components/calibration-view.svelte";
  import HealthView from "./components/health-view.svelte";
  import InstrumentTimeline from "./components/instrument-timeline.svelte";
  import JobsView from "./components/jobs-view.svelte";
  import RunSidebar from "./components/run-sidebar.svelte";
  import RunWorkspace from "./components/run-workspace.svelte";
  import SearchView from "./components/search-view.svelte";
  import WatchlistsView from "./components/watchlists-view.svelte";
  import type {
    CalibrationDetail,
    AlphaCohortDetail,
    ConsoleJob,
    InstrumentTimelineDetail,
    Pin,
    ProviderHealthDetail,
    RunDetail,
    RunSearchResult,
    RunSummary,
    WatchlistDetail,
    WatchlistSummary,
  } from "../types";
  import {
    dashboardMetrics,
    filterInstrumentRunHistory,
    groupedRunsByType,
    instrumentFromPathname,
    instrumentPath,
    instrumentRunHistory,
    instrumentRunHistoryGroupKey,
    instrumentRunHistoryRows,
    pinnedFirst,
    pinnedSidebarEntries,
    pinToggleIntent,
    recentRunSummaries,
    runCompareCards,
    runIdFromPathname,
    runPath,
    runTrend,
    searchPath,
    searchQueryFromSearchParams,
    sidebarViewFromPathname,
    sidebarViewPath,
    type SidebarView,
  } from "./view-model";

  let view = $state<View>("dashboard");
  let runs = $state<readonly RunSummary[]>([]);
  let selectedRunId = $state("");
  let detail = $state<RunDetail | null>(null);
  let compareDetails = $state<readonly RunDetail[]>([]);
  let instrumentDetail = $state<InstrumentTimelineDetail | null>(null);
  let selectedInstrument = $state<{
    readonly assetClass: string;
    readonly symbol: string;
  } | null>(null);
  const query = $state({ text: "" });
  let typeFilter = $state("all");
  let expandedRunHistoryGroups = $state<readonly string[]>([]);
  let error = $state("");
  let loadingRuns = $state(true);
  let loadingDetail = $state(false);
  let loadingInstrument = $state(false);
  let activeTab = $state<Tab>("report");
  let menuOpen = $state(false);
  let highlightSourceId = $state("");
  let fileContent = $state("");
  let selectedFile = $state("");
  let providerHealth = $state<ProviderHealthDetail>({});
  let calibration = $state<CalibrationDetail>({});
  let alphaCohorts = $state<AlphaCohortDetail>({});
  let jobs = $state<readonly ConsoleJob[]>([]);
  let watchlists = $state<readonly WatchlistSummary[]>([]);
  let selectedWatchlistId = $state<number | null>(null);
  let watchlistDetail = $state<WatchlistDetail | null>(null);
  let loadingWatchlist = $state(false);
  let watchlistLoadError = $state("");
  let pins = $state<readonly Pin[] | null>(null);
  let pinRequestInFlight = $state(false);
  let pinsLoadError = $state("");
  const queueingDeepSymbols = new Set<string>();
  let reorderingWatchlist = false;
  let searchResults = $state<readonly RunSearchResult[]>([]);
  let searchLoading = $state(false);
  let searchNotice = $state("");
  let hasSearched = $state(false);
  let searchRequestId = 0;
  const searchForm = $state({
    query: "",
    symbol: "",
    assetClass: "",
    jobType: "",
    from: "",
    to: "",
  });
  const jobForm = $state({
    jobType: "market-overview",
    assetClass: "equity",
    symbol: "",
    subject: "",
    depth: "brief",
    horizonTradingDays: "15",
  });

  const JOBS_POLL_INTERVAL_MS = 2000;
  const DASHBOARD_RECENT_RUN_LIMIT = 6;

  const pinnedRunIds = $derived(new Set((pins ?? []).map((pin) => pin.runId)));
  const pinnedEntries = $derived(pinnedSidebarEntries(pins ?? [], runs, typeFilter, query.text));
  const runHistoryEntries = $derived(
    instrumentRunHistory(runs.filter((run) => !pinnedRunIds.has(run.runId))),
  );
  const filteredRunHistory = $derived(
    filterInstrumentRunHistory(runHistoryEntries, typeFilter, query.text),
  );
  const visibleRunHistoryRows = $derived(
    instrumentRunHistoryRows(filteredRunHistory, expandedRunHistoryGroups),
  );
  const runTypes = $derived(groupedRunsByType(runs).map((group) => group.type));
  const metrics = $derived(dashboardMetrics(runs));
  const trend = $derived(runTrend(runs));
  const recentRuns = $derived(
    pinnedFirst(recentRunSummaries(runs, DASHBOARD_RECENT_RUN_LIMIT), pinnedRunIds, (run) => run.runId),
  );
  const compareCards = $derived(
    pinnedFirst(runCompareCards(compareDetails), pinnedRunIds, (card) => card.runId),
  );
  const pinnedSearchResults = $derived(
    pinnedFirst(searchResults, pinnedRunIds, (result) => result.run.runId),
  );
  const activeJobCount = $derived(jobs.filter((job) => job.status === "running" || job.status === "queued").length);
  function clearSelectedRun(): void {
    selectedRunId = "";
    detail = null;
    loadingDetail = false;
    activeTab = "report";
    selectedFile = "";
    fileContent = "";
    highlightSourceId = "";
  }

  function clearSelectedInstrument(): void {
    selectedInstrument = null;
    instrumentDetail = null;
    loadingInstrument = false;
  }

  function selectSidebarView(nextView: SidebarView): void {
    view = nextView;
    clearSelectedRun();
    clearSelectedInstrument();
    error = "";
    if (nextView === "dashboard") {
      void loadCompareDetails(runs).catch(() => {
        compareDetails = [];
      });
    }
  }

  function navigate(nextView: SidebarView): void {
    selectSidebarView(nextView);
    const pathname = sidebarViewPath(nextView);
    if (`${globalThis.location.pathname}${globalThis.location.search}` !== pathname) {
      globalThis.history.pushState({}, "", pathname);
    }
    if (nextView === "search") {
      restoreSearchFromLocation();
    }
  }

  function toggleRunHistoryGroup(groupKey: string): void {
    expandedRunHistoryGroups = expandedRunHistoryGroups.includes(groupKey)
      ? expandedRunHistoryGroups.filter((key) => key !== groupKey)
      : [...expandedRunHistoryGroups, groupKey];
  }

  function expandRunHistoryGroup(runId: string): void {
    const groupKey = instrumentRunHistoryGroupKey(runHistoryEntries, runId);
    if (groupKey !== undefined && !expandedRunHistoryGroups.includes(groupKey)) {
      expandedRunHistoryGroups = [...expandedRunHistoryGroups, groupKey];
    }
  }

  async function selectRun(runId: string, nextTab: Tab = "report"): Promise<void> {
    view = "run";
    selectedRunId = runId;
    expandRunHistoryGroup(runId);
    clearSelectedInstrument();
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
      }
    } catch (caughtError: unknown) {
      if (selectedRunId === runId) {
        view = "dashboard";
        clearSelectedRun();
        error = caughtError instanceof Error ? caughtError.message : String(caughtError);
        void loadCompareDetails(runs).catch(() => {
          compareDetails = [];
        });
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

  async function loadCompareDetails(runSummaries: readonly RunSummary[]): Promise<void> {
    const runIds = recentRunSummaries(runSummaries, DASHBOARD_RECENT_RUN_LIMIT).map((run) => run.runId);
    compareDetails = await Promise.all(runIds.map((runId) => fetchRunDetail(runId)));
  }

  async function openRun(runId: string, nextTab: Tab = "report"): Promise<void> {
    const pathname = runPath(runId);
    if (globalThis.location.pathname !== pathname) {
      globalThis.history.pushState({}, "", pathname);
    }

    await selectRun(runId, nextTab);
    globalThis.scrollTo({ top: 0 });
  }

  async function selectInstrument(assetClass: string, symbol: string): Promise<void> {
    const normalizedAssetClass = assetClass.trim();
    const normalizedSymbol = symbol.trim().toUpperCase();
    view = "instrument";
    clearSelectedRun();
    selectedInstrument = { assetClass: normalizedAssetClass, symbol: normalizedSymbol };
    loadingInstrument = true;
    error = "";

    try {
      const timeline = await fetchInstrumentTimeline(normalizedAssetClass, normalizedSymbol);
      if (
        selectedInstrument?.assetClass === normalizedAssetClass &&
        selectedInstrument.symbol === normalizedSymbol
      ) {
        instrumentDetail = timeline;
      }
    } catch (caughtError: unknown) {
      if (view === "instrument") {
        error = caughtError instanceof Error ? caughtError.message : String(caughtError);
      }
    } finally {
      if (view === "instrument") {
        loadingInstrument = false;
      }
    }
  }

  async function openInstrument(assetClass: string, symbol: string): Promise<void> {
    const pathname = instrumentPath(assetClass, symbol);
    if (globalThis.location.pathname !== pathname) {
      globalThis.history.pushState({}, "", pathname);
    }

    await selectInstrument(assetClass, symbol);
    globalThis.scrollTo({ top: 0 });
  }

  function handlePopState(): void {
    const runId = runIdFromPathname(globalThis.location.pathname);
    if (runId !== undefined) {
      void selectRun(runId);
      return;
    }

    const instrument = instrumentFromPathname(globalThis.location.pathname);
    if (instrument !== undefined) {
      void selectInstrument(instrument.assetClass, instrument.symbol);
      return;
    }

    const sidebarView = sidebarViewFromPathname(globalThis.location.pathname) ?? "dashboard";
    selectSidebarView(sidebarView);
    if (sidebarView === "search") {
      restoreSearchFromLocation();
    }
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

    const list = [
      ...pinnedEntries.flatMap((entry) => (entry.run === undefined ? [] : [entry.run])),
      ...visibleRunHistoryRows.map((row) => row.run),
    ];
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
    const requestId = ++searchRequestId;
    const searchQuery = searchForm.query.trim();
    searchNotice = "";
    error = "";
    hasSearched = true;

    if (searchQuery === "") {
      searchResults = [];
      searchNotice = "Enter a search query.";
      searchLoading = false;
      return;
    }

    searchLoading = true;
    try {
      const nextResults = await fetchRunSearch({
        query: searchQuery,
        symbol: searchForm.symbol,
        assetClass: searchForm.assetClass,
        jobType: searchForm.jobType,
        from: searchForm.from,
        to: searchForm.to,
      });
      if (requestId !== searchRequestId) {
        return;
      }
      searchResults = nextResults;
      searchNotice =
        searchResults.length === 0
          ? `No sections match “${searchQuery}”. Search covers findings, cases, risks, catalysts, forecasts, extended evidence, and gaps.`
          : "";
    } catch (caughtError: unknown) {
      if (requestId !== searchRequestId) {
        return;
      }
      searchResults = [];
      error = caughtError instanceof Error ? caughtError.message : String(caughtError);
    } finally {
      if (requestId === searchRequestId) {
        searchLoading = false;
      }
    }
  }

  function submitSearch(): void {
    searchForm.query = searchForm.query.trim();
    globalThis.history.pushState({}, "", searchPath(searchForm.query));
    void runSearch();
  }

  function restoreSearchFromLocation(): void {
    const searchQuery = searchQueryFromSearchParams(globalThis.location.search);
    searchForm.query = searchQuery ?? "";
    if (searchQuery !== undefined) {
      void runSearch();
      return;
    }

    searchRequestId += 1;
    searchResults = [];
    searchLoading = false;
    searchNotice = "";
    hasSearched = false;
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
        subject: jobForm.subject,
        depth: jobForm.depth,
        horizonTradingDays: Number(jobForm.horizonTradingDays),
      });
      await refreshJobs();
    } catch (caughtError: unknown) {
      error = caughtError instanceof Error ? caughtError.message : String(caughtError);
    }
  }

  async function queueDeepEquityRun(symbol: string): Promise<void> {
    if (queueingDeepSymbols.has(symbol)) {
      return;
    }
    queueingDeepSymbols.add(symbol);
    error = "";
    try {
      await createJob({ jobType: "equity", assetClass: "equity", symbol, depth: "deep" });
      await refreshJobs();
    } catch (caughtError: unknown) {
      error = caughtError instanceof Error ? caughtError.message : String(caughtError);
    } finally {
      queueingDeepSymbols.delete(symbol);
    }
  }

  async function refreshProfile(symbol: string): Promise<void> {
    error = "";
    try {
      const profile = await refreshInstrumentProfile(symbol);
      if (instrumentDetail !== null && selectedInstrument?.symbol === symbol) {
        instrumentDetail = { ...instrumentDetail, profile };
      }
    } catch (caughtError: unknown) {
      error = caughtError instanceof Error ? caughtError.message : String(caughtError);
    }
  }

  async function loadWatchlists(): Promise<void> {
    try {
      const next = await fetchWatchlists();
      watchlistLoadError = "";
      watchlists = next;
      const nextId =
        selectedWatchlistId !== null && next.some((list) => list.id === selectedWatchlistId)
          ? selectedWatchlistId
          : (next[0]?.id ?? null);
      if (nextId === null) {
        selectedWatchlistId = null;
        watchlistDetail = null;
        return;
      }
      if (nextId !== selectedWatchlistId) {
        selectedWatchlistId = nextId;
        watchlistDetail = null;
      }
      await loadWatchlistDetail(nextId);
    } catch (caughtError: unknown) {
      watchlistLoadError = caughtError instanceof Error ? caughtError.message : String(caughtError);
      watchlists = [];
      selectedWatchlistId = null;
      watchlistDetail = null;
    }
  }

  async function loadWatchlistDetail(id: number): Promise<void> {
    loadingWatchlist = true;
    try {
      const next = await fetchWatchlistDetail(id);
      if (selectedWatchlistId === id) {
        watchlistDetail = next;
      }
    } catch (caughtError: unknown) {
      if (selectedWatchlistId === id) {
        error = caughtError instanceof Error ? caughtError.message : String(caughtError);
      }
    } finally {
      if (selectedWatchlistId === id) {
        loadingWatchlist = false;
      }
    }
  }

  function selectWatchlist(id: number): void {
    if (selectedWatchlistId === id && watchlistDetail?.id === id) {
      return;
    }
    selectedWatchlistId = id;
    watchlistDetail = null;
    void loadWatchlistDetail(id);
  }

  async function createWatchlistHandler(name: string): Promise<void> {
    error = "";
    try {
      const created = await createWatchlist(name);
      await loadWatchlists();
      selectWatchlist(created.id);
    } catch (caughtError: unknown) {
      error = caughtError instanceof Error ? caughtError.message : String(caughtError);
    }
  }

  async function renameWatchlistHandler(id: number, name: string): Promise<void> {
    error = "";
    try {
      const renamed = await renameWatchlist(id, name);
      watchlists = watchlists.map((list) => (list.id === id ? { ...list, name: renamed.name } : list));
      if (watchlistDetail !== null && watchlistDetail.id === id) {
        watchlistDetail = { ...watchlistDetail, name: renamed.name };
      }
    } catch (caughtError: unknown) {
      error = caughtError instanceof Error ? caughtError.message : String(caughtError);
    }
  }

  async function deleteWatchlistHandler(id: number): Promise<void> {
    if (
      !globalThis.confirm(
        "Delete this watchlist? The list and its symbols are removed from the Console DB.",
      )
    ) {
      return;
    }
    error = "";
    try {
      await deleteWatchlist(id);
      await loadWatchlists();
    } catch (caughtError: unknown) {
      error = caughtError instanceof Error ? caughtError.message : String(caughtError);
    }
  }

  async function addWatchlistItemHandler(symbol: string): Promise<void> {
    if (selectedWatchlistId === null) {
      return;
    }
    error = "";
    try {
      await addWatchlistItem(selectedWatchlistId, symbol);
      await loadWatchlistDetail(selectedWatchlistId);
    } catch (caughtError: unknown) {
      error = caughtError instanceof Error ? caughtError.message : String(caughtError);
    }
  }

  async function refreshPins(): Promise<void> {
    pins = await fetchPins();
    pinsLoadError = "";
  }

  async function togglePin(runId: string): Promise<void> {
    const intent = pinToggleIntent(pins, pinRequestInFlight, runId);
    if (intent === null) {
      return;
    }
    error = "";
    pinRequestInFlight = true;
    try {
      await (intent === "unpin" ? removePin(runId) : addPin(runId));
      await refreshPins();
    } catch (caughtError: unknown) {
      error = caughtError instanceof Error ? caughtError.message : String(caughtError);
    } finally {
      pinRequestInFlight = false;
    }
  }

  async function refreshAfterMembershipChange(id: number): Promise<void> {
    if (!watchlists.some((list) => list.id === id)) {
      await loadWatchlists();
    } else if (id === selectedWatchlistId) {
      await loadWatchlistDetail(id);
    }
  }

  async function removeWatchlistItemHandler(symbol: string): Promise<void> {
    if (selectedWatchlistId === null) {
      return;
    }
    error = "";
    try {
      await removeWatchlistItem(selectedWatchlistId, symbol);
      await loadWatchlistDetail(selectedWatchlistId);
    } catch (caughtError: unknown) {
      error = caughtError instanceof Error ? caughtError.message : String(caughtError);
    }
  }

  async function moveWatchlistItem(index: number, direction: -1 | 1): Promise<void> {
    // Each move derives the full order from watchlistDetail, so overlapping moves would undo each other.
    if (reorderingWatchlist || selectedWatchlistId === null || watchlistDetail === null) {
      return;
    }
    const target = index + direction;
    if (target < 0 || target >= watchlistDetail.items.length) {
      return;
    }
    const items = [...watchlistDetail.items];
    const moved = items[index];
    const displaced = items[target];
    if (moved === undefined || displaced === undefined) {
      return;
    }
    items[index] = displaced;
    items[target] = moved;
    error = "";
    reorderingWatchlist = true;
    try {
      await reorderWatchlist(
        selectedWatchlistId,
        items.map(({ assetClass, symbol }) => ({ assetClass, symbol })),
      );
      await loadWatchlistDetail(selectedWatchlistId);
    } catch (caughtError: unknown) {
      error = caughtError instanceof Error ? caughtError.message : String(caughtError);
    } finally {
      reorderingWatchlist = false;
    }
  }

  function updateSearchForm(field: SearchFormField, value: string): void {
    searchForm[field] = value;
  }

  function updateJobForm(field: JobFormField, value: string): void {
    jobForm[field] = value;
    if (field === "jobType" && value !== "research") {
      jobForm.subject = "";
    }
    if (field === "jobType" && value !== "equity" && value !== "crypto") {
      jobForm.symbol = "";
    }
  }

  onMount(() => {
    const interval = setInterval(() => {
      if (view === "jobs" || activeJobCount > 0) {
        void refreshJobs().catch(() => {});
      }
    }, JOBS_POLL_INTERVAL_MS);
    globalThis.addEventListener("popstate", handlePopState);
    globalThis.addEventListener("keydown", handleRunKeyNav);

    // Pins load apart from the bootstrap so a console-DB failure never blocks the rest.
    void refreshPins().catch((caughtError: unknown) => {
      pinsLoadError = caughtError instanceof Error ? caughtError.message : String(caughtError);
    });
    void (async () => {
      try {
        const initialRunId = runIdFromPathname(globalThis.location.pathname);
        const initialInstrument = instrumentFromPathname(globalThis.location.pathname);
        const initialSidebarView = sidebarViewFromPathname(globalThis.location.pathname);
        const [
          nextRuns,
          nextProviderHealth,
          nextCalibration,
          nextAlphaCohorts,
          nextJobs,
        ] = await Promise.all([
          fetchRuns(),
          fetchProviderHealth(),
          fetchCalibration(),
          fetchAlphaCohorts(),
          fetchJobs(),
        ]);
        runs = nextRuns;
        providerHealth = nextProviderHealth;
        calibration = nextCalibration;
        alphaCohorts = nextAlphaCohorts;
        jobs = nextJobs;
        // Watchlists load separately so a console-DB failure never blocks the rest.
        void loadWatchlists();
        if (initialRunId !== undefined) {
          await selectRun(initialRunId);
        } else if (initialInstrument !== undefined) {
          await selectInstrument(initialInstrument.assetClass, initialInstrument.symbol);
        } else {
          selectSidebarView(initialSidebarView ?? "dashboard");
          if (initialSidebarView === "search") {
            restoreSearchFromLocation();
          }
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
    bind:mobileOpen={menuOpen}
    rows={visibleRunHistoryRows}
    pinned={pinnedEntries}
    {pinsLoadError}
    {runTypes}
    {selectedRunId}
    {loadingRuns}
    {view}
    {activeJobCount}
    queryText={query.text}
    {typeFilter}
    expandedGroups={expandedRunHistoryGroups}
    onQueryChange={(value) => (query.text = value)}
    onTypeFilterChange={(value) => (typeFilter = value)}
    onSelectRun={(runId) => void openRun(runId)}
    onToggleGroup={toggleRunHistoryGroup}
    onNavigate={navigate}
    onUnpin={(runId) => void togglePin(runId)}
  />

  <main class="min-w-0 flex-1 {view === 'run' ? '' : 'pt-12 lg:pt-0'}">
    <div class="mx-auto max-w-330 px-4 py-6 lg:px-6 lg:py-7">
      {#if error !== ""}
        <div class="mb-4 flex items-start gap-3 rounded-lg border border-[#d9c89a] bg-[#fbf6ea] px-4 py-3">
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
          {compareCards}
          {pinnedRunIds}
          {loadingRuns}
          onOpenRun={(runId) => void openRun(runId)}
          onOpenInstrument={(assetClass, symbol) => void openInstrument(assetClass, symbol)}
        />
      {:else if view === "run"}
        <RunWorkspace
          {activeTab}
          reportDetail={appSettings.reportDetail}
          showSources={appSettings.showSources}
          {detail}
          {loadingDetail}
          {runs}
          {selectedFile}
          {fileContent}
          {highlightSourceId}
          {pinnedRunIds}
          pinned={detail !== null && pinnedRunIds.has(detail.summary.runId)}
          onOpenMenu={() => (menuOpen = true)}
          onOpenRun={(runId) => void openRun(runId)}
          onTabChange={(tab) => (activeTab = tab)}
          onReportDetailChange={setReportDetail}
          onShowSourcesChange={setShowSources}
          onLoadFile={(path) => void loadFile(path)}
          onGoHome={() => navigate("dashboard")}
          onHighlightSource={(sourceId) => (highlightSourceId = sourceId)}
          onOpenInstrument={(assetClass, symbol) => void openInstrument(assetClass, symbol)}
          pinToggleDisabled={pins === null || pinRequestInFlight}
          onTogglePin={() => void togglePin(selectedRunId)}
        />
      {:else if view === "instrument"}
        <InstrumentTimeline
          detail={instrumentDetail}
          loading={loadingInstrument}
          {runs}
          {pinnedRunIds}
          {jobs}
          {watchlists}
          {watchlistLoadError}
          onWatchlistChanged={(id) => void refreshAfterMembershipChange(id)}
          onOpenWatchlists={() => navigate("watchlists")}
          onOpenRun={(runId) => void openRun(runId)}
          onGoHome={() => navigate("dashboard")}
          onQueueDeepEquity={(symbol) => void queueDeepEquityRun(symbol)}
          onRefreshProfile={(symbol) => void refreshProfile(symbol)}
          onOpenInstrument={(assetClass, symbol) => void openInstrument(assetClass, symbol)}
        />
      {:else if view === "search"}
        <SearchView
          searchResults={pinnedSearchResults}
          {pinnedRunIds}
          {searchLoading}
          {searchNotice}
          {searchForm}
          {hasSearched}
          onRunSearch={submitSearch}
          onOpenSearchResult={(result) => void openSearchResult(result)}
          onSearchFormChange={updateSearchForm}
        />
      {:else if view === "jobs"}
        <JobsView {jobs} {jobForm} onJobFormChange={updateJobForm} onSubmitJob={() => void submitJob()} />
      {:else if view === "watchlists"}
        <WatchlistsView
          lists={watchlists}
          selectedId={selectedWatchlistId}
          detail={watchlistDetail}
          loading={loadingWatchlist}
          loadError={watchlistLoadError}
          {jobs}
          staleAfterDays={appSettings.staleAfterDays}
          onStaleAfterDaysChange={setStaleAfterDays}
          onSelectList={selectWatchlist}
          onCreate={(name) => void createWatchlistHandler(name)}
          onRename={(id, name) => void renameWatchlistHandler(id, name)}
          onDelete={(id) => void deleteWatchlistHandler(id)}
          onAddItem={(symbol) => void addWatchlistItemHandler(symbol)}
          onRemoveItem={(symbol) => void removeWatchlistItemHandler(symbol)}
          onMoveItem={(index, direction) => void moveWatchlistItem(index, direction)}
          onQueueDeepEquity={(symbol) => void queueDeepEquityRun(symbol)}
          onOpenInstrument={(assetClass, symbol) => void openInstrument(assetClass, symbol)}
        />
      {:else if view === "calibration"}
        <CalibrationView {calibration} onNavigate={navigate} />
      {:else if view === "alpha-cohorts"}
        <AlphaCohortsView detail={alphaCohorts} onNavigate={navigate} />
      {:else}
        <HealthView {providerHealth} />
      {/if}
    </div>
  </main>
</div>
