<script lang="ts">
  import {
    Briefcase,
    Database,
    ExternalLink,
    FileText,
    HeartPulse,
    Play,
    Search,
    ShieldCheck,
  } from "@lucide/svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { Input } from "$lib/components/ui/input";
  import * as Table from "$lib/components/ui/table";
  import * as Tabs from "$lib/components/ui/tabs";
  import { ASSET_CLASS_OPTIONS, CONSOLE_JOB_TYPES, DEPTH_OPTIONS, SEARCH_JOB_TYPE_OPTIONS, jobSupportsAsset, jobSupportsDepth } from "../../../src/cli/job-registry";
  import type { ConsoleJob, ProviderHealthDetail, RunDetail, RunSearchResult } from "../../types";
  import {
    formatDate,
    groupedSearchResults,
    jsonBlock,
    predictions,
    runLabel,
    scenarios,
    sources,
    stringArray,
    textItems,
  } from "../view-model";
  import { TABS, type JobFormField, type JobFormState, type SearchFormField, type SearchFormState, type Tab } from "./console-types";
  import RawBlock from "./raw-block.svelte";
  import SelectField from "./select-field.svelte";

  const SECTION_KEYS = [
    ["keyFindings", "Key findings"],
    ["bullCase", "Bull case"],
    ["bearCase", "Bear case"],
    ["risks", "Risks"],
    ["catalysts", "Catalysts"],
  ] as const;

  interface Props {
    readonly activeTab: Tab;
    readonly detail: RunDetail | null;
    readonly loadingDetail: boolean;
    readonly selectedFile: string;
    readonly fileContent: string;
    readonly providerHealth: ProviderHealthDetail;
    readonly jobs: readonly ConsoleJob[];
    readonly searchResults: readonly RunSearchResult[];
    readonly searchLoading: boolean;
    readonly searchNotice: string;
    readonly searchForm: SearchFormState;
    readonly jobForm: JobFormState;
    readonly onTabChange: (tab: Tab) => void;
    readonly onLoadFile: (path: string) => void;
    readonly onRunSearch: () => void;
    readonly onOpenSearchResult: (result: RunSearchResult) => void;
    readonly onSearchFormChange: (field: SearchFormField, value: string) => void;
    readonly onJobFormChange: (field: JobFormField, value: string) => void;
    readonly onSubmitJob: () => void;
  }

  let {
    activeTab,
    detail,
    loadingDetail,
    selectedFile,
    fileContent,
    providerHealth,
    jobs,
    searchResults,
    searchLoading,
    searchNotice,
    searchForm,
    jobForm,
    onTabChange,
    onLoadFile,
    onRunSearch,
    onOpenSearchResult,
    onSearchFormChange,
    onJobFormChange,
    onSubmitJob,
  }: Props = $props();

  const report = $derived(detail?.report);
  const reportSummary = $derived(
    typeof report?.summary === "string" ? report.summary : "No summary is available.",
  );
  const scenarioItems = $derived(scenarios(report));
  const forecastItems = $derived(predictions(report));
  const sourceItems = $derived(sources(report));
  const gaps = $derived(stringArray(report, "dataGaps"));
  const searchGroups = $derived(groupedSearchResults(searchResults));

  const tabIcons = {
    report: FileText,
    sources: Database,
    analytics: ShieldCheck,
    trace: FileText,
    files: FileText,
    score: ShieldCheck,
    search: Search,
    health: HeartPulse,
    jobs: Briefcase,
  };
</script>

{#if loadingDetail}
  <Card.Card class="border-cyan-900/10 bg-card/90 p-8 text-center text-sm text-muted-foreground">
    Loading selected run...
  </Card.Card>
{:else if detail === null}
  <Card.Card class="border-cyan-900/10 bg-card/90 p-8 text-center text-sm text-muted-foreground">
    Select a run to inspect the research artifact.
  </Card.Card>
{:else}
  <section class="space-y-3" aria-live="polite">
    <Card.Card class="border-cyan-900/10 bg-card/90 shadow-sm">
      <Card.CardHeader class="gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div class="min-w-0">
          <Card.CardDescription class="truncate">{detail.summary.runId}</Card.CardDescription>
          <Card.CardTitle class="text-xl">{runLabel(detail.summary)}</Card.CardTitle>
          <p class="mt-1 text-sm text-muted-foreground">{formatDate(detail.summary.generatedAt)}</p>
        </div>
        <div class="grid grid-cols-3 gap-2 text-center">
          <div class="rounded-md border bg-cyan-50/60 px-3 py-2">
            <div class="text-xs text-muted-foreground">Confidence</div>
            <div class="text-sm font-semibold">{detail.summary.confidence ?? "unknown"}</div>
          </div>
          <div class="rounded-md border bg-cyan-50/60 px-3 py-2">
            <div class="text-xs text-muted-foreground">Sources</div>
            <div class="text-sm font-semibold">{detail.summary.sourceCount}</div>
          </div>
          <div class="rounded-md border bg-cyan-50/60 px-3 py-2">
            <div class="text-xs text-muted-foreground">Files</div>
            <div class="text-sm font-semibold">{detail.summary.availableFiles.length}</div>
          </div>
        </div>
      </Card.CardHeader>
    </Card.Card>

    <Tabs.Tabs value={activeTab}>
      <Tabs.TabsList class="w-full flex-wrap justify-start bg-cyan-50/60">
        {#each TABS as tab}
          {@const Icon = tabIcons[tab]}
          <Tabs.TabsTrigger value={tab} onclick={() => onTabChange(tab)} class="capitalize">
            <Icon class="size-3.5" />
            {tab}
          </Tabs.TabsTrigger>
        {/each}
      </Tabs.TabsList>

      <Tabs.TabsContent value="report">
        <article class="grid gap-3 xl:grid-cols-[1.2fr_0.8fr]">
          <Card.Card class="border-cyan-900/10 bg-card/90 xl:col-span-2">
            <Card.CardHeader>
              <Card.CardTitle>Summary</Card.CardTitle>
            </Card.CardHeader>
            <Card.CardContent>
              <p class="leading-7 text-foreground/85">{reportSummary}</p>
            </Card.CardContent>
          </Card.Card>

          {#each SECTION_KEYS as [key, label]}
            {@const items = textItems(report, key)}
            {#if items.length > 0}
              <Card.Card class="border-cyan-900/10 bg-card/90">
                <Card.CardHeader>
                  <Card.CardTitle>{label}</Card.CardTitle>
                </Card.CardHeader>
                <Card.CardContent>
                  <ul class="space-y-3">
                    {#each items as item}
                      <li class="border-l-2 border-cyan-600/40 pl-3">
                        <span class="block text-sm">{item.text}</span>
                        {#if item.sourceIds.length > 0}
                          <span class="mt-1 block text-xs text-muted-foreground">{item.sourceIds.join(", ")}</span>
                        {/if}
                      </li>
                    {/each}
                  </ul>
                </Card.CardContent>
              </Card.Card>
            {/if}
          {/each}

          {#if scenarioItems.length > 0}
            <Card.Card class="border-cyan-900/10 bg-card/90">
              <Card.CardHeader>
                <Card.CardTitle>Scenarios</Card.CardTitle>
              </Card.CardHeader>
              <Card.CardContent class="space-y-3">
                {#each scenarioItems as scenario}
                  <div class="rounded-md border bg-cyan-50/50 p-3">
                    <strong>{scenario.name}</strong>
                    <p class="mt-1 text-sm text-muted-foreground">{scenario.description}</p>
                    {#if scenario.sourceIds.length > 0}
                      <span class="mt-2 block text-xs text-muted-foreground">{scenario.sourceIds.join(", ")}</span>
                    {/if}
                  </div>
                {/each}
              </Card.CardContent>
            </Card.Card>
          {/if}

          {#if forecastItems.length > 0}
            <Card.Card class="border-cyan-900/10 bg-card/90">
              <Card.CardHeader>
                <Card.CardTitle>Observable Forecasts</Card.CardTitle>
              </Card.CardHeader>
              <Card.CardContent class="space-y-3">
                {#each forecastItems as prediction}
                  <div class="rounded-md border bg-cyan-50/50 p-3">
                    <strong class="text-sm">{prediction.claim}</strong>
                    <p class="mt-1 text-xs text-muted-foreground">
                      {prediction.kind ?? "forecast"}
                      {#if prediction.probability !== undefined}
                        / {Math.round(prediction.probability * 100)}%
                      {/if}
                      {#if prediction.horizonTradingDays !== undefined}
                        / {prediction.horizonTradingDays} trading days
                      {/if}
                    </p>
                    {#if prediction.sourceIds.length > 0}
                      <span class="mt-2 block text-xs text-muted-foreground">{prediction.sourceIds.join(", ")}</span>
                    {/if}
                  </div>
                {/each}
              </Card.CardContent>
            </Card.Card>
          {/if}

          {#if gaps.length > 0}
            <Card.Card class="border-cyan-900/10 bg-card/90">
              <Card.CardHeader>
                <Card.CardTitle>Data Gaps</Card.CardTitle>
              </Card.CardHeader>
              <Card.CardContent>
                <ul class="space-y-2">
                  {#each gaps as gap}
                    <li class="text-sm text-muted-foreground">{gap}</li>
                  {/each}
                </ul>
              </Card.CardContent>
            </Card.Card>
          {/if}

          {#if detail.markdown !== undefined}
            <Card.Card class="border-cyan-900/10 bg-card/90 xl:col-span-2">
              <Card.CardHeader>
                <Card.CardTitle>Markdown Fallback</Card.CardTitle>
              </Card.CardHeader>
              <Card.CardContent>
                <pre class="max-h-[520px] overflow-auto rounded-md bg-slate-950 p-4 text-xs text-cyan-50">{detail.markdown}</pre>
              </Card.CardContent>
            </Card.Card>
          {/if}
        </article>
      </Tabs.TabsContent>

      <Tabs.TabsContent value="sources">
        <Card.Card class="border-cyan-900/10 bg-card/90">
          <Card.CardHeader>
            <Card.CardTitle>Sources</Card.CardTitle>
            <Card.CardDescription>Normalized source metadata from the selected run.</Card.CardDescription>
          </Card.CardHeader>
          <Card.CardContent>
            <div class="overflow-x-auto">
              <Table.Table>
                <Table.TableHeader>
                  <Table.TableRow>
                    <Table.TableHead>ID</Table.TableHead>
                    <Table.TableHead>Title</Table.TableHead>
                    <Table.TableHead>Kind</Table.TableHead>
                    <Table.TableHead>Provider</Table.TableHead>
                    <Table.TableHead>Link</Table.TableHead>
                  </Table.TableRow>
                </Table.TableHeader>
                <Table.TableBody>
                  {#each sourceItems as source}
                    <Table.TableRow>
                      <Table.TableCell class="font-mono text-xs">{source.id}</Table.TableCell>
                      <Table.TableCell>{source.title}</Table.TableCell>
                      <Table.TableCell>{source.kind ?? "source"}</Table.TableCell>
                      <Table.TableCell>{source.provider ?? ""}</Table.TableCell>
                      <Table.TableCell>
                        {#if source.url !== undefined}
                          <a class="inline-flex items-center gap-1 text-cyan-700 hover:underline" href={source.url} target="_blank" rel="noreferrer">
                            Open
                            <ExternalLink class="size-3" />
                          </a>
                        {/if}
                      </Table.TableCell>
                    </Table.TableRow>
                  {/each}
                </Table.TableBody>
              </Table.Table>
            </div>
          </Card.CardContent>
        </Card.Card>
      </Tabs.TabsContent>

      <Tabs.TabsContent value="analytics">
        <RawBlock title="Analytics" value={jsonBlock(detail.analytics)} />
      </Tabs.TabsContent>

      <Tabs.TabsContent value="trace">
        <RawBlock title="Trace / Logs" value={jsonBlock(detail.trace)} />
      </Tabs.TabsContent>

      <Tabs.TabsContent value="files">
        <Card.Card class="border-cyan-900/10 bg-card/90">
          <Card.CardHeader>
            <Card.CardTitle>Files</Card.CardTitle>
          </Card.CardHeader>
          <Card.CardContent>
            <div class="grid gap-3 lg:grid-cols-[280px_1fr]">
              <div class="space-y-2">
                {#each detail.summary.availableFiles as file}
                  <Button
                    variant={selectedFile === file ? "secondary" : "outline"}
                    class="w-full justify-start"
                    type="button"
                    onclick={() => onLoadFile(file)}
                  >
                    {file}
                  </Button>
                {/each}
              </div>
              <pre class="min-h-[360px] overflow-auto rounded-md bg-slate-950 p-4 text-xs text-cyan-50">{fileContent === "" ? "Select a file." : fileContent}</pre>
            </div>
          </Card.CardContent>
        </Card.Card>
      </Tabs.TabsContent>

      <Tabs.TabsContent value="score">
        <RawBlock title="Score" value={jsonBlock(detail.score)} />
      </Tabs.TabsContent>

      <Tabs.TabsContent value="search">
        <Card.Card class="border-cyan-900/10 bg-card/90">
          <Card.CardHeader>
            <Card.CardTitle>Search</Card.CardTitle>
            <Card.CardDescription>Search structured report sections across stored runs.</Card.CardDescription>
          </Card.CardHeader>
          <Card.CardContent class="space-y-4">
            <form
              class="grid gap-3 md:grid-cols-6"
              onsubmit={(event) => {
                event.preventDefault();
                onRunSearch();
              }}
            >
              <label class="space-y-1 md:col-span-2">
                <span class="text-xs font-medium text-muted-foreground">Query</span>
                <Input
                  value={searchForm.query}
                  placeholder="source, forecast, gap"
                  oninput={(event) => onSearchFormChange("query", event.currentTarget.value)}
                />
              </label>
              <label class="space-y-1">
                <span class="text-xs font-medium text-muted-foreground">Symbol</span>
                <Input
                  value={searchForm.symbol}
                  placeholder="AAPL"
                  oninput={(event) => onSearchFormChange("symbol", event.currentTarget.value)}
                />
              </label>
              <SelectField label="Asset" value={searchForm.assetClass} options={["", ...ASSET_CLASS_OPTIONS]} onChange={(value) => onSearchFormChange("assetClass", value)} />
              <SelectField label="Job" value={searchForm.jobType} options={SEARCH_JOB_TYPE_OPTIONS} onChange={(value) => onSearchFormChange("jobType", value)} />
              <Button class="mt-5" type="submit">
                <Search class="size-4" />
                Search
              </Button>
              <label class="space-y-1">
                <span class="text-xs font-medium text-muted-foreground">From</span>
                <Input type="date" value={searchForm.from} oninput={(event) => onSearchFormChange("from", event.currentTarget.value)} />
              </label>
              <label class="space-y-1">
                <span class="text-xs font-medium text-muted-foreground">To</span>
                <Input type="date" value={searchForm.to} oninput={(event) => onSearchFormChange("to", event.currentTarget.value)} />
              </label>
            </form>

            {#if searchLoading}
              <p class="text-sm text-muted-foreground">Searching reports...</p>
            {:else if searchNotice !== ""}
              <p class="text-sm text-muted-foreground">{searchNotice}</p>
            {:else if searchGroups.length > 0}
              <div class="space-y-3">
                {#each searchGroups as group}
                  <div class="rounded-md border bg-cyan-50/50 p-3">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <strong>{runLabel(group.run)}</strong>
                      <span class="text-xs text-muted-foreground">{formatDate(group.run.generatedAt)}</span>
                    </div>
                    <div class="mt-3 space-y-2">
                      {#each group.results as result}
                        <button class="w-full rounded-md border bg-background p-3 text-left transition hover:border-cyan-500/50 hover:bg-cyan-50" type="button" onclick={() => onOpenSearchResult(result)}>
                          <span class="text-sm font-medium">{result.label}</span>
                          <Badge variant="outline" class="ml-2">{result.section}</Badge>
                          <p class="mt-1 text-sm text-muted-foreground">{result.snippet}</p>
                          {#if result.sourceIds.length > 0}
                            <span class="mt-2 block text-xs text-muted-foreground">{result.sourceIds.join(", ")}</span>
                          {/if}
                        </button>
                      {/each}
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </Card.CardContent>
        </Card.Card>
      </Tabs.TabsContent>

      <Tabs.TabsContent value="health">
        <Card.Card class="border-cyan-900/10 bg-card/90">
          <Card.CardHeader>
            <Card.CardTitle>Provider Health</Card.CardTitle>
          </Card.CardHeader>
          <Card.CardContent class="space-y-3">
            <pre class="overflow-auto rounded-md bg-slate-950 p-4 text-xs text-cyan-50">{jsonBlock(providerHealth.summary)}</pre>
            {#if providerHealth.markdown !== undefined}
              <pre class="overflow-auto rounded-md bg-slate-950 p-4 text-xs text-cyan-50">{providerHealth.markdown}</pre>
            {/if}
          </Card.CardContent>
        </Card.Card>
      </Tabs.TabsContent>

      <Tabs.TabsContent value="jobs">
        <Card.Card class="border-cyan-900/10 bg-card/90">
          <Card.CardHeader>
            <Card.CardTitle>Jobs</Card.CardTitle>
            <Card.CardDescription>Queue local research-console jobs without changing API contracts.</Card.CardDescription>
          </Card.CardHeader>
          <Card.CardContent class="space-y-4">
            <form
              class="grid gap-3 md:grid-cols-5"
              onsubmit={(event) => {
                event.preventDefault();
                onSubmitJob();
              }}
            >
              <SelectField label="Job" value={jobForm.jobType} options={CONSOLE_JOB_TYPES} onChange={(value) => onJobFormChange("jobType", value)} />
              {#if jobSupportsAsset(jobForm.jobType)}
                <SelectField label="Asset" value={jobForm.assetClass} options={ASSET_CLASS_OPTIONS} onChange={(value) => onJobFormChange("assetClass", value)} />
              {/if}
              {#if jobForm.jobType === "ticker"}
                <label class="space-y-1">
                  <span class="text-xs font-medium text-muted-foreground">Symbol</span>
                  <Input value={jobForm.symbol} placeholder="AAPL" oninput={(event) => onJobFormChange("symbol", event.currentTarget.value)} />
                </label>
              {/if}
              {#if jobSupportsDepth(jobForm.jobType)}
                <SelectField label="Depth" value={jobForm.depth} options={DEPTH_OPTIONS} onChange={(value) => onJobFormChange("depth", value)} />
              {/if}
              <Button class="mt-5" type="submit">
                <Play class="size-4" />
                Queue job
              </Button>
            </form>

            {#if jobs.length === 0}
              <p class="text-sm text-muted-foreground">No jobs queued yet.</p>
            {:else}
              <div class="overflow-x-auto">
                <Table.Table>
                  <Table.TableHeader>
                    <Table.TableRow>
                      <Table.TableHead>Job</Table.TableHead>
                      <Table.TableHead>Status</Table.TableHead>
                      <Table.TableHead>Created</Table.TableHead>
                      <Table.TableHead>Output</Table.TableHead>
                    </Table.TableRow>
                  </Table.TableHeader>
                  <Table.TableBody>
                    {#each jobs as job}
                      <Table.TableRow>
                        <Table.TableCell class="font-medium">{job.label}</Table.TableCell>
                        <Table.TableCell>
                          <Badge variant={job.status === "running" ? "default" : "outline"}>{job.status}</Badge>
                        </Table.TableCell>
                        <Table.TableCell>{formatDate(job.createdAt)}</Table.TableCell>
                        <Table.TableCell class="max-w-[420px]">
                          {#if job.outputRunPath !== undefined}
                            <span class="block truncate text-xs">{job.outputRunPath}</span>
                          {/if}
                          {#if job.stdout !== "" || job.stderr !== ""}
                            <pre class="mt-2 max-h-28 overflow-auto rounded bg-slate-950 p-2 text-xs text-cyan-50">{job.stdout}{job.stderr}</pre>
                          {/if}
                        </Table.TableCell>
                      </Table.TableRow>
                    {/each}
                  </Table.TableBody>
                </Table.Table>
              </div>
            {/if}
          </Card.CardContent>
        </Card.Card>
      </Tabs.TabsContent>
    </Tabs.Tabs>
  </section>
{/if}
